#!/bin/bash
#
# CommandMate - the supervisor of the product-path check (Issue #3312, stage 2
# of the daily agent-health check). Run as the dedicated OS user (`cmcheck`);
# launchd starts it at 07:15 (set up in a later step, not by this script).
#
#   CM_PRODUCT_RUN_DIR=<base> bash scripts/agent-health/product/supervisor.sh
#
# Order, always: EXCLUSIVE -> RECLAIM -> SAFETY -> RUN -> CLEANUP -> FINALIZE.
#
#   exclusive  <base>/supervisor.lock (its own lock, not scripts/uat/run-lock.sh's).
#              A second supervisor exits 75 and touches nothing.
#   reclaim    every earlier ledger not closed: its resources, each checked
#              against the ledger before it is stopped (lib.sh). Also on a
#              late start. A resource that does not match is left `unknown`,
#              and then nothing runs today.
#   safety     nothing left unknown, the port is not 3000 and is free, the
#              deadline has not passed. Then `up` (run-server.sh up
#              --own-home) and the isolation checks of
#              .commandmate/uat-own-home.yaml on the running server.
#   run        CM_PRODUCT_STAGE_CMD, in its own process group, stopped at the
#              deadline (exit 0 pass, 3 skip, anything else fail). The
#              scenarios themselves come in a later step.
#   cleanup    run-server.sh down, then this run's ledger reclaimed.
#   finalize   finalize.ts: the result, published atomically to
#              CM_PRODUCT_PUBLISH_DIR; the ledger is closed when nothing is left.
#
# Deadlines (HH:MM today, or @<epoch> for tests): CM_PRODUCT_LATE_START (07:25:
# after it nothing runs, the reclaim still does), CM_PRODUCT_STOP_AT (07:45: the
# runner is stopped and cleanup starts), CM_PRODUCT_FINAL_AT (07:50: the deadline
# guard, deadline-guard.sh, takes over a supervisor still alive after it).
#
# Every resource is written to the ledger as `planned` BEFORE it is made and
# as `acquired` right after (ledger.py), so whatever kills this script, the next
# supervisor or the deadline guard can find and stop what it left.
#
# Other settings: CM_PRODUCT_PORT (3029), CM_PRODUCT_DATE (today),
# CM_PRODUCT_SHA (git HEAD of this checkout), CM_UAT_SOCK_BASE
# (<base>/sock), CM_RUN_LOCK_DIR (<base>/run.lock), CM_PRODUCT_PUBLISH_DIR
# (/Users/Shared/commandmate-check). Test hooks: CM_UAT_SERVER_ENTRY (passed to
# run-server.sh), CM_PRODUCT_TEST_PAUSE_AT=<checkpoint>.
#
# Exit: 0 finalized (whatever the result), 1 finalize could not publish,
# 2 bad settings, 75 another supervisor holds the lock.
#
# bash 3.2 compatible (macOS /bin/bash).

set -u

PRODUCT_LOG_NAME=supervisor
# shellcheck source=scripts/agent-health/product/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [ -z "${CM_PRODUCT_RUN_DIR:-}" ]; then
    product_log "CM_PRODUCT_RUN_DIR is required"
    exit 2
fi
mkdir -p "$CM_PRODUCT_RUN_DIR" || exit 2
# Physical, so the paths the server opens are the ones lsof prints.
PRODUCT_BASE="$(cd -P "$CM_PRODUCT_RUN_DIR" && pwd)" || exit 2

LATE_AT=$(product_deadline "${CM_PRODUCT_LATE_START:-07:25}") || exit 2
STOP_AT=$(product_deadline "${CM_PRODUCT_STOP_AT:-07:45}") || exit 2
PORT="${CM_PRODUCT_PORT:-3029}"
case "$PORT" in
    '' | *[!0-9]*)
        product_log "CM_PRODUCT_PORT must be a number: $PORT"
        exit 2
        ;;
esac
DATE="${CM_PRODUCT_DATE:-$(date +%Y-%m-%d)}"
export CM_UAT_SOCK_BASE="${CM_UAT_SOCK_BASE:-$PRODUCT_BASE/sock}"
export CM_RUN_LOCK_DIR="${CM_RUN_LOCK_DIR:-$PRODUCT_BASE/run.lock}"
RUN_SERVER="$PRODUCT_REPO_ROOT/scripts/uat/run-server.sh"

# ------------------------------------------------------------ exclusive

if ! product_lock_acquire supervisor; then
    product_log "$PRODUCT_LOCK_ERROR"
    exit 75
