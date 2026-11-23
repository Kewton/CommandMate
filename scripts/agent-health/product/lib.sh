#!/bin/bash
#
# CommandMate - shared functions of the product-path check (Issue #3312,
# stage 2 of the daily agent-health check): the supervisor's own lock, the
# ledger, deadlines, and the verified reclaim. Sourced by supervisor.sh and
# deadline-guard.sh; nothing runs on source.
#
# Reclaim stops a resource only after checking it is the one the ledger
# recorded, resource by resource:
#
#   server  pid, its start time (`ps -o lstart`), and CM_DB_PATH in its own
#           environment; a `planned` one is looked up by CM_DB_PATH (the run
#           dir holds the run id)
#   tmux    the socket path the ledger recorded and its owner's uid; a
#           `planned` one by the socket directory's `run-dir` pointer
#   runner  pid, start time and process group; a `planned` one by its marker
#           argument `cmcheck-product-stage-<run id>`
#
# Anything that does not match is left running and marked `unknown`: a pid
# reused by another process is never stopped.
#
# bash 3.2 compatible (macOS /bin/bash).

# The lock section's options are read by the code machine-lock.sh loads, the results by the callers.
# shellcheck disable=SC2034,SC2153
PRODUCT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_REPO_ROOT="$(cd "$PRODUCT_LIB_DIR/../../.." && pwd)"
# shellcheck source=scripts/uat/run-lock.sh
. "$PRODUCT_REPO_ROOT/scripts/uat/run-lock.sh"
# shellcheck source=scripts/lib/port-pids.sh
. "$PRODUCT_REPO_ROOT/scripts/lib/port-pids.sh"
# The machine-wide lock (supervisor.lock). Sourced here on its own, whatever run-lock.sh did: a
# failed load must stop the lock being taken (PRODUCT_MACHINE_LOCK_OK), never run it unlocked.
# shellcheck source=scripts/lib/machine-lock.sh
. "$PRODUCT_REPO_ROOT/scripts/lib/machine-lock.sh"
PRODUCT_MACHINE_LOCK_OK=$?
if [ "$PRODUCT_MACHINE_LOCK_OK" != 0 ]; then
    PRODUCT_MACHINE_LOCK_ERROR="scripts/lib/machine-lock.sh could not be sourced (status $PRODUCT_MACHINE_LOCK_OK)"
fi

PRODUCT_LEDGER_PY="$PRODUCT_LIB_DIR/ledger.py"
PRODUCT_STOP_WAIT_TENTHS="${CM_PRODUCT_STOP_WAIT_TENTHS:-50}"

product_log() {
    echo "${PRODUCT_LOG_NAME:-product}: $*" >&2
}

ledger() {
    python3 "$PRODUCT_LEDGER_PY" "$@"
}

# ------------------------------------------------------------------- time

product_now() {
    date +%s
}

# product_deadline <HH:MM | @epoch> — epoch seconds; HH:MM is today, local time.
product_deadline() {
    case "$1" in
        @*) printf '%s\n' "${1#@}" ;;
        [0-2][0-9]:[0-5][0-9])
            date -j -f '%Y-%m-%d %H:%M:%S' "$(date +%Y-%m-%d) $1:00" +%s 2>/dev/null ||
                date -d "$(date +%Y-%m-%d) $1" +%s
            ;;
        *)
            product_log "not a time (HH:MM or @epoch): $1"
            return 1
            ;;
    esac
}

# ------------------------------------------------------------- processes

# In the C locale: the supervisor (launchd) and the guard must print it alike.
proc_lstart() {
    LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'
}

proc_pgid() {
    ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '
}

# proc_running <pid> — alive and not a zombie.
proc_running() {
    run_lock_pid_alive "$1" || return 1
    case "$(ps -o stat= -p "$1" 2>/dev/null)" in
        Z*) return 1 ;;
    esac
    return 0
}

