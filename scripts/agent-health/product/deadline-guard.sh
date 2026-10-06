#!/bin/bash
#
# CommandMate - the deadline guard of the product-path check (Issue #3312).
# Runs after the supervisor's deadline (launchd at 07:52, as the dedicated
# user; set up in a later step), whether the supervisor is alive or not.
#
#   CM_PRODUCT_RUN_DIR=<base> bash scripts/agent-health/product/deadline-guard.sh
#
# For every ledger of the day (CM_PRODUCT_DATE, default today) that is not
# closed:
#
#   1. a supervisor still alive after CM_PRODUCT_FINAL_AT (07:50) is stopped —
#      the pid and start time in the ledger must both match; before the
#      deadline the guard leaves a live supervisor alone and exits 75
#   2. its resources are reclaimed with the same per-resource identity checks
#      as the supervisor (lib.sh); what does not match is left `unknown`
#   3. the result is finalized with `reclaim.by = deadline-guard` and published,
#      so the day's result says the guard, not the supervisor, finished it
#
# A day whose ledgers are all closed is left as it is (exit 0, nothing written).
#
# Exit: 0 nothing to do or everything reclaimed and published, 1 something
# left unknown or not published, 2 bad settings, 75 the supervisor is alive
# and still within its deadline.
#
# bash 3.2 compatible (macOS /bin/bash).

set -u

PRODUCT_LOG_NAME=deadline-guard
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [ -z "${CM_PRODUCT_RUN_DIR:-}" ] || [ ! -d "$CM_PRODUCT_RUN_DIR" ]; then
    product_log "CM_PRODUCT_RUN_DIR is required and must exist"
    exit 2
fi
PRODUCT_BASE="$(cd -P "$CM_PRODUCT_RUN_DIR" && pwd)" || exit 2
FINAL_AT=$(product_deadline "${CM_PRODUCT_FINAL_AT:-07:50}") || exit 2
DATE="${CM_PRODUCT_DATE:-$(date +%Y-%m-%d)}"
export CM_UAT_SOCK_BASE="${CM_UAT_SOCK_BASE:-$PRODUCT_BASE/sock}"

rc=0
handled=0
for file in "$PRODUCT_BASE"/ledger/*.json; do
    [ -f "$file" ] || continue
    [ "$(ledger get "$file" date)" = "$DATE" ] || continue
    case "$(ledger get "$file" status)" in
        closed | reclaimed) continue ;;
    esac
    run_id=$(ledger get "$file" runId)
    sup_pid=$(ledger get "$file" supervisorPid)
    sup_lstart=$(ledger get "$file" supervisorLstart)

    if [ -n "$sup_pid" ] && proc_matches "$sup_pid" "$sup_lstart"; then
        if [ "$(product_now)" -lt "$FINAL_AT" ]; then
            product_log "run $run_id: its supervisor (pid $sup_pid) is alive and within its deadline: left alone"
            exit 75
        fi
        product_log "run $run_id: its supervisor (pid $sup_pid) is alive past the deadline: stopping it"
        if ! stop_and_wait "$sup_pid"; then
            product_log "run $run_id: the supervisor would not exit"
            rc=1
            continue
        fi
    fi

    handled=1
    product_log "run $run_id: reclaiming"
    reclaim_ledger "$file" || rc=1
    state="$PRODUCT_BASE/runs/$run_id/run.state"
    [ -f "$state" ] && product_state_set "$state" finished_at "$(product_now)"
    if product_finalize "$run_id" deadline-guard; then
        [ -z "$(ledger_unknown_ids "$file")" ] && ledger set "$file" status closed
    else
        product_log "run $run_id: the result could not be published"
        rc=1
    fi
done

# A lock its supervisor left when it died (or was stopped above). Taken the
# way the supervisor takes one: moved aside, and put back unless the moved one
# is still the one judged stale — a supervisor starting in between has made a
# fresh lock at that path, and it must not be removed.
lock="$PRODUCT_BASE/supervisor.lock"
if [ -d "$lock" ] && product_lock_is_stale "$lock"; then
    product_lock_take_stale "$lock"
fi

[ $handled -eq 0 ] && product_log "nothing to reclaim for $DATE"
exit $rc