fi
trap 'product_lock_release' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

RUN_ID="$(date +%y%m%d%H%M%S)-$(printf '%04x' $RANDOM)"
RUN_DIR="$PRODUCT_BASE/runs/$RUN_ID"
LEDGER="$PRODUCT_BASE/ledger/$RUN_ID.json"
STATE="$RUN_DIR/run.state"
# -m 700 is meant for these directories themselves, not for their parents:
# runs/ and ledger/ sit directly under the base made above, and the parents of
# the socket base are the caller's (normally the dedicated user's HOME).
# shellcheck disable=SC2174
mkdir -p -m 700 "$PRODUCT_BASE/runs" "$PRODUCT_BASE/ledger" "$CM_UAT_SOCK_BASE" || exit 2
mkdir -m 700 "$RUN_DIR" || exit 2

SHA="${CM_PRODUCT_SHA:-$(git -C "$PRODUCT_REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
product_state_set "$STATE" date "$DATE"
product_state_set "$STATE" run_id "$RUN_ID"
product_state_set "$STATE" sha "$SHA"
product_state_set "$STATE" started_at "$(product_now)"
product_state_set "$STATE" stages ""
ledger init "$LEDGER" "$RUN_ID" "$DATE" "$RUN_DIR" || exit 2
ledger set "$LEDGER" supervisorPid "$$"
ledger set "$LEDGER" supervisorLstart "$(proc_lstart $$)"
product_log "run $RUN_ID ($DATE), ledger $LEDGER"

STAGES=""
# stage <id> <status> [<reason>]
stage() {
    case " $STAGES " in
        *" $1 "*) ;;
        *)
            STAGES="${STAGES:+$STAGES }$1"
            product_state_set "$STATE" stages "$STAGES"
            ;;
    esac
    [ -n "${2:-}" ] || return 0
    product_state_set "$STATE" "stage_$1" "$2"
    product_state_set "$STATE" "stage_$1_reason" "${3:-}"
}

# ------------------------------------------------------------- reclaim