# proc_matches <pid> <lstart> — the pid is alive and started at <lstart>.
proc_matches() {
    proc_running "$1" && [ -n "$2" ] && [ "$(proc_lstart "$1")" = "$2" ]
}

# stop_and_wait <pid> [group] — TERM, then KILL; 0 when it is gone.
stop_and_wait() {
    local pid=$1 group=${2:-} i=0
    if [ -n "$group" ]; then
        kill -TERM -- "-$group" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    else
        kill -TERM "$pid" 2>/dev/null || true
    fi
    while [ $i -lt "$PRODUCT_STOP_WAIT_TENTHS" ] && proc_running "$pid"; do
        sleep 0.1
        i=$((i + 1))
    done
    if proc_running "$pid"; then
        if [ -n "$group" ]; then
            kill -KILL -- "-$group" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
        else
            kill -KILL "$pid" 2>/dev/null || true
        fi
        sleep 0.2
    fi
    ! proc_running "$pid"
}

env_db_of() {
    ps eww -o command= -p "$1" 2>/dev/null | tr ' ' '\n' | sed -n 's/^CM_DB_PATH=//p' | head -n 1
}

file_uid() {
    stat -f %u "$1" 2>/dev/null || stat -c %u "$1" 2>/dev/null
}

# ------------------------------------------------------ supervisor lock

# supervisor.lock is the machine-wide lock (scripts/lib/machine-lock.sh, Issue
# #4288 PR1c; docs/design/supervisor-lock-machine-lock-4288.md) at
# <base>/supervisor.lock, its queue of tickets at <base>/supervisor.queue:
#
#   acquire   lock_acquire_path with a budget of 0 — one try, as the head of
#             the queue. Behind a live ticket it withdraws its own ticket and
#             does not judge the lock (message `queue`).
#   release   lock_release_held: removes the record only when its token is this
#             shell's and its pid is this main shell's $$; anything else stays.
#   recover   lock_recover_only (the deadline guard): recovers a dead holder's
#             lock as the head of the queue, never takes it.
#
# A holder is read once from `owner` (key=value lines); it is dead when its pid
# is ESRCH, or when its lstart= says the pid was reused (D7, judged by
# machine_lock_pid_identity inside the lock section — here only). What cannot
# be judged (EPERM, EIO, a host name that changed, a record being written) is
# never taken, removed or released: the refusal says why in PRODUCT_LOCK_ERROR.
#
# Results are left in PRODUCT_LOCK_RESULT (the guard: LRO_RESULT, or unloaded /
# rejected) and PRODUCT_LOCK_ERROR; a call refused for its arguments or context
# returns 2 and touches nothing. Each call sets the lock section's options
# afresh (the section holds one set per shell).

PRODUCT_LOCK_RESULT=""
PRODUCT_LOCK_ERROR=""
PRODUCT_LOCK_KIND=""
# I3's grace (PR1a-f): an owner-less, empty <lock> (or one holding only temporaries) older than this is the
# head's to take out. Its own constant — the same 600000 ms as I4's LOCK_EMPTY_OWNER_GRACE_MS (an owner of
# 0 bytes) but not borrowed from it, so changing I4 does not move this one.
PRODUCT_LOCK_OWNERLESS_GRACE_MS=600000
# How long the guard waits for the head of the queue; the supervisor waits for nobody.
PRODUCT_LOCK_GUARD_BUDGET_SEC="${CM_PRODUCT_LOCK_GUARD_BUDGET_SEC:-10}"

product_lock_dir() {
    printf '%s/supervisor.lock\n' "$PRODUCT_BASE"
}

product_lock_queue_dir() {
    machine_lock_queue_of "$(product_lock_dir)"
}

# product_lock_reject <fn> <reason> — 2, nothing touched.
product_lock_reject() {
    PRODUCT_LOCK_KIND=""
    PRODUCT_LOCK_RESULT=rejected
    PRODUCT_LOCK_ERROR="$1: $2"
    return 2
}

