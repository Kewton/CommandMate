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

PRODUCT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_REPO_ROOT="$(cd "$PRODUCT_LIB_DIR/../../.." && pwd)"
. "$PRODUCT_REPO_ROOT/scripts/uat/run-lock.sh"
. "$PRODUCT_REPO_ROOT/scripts/lib/port-pids.sh"

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

# A mkdir lock at <base>/supervisor.lock, separate from scripts/uat/run-lock.sh.
# `owner` holds pid and lstart, so a reused pid is not mistaken for the owner.

product_lock_dir() {
    printf '%s/supervisor.lock\n' "$PRODUCT_BASE"
}

product_lock_owner_alive() {
    local dir=$1 pid lstart
    pid=$(run_lock_field "$dir" pid)
    lstart=$(run_lock_field "$dir" lstart)
    [ -n "$pid" ] && proc_matches "$pid" "$lstart"
}

# product_lock_acquire <label> — 0 when held, 1 when a live owner has it.
product_lock_acquire() {
    local dir aside tmp
    dir=$(product_lock_dir)
    if ! mkdir "$dir" 2>/dev/null; then
        if product_lock_owner_alive "$dir"; then
            PRODUCT_LOCK_ERROR="busy: $(run_lock_field "$dir" label) pid $(run_lock_field "$dir" pid) holds $dir"
            return 1
        fi
        aside="$dir.stale.$$"
        mv "$dir" "$aside" 2>/dev/null || {
            PRODUCT_LOCK_ERROR="lost the race to take over the stale $dir"
            return 1
        }
        rm -rf "$aside"
        mkdir "$dir" 2>/dev/null || {
            PRODUCT_LOCK_ERROR="lost the race for $dir"
            return 1
        }
    fi
    tmp="$dir/owner.tmp.$$"
    printf 'pid=%s\nlstart=%s\nlabel=%s\n' "$$" "$(proc_lstart $$)" "$1" >"$tmp" && mv -f "$tmp" "$dir/owner"
}

# product_lock_release — only a lock this process holds.
product_lock_release() {
    local dir
    dir=$(product_lock_dir)
    [ "$(run_lock_field "$dir" pid)" = "$$" ] && rm -rf "$dir"
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