stage reclaim
product_checkpoint reclaim
RECLAIM_UNKNOWN=0
for old in "$PRODUCT_BASE"/ledger/*.json; do
    [ -f "$old" ] && [ "$old" != "$LEDGER" ] || continue
    case "$(ledger get "$old" status)" in
        closed | reclaimed) continue ;;
    esac
    old_id="$(ledger get "$old" runId)"
    product_log "reclaiming what run $old_id left"
    if reclaim_ledger "$old"; then
        ledger set "$old" status reclaimed
        ledger append "$LEDGER" reclaimedRuns "$old_id"
    else
        RECLAIM_UNKNOWN=1
        for id in $(ledger_unknown_ids "$old"); do
            ledger append "$LEDGER" unknownElsewhere "$old_id/$id"
        done
    fi
done
if [ $RECLAIM_UNKNOWN -eq 1 ]; then
    stage reclaim unknown "an earlier run left a resource that does not match its ledger"
else
    stage reclaim pass
fi

# ------------------------------------------------------------- safety

LATE=0
[ "$(product_now)" -gt "$LATE_AT" ] && LATE=1
product_state_set "$STATE" late_start "$LATE"

SERVER_UP=0
SAFE=1
if [ $LATE -eq 1 ]; then
    product_log "late start: nothing runs today (the reclaim above still did)"
    SAFE=0
elif [ $RECLAIM_UNKNOWN -eq 1 ]; then
    stage safety fail "a resource from an earlier run is left unknown"
    SAFE=0
elif [ "$PORT" = 3000 ]; then
    stage safety fail "port 3000 is production"
    SAFE=0
elif [ -n "$(find_listen_pids_by_port "$PORT" 2>/dev/null)" ]; then
    stage safety fail "port $PORT is already in use"
    SAFE=0
elif [ "$(product_now)" -ge "$STOP_AT" ]; then
    stage safety unknown "the deadline passed before the run"
    SAFE=0
else
    stage safety pass
fi

if [ $SAFE -eq 1 ]; then
    stage up
    ledger plan "$LEDGER" server server "db=$RUN_DIR/uat.db" "run_dir=$RUN_DIR"
    ledger plan "$LEDGER" tmux tmux "run_dir=$RUN_DIR"
    if bash "$RUN_SERVER" up --own-home --port "$PORT" --run-dir "$RUN_DIR" --wait-listen 60; then
        SERVER_UP=1
        product_checkpoint up
        server_pid=$(sed -n 's/^server_pid=//p' "$RUN_DIR/uat-run.state" | tail -n 1)
        sock_dir=$(sed -n 's/^sock_dir=//p' "$RUN_DIR/uat-run.state" | tail -n 1)
        ledger acquire "$LEDGER" server "pid=$server_pid" "lstart=$(proc_lstart "$server_pid")"
        ledger acquire "$LEDGER" tmux "sock=$sock_dir/tmux.sock" "uid=$(id -u)"
        stage up pass
    else
        stage up fail "run-server.sh up failed; see $RUN_DIR/server.log"
        SAFE=0
    fi
fi

if [ $SAFE -eq 1 ]; then
    stage isolation
    ISOLATION_FAILED=""
    CHECKS=$(cd "$PRODUCT_REPO_ROOT" && node -e '
        const fs = require("fs");
        const YAML = require("yaml");
        const [file, port, runDir] = process.argv.slice(1);
        for (const check of YAML.parse(fs.readFileSync(file, "utf8")).isolation.checks) {
          console.log(check.replaceAll("{port}", port).replaceAll("{run_dir}", runDir));
        }' "$PRODUCT_REPO_ROOT/.commandmate/uat-own-home.yaml" "$PORT" "$RUN_DIR") || ISOLATION_FAILED="the checks could not be read"
    n=0
    while IFS= read -r check; do
        [ -n "$check" ] || continue
        n=$((n + 1))
        if ! bash -c "$check" >/dev/null 2>&1; then
            ISOLATION_FAILED="${ISOLATION_FAILED:+$ISOLATION_FAILED, }check $n"
        fi
    done <<EOF
$CHECKS
EOF
    if [ -n "$ISOLATION_FAILED" ] || [ $n -eq 0 ]; then
        stage isolation fail "isolation check failed: ${ISOLATION_FAILED:-none ran}"
        SAFE=0
    else
        stage isolation pass
    fi
fi

# ----------------------------------------------------------------- run

if [ $SAFE -eq 1 ]; then
    stage run
    if [ -z "${CM_PRODUCT_STAGE_CMD:-}" ]; then
        stage run skip "no stage command (CM_PRODUCT_STAGE_CMD)"
    else
        marker="cmcheck-product-stage-$RUN_ID"
        ledger plan "$LEDGER" runner runner "marker=$marker"
        # Its own session and process group, so the deadline stops all of it.
        CM_PORT="$PORT" CM_UAT_ISOLATION=1 CM_PRODUCT_RUN_ID="$RUN_ID" CM_PRODUCT_RUN_PATH="$RUN_DIR" \
            python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
            bash -c "$CM_PRODUCT_STAGE_CMD" "$marker" </dev/null >"$RUN_DIR/stage.log" 2>&1 &
        runner=$!
        ledger acquire "$LEDGER" runner "pid=$runner" "lstart=$(proc_lstart "$runner")" "pgid=$runner"
        product_checkpoint run
        while proc_running "$runner" && [ "$(product_now)" -lt "$STOP_AT" ]; do
            sleep 0.2
        done
        if proc_running "$runner"; then
            product_log "the deadline: stopping the runner (group $runner)"
            stop_and_wait "$runner" "$runner"
            wait "$runner" 2>/dev/null
            stage run unknown "stopped at the deadline"
        else
            wait "$runner"
            rc=$?
            case "$rc" in
                0) stage run pass ;;
                3) stage run skip "the stage reported a known outside condition (exit 3)" ;;
                *) stage run fail "the stage exited $rc" ;;
            esac
        fi
        ledger mark "$LEDGER" runner released finished
    fi
fi

# ------------------------------------------------------------- cleanup

product_checkpoint cleanup
if [ $SERVER_UP -eq 1 ]; then
    stage down
    if bash "$RUN_SERVER" down --run-dir "$RUN_DIR"; then
        stage down pass
    else
        stage down fail "run-server.sh down failed"
    fi
fi
if ! reclaim_ledger "$LEDGER"; then
    product_log "this run's own resources could not all be reclaimed: $(ledger_unknown_ids "$LEDGER")"
fi

# ------------------------------------------------------------ finalize

product_state_set "$STATE" finished_at "$(product_now)"
if ! product_finalize "$RUN_ID" supervisor; then
    product_log "the result could not be published"
    exit 1
fi
[ -z "$(ledger_unknown_ids "$LEDGER")" ] && ledger set "$LEDGER" status closed
exit 0