# The lock section holds one set of options per shell: put ours down on every call.
product_lock_setup() {
    machine_lock_use_kv_codec
    LOCK_OWNERLESS_GRACE_MS=$PRODUCT_LOCK_OWNERLESS_GRACE_MS
    LOCK_WANT_TOKEN=""
    LOCK_OWNER_PID=""
    LOCK_PENDING_TOKEN=""
    LOCK_OWNER_EXTRA=""
}

# product_lock_kind <unknown> <blocker> <gone-pending> — what to tell a person
# about the lock that was not taken (PRODUCT_LOCK_KIND; the owner is read here
# for the message only, never for the judgement). Precedence: eperm, unk, queue,
# corrupt, tmp, host, aside, rec, taking.
product_lock_kind() {
    local unknown=$1 blocker=$2 gone=$3 dir text
    dir=$(product_lock_dir)
    LPO_PID=""
    LPO_HOST=""
    LPO_TOKEN=""
    LPO_LABEL=""
    if [ -f "$dir/owner" ]; then
        text=$(cat "$dir/owner" 2>/dev/null) || text=""
        lock_parse_owner_text "$text" || true
        LPO_LABEL=$(printf '%s\n' "$text" | sed -n 's/^label=//p' | head -n 1)
    fi
    case "$unknown" in
        '') ;;
        *"point=pid "*"errno=EPERM"*)
            PRODUCT_LOCK_KIND=eperm
            return 0
            ;;
        *)
            PRODUCT_LOCK_KIND=unk
            return 0
            ;;
    esac
    if [ -n "$blocker" ]; then
        PRODUCT_LOCK_KIND=queue
    elif [ -f "$dir/owner" ] && { [ -z "$LPO_PID" ] || [ -z "$LPO_TOKEN" ]; }; then
        PRODUCT_LOCK_KIND=corrupt
    elif [ ! -f "$dir/owner" ] && [ -n "$(find "$dir" -maxdepth 1 -name 'owner.tmp.*' 2>/dev/null | head -n 1)" ]; then
        PRODUCT_LOCK_KIND=tmp
    elif [ -f "$dir/owner" ] && [ "$LPO_HOST" != "$LOCK_HOST" ]; then
        PRODUCT_LOCK_KIND=host
    elif [ -n "$gone" ] && [ ! -f "$dir/owner" ]; then
        PRODUCT_LOCK_KIND=aside
    elif [ -f "$dir/owner" ]; then
        PRODUCT_LOCK_KIND=rec
    else
        PRODUCT_LOCK_KIND=taking
    fi
}

# product_lock_message <kind> <unknown> <blocker> <gone-pending> — the text of a kind.
product_lock_message() {
    local kind=$1 unknown=$2 blocker=$3 gone=$4 dir
    dir=$(product_lock_dir)
    case "$kind" in
        loader) printf 'busy: the machine lock could not be loaded (%s); not taken\n' "${PRODUCT_MACHINE_LOCK_ERROR:-machine-lock.sh did not load}" ;;
        unk) printf 'busy: %s cannot be judged (%s); not taken\n' "$dir" "$unknown" ;;
        eperm) printf 'busy: %s held by pid %s, which belongs to another user (EPERM): the holder may have died and its pid been reused — check and remove %s by hand (#4288 PR1a-f)\n' "$dir" "${LPO_PID:-?}" "$dir" ;;
        queue) printf 'busy: queue ticket %s (pid %s) was ahead for %s; this supervisor withdrew its ticket and did not judge the lock\n' "${blocker##*/}" "$(lock_json_field "$blocker" pid 2>/dev/null)" "$dir" ;;
        corrupt)
            if [ -f "$dir/owner" ] && [ ! -s "$dir/owner" ]; then
                printf 'busy: %s/owner is empty (an acquisition is writing it, or died after creating it) — not taken now; the head takes an empty owner out once it is older than the grace (PR1a-f I4, 10 minutes)\n' "$dir"
            else
                printf 'busy: %s/owner is not a lock record (pid= or token= missing: an acquisition died while writing it) — nobody removes it; look at it and remove %s by hand when no supervisor runs (#4288 PR1a-f I4)\n' "$dir" "$dir"
            fi
            ;;
        tmp) printf 'busy: %s has no owner but holds %s (an acquisition is making it, or an older supervisor died while taking it) — not taken now; the head takes it out once <lock> and the temporaries are older than the grace (10 minutes) and the writer pid is shown gone (PR1a-f I3); if it stays longer, look at it and remove %s by hand\n' "$dir" "$(find "$dir" -maxdepth 1 -name 'owner.tmp.*' 2>/dev/null | sed 's|.*/||' | tr '\n' ' ' | sed 's/ $//')" "$dir" ;;
        host) printf 'busy: %s held by pid %s on host %s, not this host %s — not judged; if the host name changed, remove %s by hand (#4288 PR1a-f)\n' "$dir" "${LPO_PID:-?}" "${LPO_HOST:-?}" "$LOCK_HOST" "$dir" ;;
        aside) printf 'busy: %s is held by a record moved aside (%s) that could not be put back\n' "$dir" "$gone" ;;
        rec) printf 'busy: %s pid %s holds %s\n' "${LPO_LABEL:-supervisor}" "${LPO_PID:-?}" "$dir" ;;
        *) printf 'busy: %s is being taken by another supervisor right now\n' "$dir" ;;
    esac
}

# product_lock_acquire <label> — 0 when held, 1 when someone else has it or it
# could not be judged (PRODUCT_LOCK_ERROR says which), 2 when refused for its
# arguments or context.
product_lock_acquire() {
    local dir lstart unknown blocker gone
    PRODUCT_LOCK_RESULT=""
    PRODUCT_LOCK_ERROR=""
    PRODUCT_LOCK_KIND=""
    [ $# -eq 1 ] || { product_lock_reject product_lock_acquire "takes exactly one argument (the label)"; return; }
    [ -n "${PRODUCT_BASE:-}" ] || { product_lock_reject product_lock_acquire "PRODUCT_BASE is empty"; return; }
    case "$1" in
        '' | *$'\n'*) { product_lock_reject product_lock_acquire "the label is empty or has a newline"; return; } ;;
    esac
    [ -z "${LOCK_HELD_PATH:-}" ] || { product_lock_reject product_lock_acquire "this shell already holds a machine lock"; return; }
    if [ "$PRODUCT_MACHINE_LOCK_OK" != 0 ]; then
        PRODUCT_LOCK_RESULT=refused
        PRODUCT_LOCK_ERROR=$(product_lock_message loader "" "" "")
        return 1
    fi
    dir=$(product_lock_dir)
    product_lock_setup
    lstart=$(proc_lstart $$)
    LOCK_OWNER_EXTRA=$(printf 'label=%s\nlstart=%s' "$1" "$lstart")
    if lock_acquire_path "$dir" "$(product_lock_queue_dir)" 0; then
        PRODUCT_LOCK_RESULT=acquired
        return 0
    fi
    unknown=${LOCK_UNKNOWN-}
    blocker=${la_blocker-}
    gone=${LOCK_GONE_PENDING-}
    product_lock_kind "$unknown" "$blocker" "$gone"
    PRODUCT_LOCK_RESULT=refused
    PRODUCT_LOCK_ERROR=$(product_lock_message "$PRODUCT_LOCK_KIND" "$unknown" "$blocker" "$gone")
    return 1
}

# product_lock_release — only a lock this shell holds, and only its own record
# (the main shell's $$): anything else is kept for the next head to recover.
# Called from the supervisor's EXIT, which ends the shell, so nothing is retried.
product_lock_release() {
    PRODUCT_LOCK_RESULT=""
    PRODUCT_LOCK_ERROR=""
    PRODUCT_LOCK_KIND=""
    [ $# -eq 0 ] || { product_lock_reject product_lock_release "takes no argument"; return; }
    [ -n "${PRODUCT_BASE:-}" ] || { product_lock_reject product_lock_release "PRODUCT_BASE is empty"; return; }
    [ "${BASH_SUBSHELL:-0}" = 0 ] || { product_lock_reject product_lock_release "called from a subshell"; return; }
    if [ "$PRODUCT_MACHINE_LOCK_OK" != 0 ]; then
        PRODUCT_LOCK_RESULT=none
        return 0
    fi
    product_lock_setup
    lock_release_held "$(product_lock_dir)" || true
    PRODUCT_LOCK_RESULT=$LRH_RESULT
    return 0
}

# product_lock_recover_only — the deadline guard's recovery of a dead
# supervisor's lock (never a take). PRODUCT_LOCK_RESULT is removed | kept |
# restore-failed | absent | not-head | unloaded; PRODUCT_LOCK_ERROR is a line
# for a person when the lock was kept and needs one. Returns 0 whatever the
# result (the guard's exit code does not depend on the lock), 2 when refused.
product_lock_recover_only() {
    local unknown
    PRODUCT_LOCK_RESULT=""
    PRODUCT_LOCK_ERROR=""
    PRODUCT_LOCK_KIND=""
    [ $# -eq 0 ] || { product_lock_reject product_lock_recover_only "takes no argument"; return; }
    [ -n "${PRODUCT_BASE:-}" ] || { product_lock_reject product_lock_recover_only "PRODUCT_BASE is empty"; return; }
    [ -z "${LOCK_HELD_PATH:-}" ] || { product_lock_reject product_lock_recover_only "this shell holds the lock (the guard never acquires)"; return; }
    [ "${BASH_SUBSHELL:-0}" = 0 ] || { product_lock_reject product_lock_recover_only "called from a subshell"; return; }
    if [ "$PRODUCT_MACHINE_LOCK_OK" != 0 ]; then
        PRODUCT_LOCK_RESULT=unloaded
        PRODUCT_LOCK_ERROR=$(product_lock_message loader "" "" "")
        return 0
    fi
    product_lock_setup
    LOCK_GONE_PENDING=""
    lock_recover_only "$(product_lock_dir)" "$(product_lock_queue_dir)" "$PRODUCT_LOCK_GUARD_BUDGET_SEC"
    PRODUCT_LOCK_RESULT=$LRO_RESULT
    # A put-back that failed leaves no <lock> and a moved-aside record that still holds: lock_recover_only
    # reads the missing <lock> as "absent", but the lock is held by the record aside (design §3 F25/F26: kept).
    # Only a moved-aside record (<lock>.gone-…) counts: a failed listing of the directory (F20, pending names the
    # directory) holds nothing and stays the absent form the table gives it.
    if [ "$LRO_RESULT" = absent ] && [ -n "${LOCK_GONE_PENDING-}" ]; then
        case "$(basename "${LOCK_GONE_PENDING% unreadable}")" in *.gone-*) PRODUCT_LOCK_RESULT=kept ;; esac
    fi
    unknown=${LRO_UNKNOWN-}
    # The message follows the result as converted, not the one lock_recover_only returned.
    case "$PRODUCT_LOCK_RESULT" in
        kept)
            product_lock_kind "$unknown" "" ""
            case "$PRODUCT_LOCK_KIND" in
                eperm | unk | corrupt | tmp | host)
                    PRODUCT_LOCK_ERROR=$(product_lock_message "$PRODUCT_LOCK_KIND" "$unknown" "" "")
                    ;;
            esac
            ;;
        not-head)
            # Behind a live ticket the guard did not judge the lock: its record is not read for a message,
            # only an unknown the wait itself noted (the queue could not be listed) is told.
            if [ -n "$unknown" ]; then
                product_lock_kind "$unknown" "" ""
                PRODUCT_LOCK_ERROR=$(product_lock_message "$PRODUCT_LOCK_KIND" "$unknown" "" "")
            fi
            ;;
    esac
    return 0
}

# --------------------------------------------------------------- reclaim

# reclaim_server <ledger> <id> <state> <pid> <lstart> <db>
reclaim_server() {
    local file=$1 id=$2 state=$3 pid=$4 lstart=$5 db=$6 found p
    if [ "$state" = acquired ] && [ "$pid" != - ]; then
        if ! proc_running "$pid"; then
            ledger mark "$file" "$id" released gone
            return 0
        fi
        if proc_matches "$pid" "$lstart" && [ "$(env_db_of "$pid")" = "$db" ]; then
            if stop_and_wait "$pid"; then
                ledger mark "$file" "$id" released stopped
                return 0
            fi
            ledger mark "$file" "$id" unknown "pid $pid would not exit"
            return 1
        fi
        product_log "server $id: pid $pid is not the recorded one (start time or CM_DB_PATH differ): left alone"
        ledger mark "$file" "$id" unknown "pid $pid does not match"
        return 1
    fi
    # planned: look it up by CM_DB_PATH, among this user's processes.
    found=$(ps eww -U "$(id -u)" -o pid=,command= 2>/dev/null | awk -v want="CM_DB_PATH=$db" '
        { for (i = 2; i <= NF; i++) if ($i == want) { print $1; break } }')
    for p in $found; do
        [ "$p" = "$$" ] && continue
        product_log "server $id: found pid $p by CM_DB_PATH=$db (planned only): stopping it"
        stop_and_wait "$p" || {
            ledger mark "$file" "$id" unknown "pid $p would not exit"
            return 1
        }
    done
    ledger mark "$file" "$id" released "${found:+found by name}"
    return 0
}

# remove_run_socket_dir <socket dir> <run dir> — the private tmux server and
# its directory, when the directory's `run-dir` pointer names <run dir>.
remove_run_socket_dir() {
    local dir=$1 run_dir=$2 sock
    [ -d "$dir" ] || return 0
    [ -f "$dir/run-dir" ] && [ "$(cat "$dir/run-dir")" = "$run_dir" ] || return 1
    sock="$dir/tmux.sock"
    if [ -e "$sock" ]; then
        tmux -S "$sock" kill-server 2>/dev/null || true
    fi
    rm -rf "$dir"
}

# reclaim_tmux <ledger> <id> <state> <sock> <run dir>
reclaim_tmux() {
    local file=$1 id=$2 state=$3 sock=$4 run_dir=$5 dir
    if [ "$state" = acquired ] && [ "$sock" != - ]; then
        if [ ! -e "$sock" ] && [ ! -d "$(dirname "$sock")" ]; then
            ledger mark "$file" "$id" released gone
            return 0
        fi
        if [ -e "$sock" ] && [ "$(file_uid "$sock")" != "$(id -u)" ]; then
            ledger mark "$file" "$id" unknown "socket $sock is not owned by $(id -un)"
            return 1
        fi
        if remove_run_socket_dir "$(dirname "$sock")" "$run_dir"; then
            ledger mark "$file" "$id" released stopped
            return 0
        fi
        ledger mark "$file" "$id" unknown "socket directory of $sock does not point back to $run_dir"
        return 1
    fi
    for dir in "${CM_UAT_SOCK_BASE:-/tmp}"/cmuat-*-*; do
        [ -d "$dir" ] && [ -O "$dir" ] && [ -f "$dir/run-dir" ] || continue
        [ "$(cat "$dir/run-dir")" = "$run_dir" ] || continue
        product_log "tmux $id: found $dir by its run-dir pointer (planned only): stopping it"
        remove_run_socket_dir "$dir" "$run_dir"
    done
    ledger mark "$file" "$id" released ""
    return 0
}

# reclaim_runner <ledger> <id> <state> <pid> <lstart> <pgid> <marker>
reclaim_runner() {
    local file=$1 id=$2 state=$3 pid=$4 lstart=$5 pgid=$6 marker=$7 found line p g
    if [ "$state" = acquired ] && [ "$pid" != - ]; then
        if ! proc_running "$pid"; then
            ledger mark "$file" "$id" released gone
            return 0
        fi
        if proc_matches "$pid" "$lstart" && [ "$(proc_pgid "$pid")" = "$pgid" ]; then
            if stop_and_wait "$pid" "$pgid"; then
                ledger mark "$file" "$id" released stopped
                return 0
            fi
            ledger mark "$file" "$id" unknown "pid $pid would not exit"
            return 1
        fi
        product_log "runner $id: pid $pid is not the recorded one (start time or process group differ): left alone"
        ledger mark "$file" "$id" unknown "pid $pid does not match"
        return 1
    fi
    found=$(ps -U "$(id -u)" -o pid=,pgid=,command= 2>/dev/null | awk -v want="$marker" '
        { for (i = 3; i <= NF; i++) if ($i == want) { print $1 ":" $2; break } }')
    for line in $found; do
        p=${line%%:*}
        g=${line#*:}
        [ "$p" = "$$" ] && continue
        product_log "runner $id: found pid $p by its marker (planned only): stopping its group $g"
        stop_and_wait "$p" "$g" || {
            ledger mark "$file" "$id" unknown "pid $p would not exit"
            return 1
        }
    done
    ledger mark "$file" "$id" released "${found:+found by name}"
    return 0
}

# reclaim_ledger <ledger file> — every resource not yet released. 0 when all
# are released, 1 when any is left `unknown`.
reclaim_ledger() {
    local file=$1 rc=0 id kind state pid lstart pgid sock db marker run_dir
    while IFS=$'\t' read -r id kind state pid lstart pgid sock db marker run_dir; do
        [ -n "$id" ] || continue
        case "$state" in
            released) continue ;;
            unknown) rc=1; continue ;;
        esac
        case "$kind" in
            server) reclaim_server "$file" "$id" "$state" "$pid" "$lstart" "$db" || rc=1 ;;
            tmux) reclaim_tmux "$file" "$id" "$state" "$sock" "$run_dir" || rc=1 ;;
            runner) reclaim_runner "$file" "$id" "$state" "$pid" "$lstart" "$pgid" "$marker" || rc=1 ;;
            *)
                ledger mark "$file" "$id" unknown "unknown kind $kind"
                rc=1
                ;;
        esac
    done <<EOF
$(ledger list "$file")
EOF
    return $rc
}

# ledger_unknown_ids <ledger file> — the ids left `unknown`, space-separated.
ledger_unknown_ids() {
    ledger list "$1" | awk -F '\t' '$3 != "released" { printf "%s ", $1 }'
}

# ------------------------------------------------------------- run state

# state_set <state file> <key> <value> — replaces the key, atomically.
product_state_set() {
    local file=$1 key=$2 value=$3 tmp
    tmp="$file.tmp.$$"
    {
        [ -f "$file" ] && grep -v "^$key=" "$file"
        printf '%s=%s\n' "$key" "$value"
    } >"$tmp" && mv -f "$tmp" "$file"
}

product_state_get() {
    [ -f "$1" ] || return 0
    sed -n "s/^$2=//p" "$1" | tail -n 1
}

# product_finalize <run id> <by> — the result, published (finalize.ts).
product_finalize() {
    "$PRODUCT_REPO_ROOT/node_modules/.bin/tsx" "$PRODUCT_LIB_DIR/finalize.ts" \
        --base "$PRODUCT_BASE" --run-id "$1" --by "$2"
}

# test hook: CM_PRODUCT_TEST_PAUSE_AT=<checkpoint> parks the process there
# (short sleeps, so nothing outlives a kill -9 by more than 0.2 s).
product_checkpoint() {
    [ "${CM_PRODUCT_TEST_PAUSE_AT:-}" = "$1" ] || return 0
    : >"$PRODUCT_BASE/paused-$1"
    while :; do sleep 0.2; done
}
