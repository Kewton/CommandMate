#!/bin/bash
#
# CommandMate - start and stop an isolated server for a real-environment run
# (Issue #3359). `.commandmate/uat.yaml` calls it for `up` / `down`; the daily
# check (#3312) is meant to call it too.
#
#   bash scripts/uat/run-server.sh up      --port <port> --run-dir <dir> [--wait-listen <sec>]
#   bash scripts/uat/run-server.sh down    --run-dir <dir>
#   bash scripts/uat/run-server.sh cleanup
#
# What makes it safe to run next to other servers:
#
#   - Every run has its own id (UTC yymmddHHMMSS + 15 random bits), and its private tmux server
#     lives on /tmp/cmuat-<port>-<run id>/tmux.sock. The socket is not under
#     <run dir> because a unix socket path is capped at 104 bytes on macOS.
#   - `up` records, in <run dir>/uat-run.state, the server pid and the
#     CM_DB_PATH read off that pid's own environment. `down` stops the pid only
#     when (a) it is the pid LISTENING on the port (or nothing listens yet) and
#     (b) its environment's CM_DB_PATH is under <run dir>. Otherwise it stops
#     nothing and fails. It never looks a process up by the port alone: whoever
#     else listens there is left alone.
#   - The socket directory carries `run-dir`, a pointer back to the state, so
#     the next `up` (or `cleanup`) can find what a killed run left behind and
#     stop it the same verified way.
#   - The shared run lock (run-lock.sh) is taken before anything starts and
#     released after the server is gone. While the server runs, the lock's
#     owner pid is the server's, so the lock outlives the `up` shell and goes
#     stale by itself if the server dies.
#   - A failed `up` undoes what it made (its own pid, tmux server, socket
#     directory, lock) before it exits. With --wait-listen, `up` also waits for
#     the recorded pid to LISTEN on the port and fails when it exits first (for
#     a caller with no health check of its own; uat.yaml has one).
#
# Isolation of the server itself (env -i, CM_DB_PATH / CM_ROOT_DIR / TMUX ...)
# is unchanged from #2590 / #3342; `.commandmate/uat.yaml` describes why.
#
# Test hooks: CM_UAT_SOCK_BASE (default /tmp) moves the socket directories,
# CM_UAT_SERVER_ENTRY (default dist/server/server.js) replaces the server.
#
# bash 3.2 compatible (macOS /bin/bash).

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
. "$REPO_ROOT/scripts/uat/run-lock.sh"
. "$REPO_ROOT/scripts/lib/port-pids.sh"

SOCK_BASE="${CM_UAT_SOCK_BASE:-/tmp}"
SOCK_BASE="${SOCK_BASE%/}"
SERVER_ENTRY="${CM_UAT_SERVER_ENTRY:-dist/server/server.js}"
STATE_NAME="uat-run.state"
# A unix socket path may be at most 104 bytes on macOS, including the NUL.
SOCK_PATH_MAX=103
STOP_WAIT_TENTHS=100

log() {
    echo "run-server: $*" >&2
}

# ---------------------------------------------------------------- state file

# state_get <state file> <key>
state_get() {
    [ -f "$1" ] || return 0
    sed -n "s/^$2=//p" "$1" | tail -n 1
}

# state_set <state file> <key> <value> — replaces the key, atomically.
state_set() {
    local file=$1 key=$2 value=$3 tmp
    tmp="$file.tmp.$$"
    {
        [ -f "$file" ] && grep -v "^$key=" "$file"
        printf '%s=%s\n' "$key" "$value"
    } >"$tmp" && mv -f "$tmp" "$file"
}

# ------------------------------------------------------------- verification

# env_value_of <pid> <name> — a variable from the process's own environment.
env_value_of() {
    ps eww -o command= -p "$1" 2>/dev/null | tr ' ' '\n' | sed -n "s/^$2=//p" | head -n 1
}

# stop_recorded <state file>
#
# Stops the server recorded in <state file>, verified. Returns 0 when it is
# gone (or was never started), 1 when it refused or the pid would not exit.
stop_recorded() {
    local state=$1 pid port run_dir db listeners i
    pid=$(state_get "$state" server_pid)
    port=$(state_get "$state" port)
    run_dir=$(state_get "$state" run_dir)
    if [ -z "$pid" ] || ! run_lock_pid_alive "$pid"; then
        return 0
    fi
    if [ -z "$run_dir" ] || [ -z "$port" ]; then
        log "state $state has no run_dir/port: not stopping pid $pid"
        return 1
    fi
    db=$(env_value_of "$pid" CM_DB_PATH)
    case "$db" in
        "$run_dir"/*) ;;
        *)
            log "pid $pid ($(describe_pid "$pid")) has CM_DB_PATH='$db', not under $run_dir: not stopping it"
            return 1
            ;;
    esac
    listeners=$(find_listen_pids_by_port "$port" | tr '\n' ' ')
    listeners="${listeners% }"
    if [ -n "$listeners" ] && [ "$listeners" != "$pid" ]; then
        log "port $port is listened on by '$listeners', not by the recorded pid $pid: not stopping anything"
        return 1
    fi
    log "stopping $pid ($(describe_pid "$pid"))"
    kill "$pid" 2>/dev/null || true
    i=0
    while [ $i -lt $STOP_WAIT_TENTHS ] && run_lock_pid_alive "$pid"; do
        sleep 0.1
        i=$((i + 1))
    done
    if run_lock_pid_alive "$pid"; then
        log "pid $pid did not exit within $((STOP_WAIT_TENTHS / 10)) s"
        return 1
    fi
    state_set "$state" server_pid_stopped "$pid"
    return 0
}

# remove_socket_dir <socket dir> — stops the private tmux server and removes
# the directory. Only a directory this script made (it holds `run-dir`).
remove_socket_dir() {
    local dir=$1 sock
    [ -n "$dir" ] && [ -d "$dir" ] || return 0
    if [ ! -f "$dir/run-dir" ]; then
        log "$dir was not made by this script: left alone"
        return 0
    fi
    sock="$dir/tmux.sock"
    if [ -S "$sock" ]; then
        tmux -S "$sock" kill-server 2>/dev/null || true
    fi
    rm -rf "$dir"
}

# cleanup_leftovers — what earlier runs left: their socket directories, and the
# servers recorded in the state those point to. Called with the lock held, so
# none of them belongs to a live run of this script.
cleanup_leftovers() {
    local dir run_dir state rc=0
    for dir in "$SOCK_BASE"/cmuat-*-*; do
        [ -d "$dir" ] && [ -O "$dir" ] && [ -f "$dir/run-dir" ] || continue
        run_dir=$(cat "$dir/run-dir")
        state="$run_dir/$STATE_NAME"
        log "leftover from an earlier run: $dir (run dir $run_dir)"
        if [ -f "$state" ]; then
            if ! stop_recorded "$state"; then
                log "could not stop the server of $run_dir: its socket directory is kept"
                rc=1
                continue
            fi
            state_set "$state" status cleaned
        else
            log "no state at $state: only its tmux server and socket directory are removed"
        fi
        remove_socket_dir "$dir"
    done
    return $rc
}

# ---------------------------------------------------------------- arguments

PORT=""
RUN_DIR=""
WAIT_LISTEN=0
parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --port)
                PORT="${2:-}"
                shift 2 || shift
                ;;
            --run-dir)
                RUN_DIR="${2:-}"
                shift 2 || shift
                ;;
            --wait-listen)
                WAIT_LISTEN="${2:-}"
                shift 2 || shift
                ;;
            *)
                log "unknown argument: $1"
                exit 2
                ;;
        esac
    done
}

require_run_dir() {
    if [ -z "$RUN_DIR" ]; then
        log "--run-dir is required"
        exit 2
    fi
}

# ------------------------------------------------------------------------ up

UP_TOKEN=""
UP_STATE=""
UP_DONE=0

# Undoes a failed `up`: only what this run made and recorded.
up_on_exit() {
    local rc=$?
    [ "$UP_DONE" -eq 1 ] && return 0
    [ -n "$UP_TOKEN" ] || return 0
    log "up failed (exit $rc): removing what this run made"
    if [ -n "$UP_STATE" ] && [ -f "$UP_STATE" ]; then
        if stop_recorded "$UP_STATE"; then
            remove_socket_dir "$(state_get "$UP_STATE" sock_dir)"
            state_set "$UP_STATE" status failed
            run_lock_release "$UP_TOKEN"
        else
            # Our server could not be verified or stopped: keep the lock and
            # the pointer, so `down` / the next run deal with it.
            remove_socket_dir_tmux_only "$(state_get "$UP_STATE" sock_dir)"
            state_set "$UP_STATE" status failed-server-left
        fi
    else
        run_lock_release "$UP_TOKEN"
    fi
    exit "$rc"
}

remove_socket_dir_tmux_only() {
    local sock="$1/tmux.sock"
    [ -n "$1" ] && [ -S "$sock" ] || return 0
    tmux -S "$sock" kill-server 2>/dev/null || true
}

cmd_up() {
    local run_id sock_dir sock codex_home f tmux_pid server_pid db i
    if [ -z "$PORT" ] || [ -z "$RUN_DIR" ]; then
        log "up needs --port and --run-dir"
        exit 2
    fi
    case "$PORT$WAIT_LISTEN" in
        *[!0-9]*)
            log "--port and --wait-listen must be numbers"
            exit 2
            ;;
    esac
    mkdir -p "$RUN_DIR" || exit 1
    RUN_DIR="$(cd "$RUN_DIR" && pwd)"

    run_id="$(date -u +%y%m%d%H%M%S)-$(printf '%04x' $RANDOM)"
    if ! run_lock_acquire uat $$ "$run_id" "$RUN_DIR"; then
        log "$RUN_LOCK_ERROR"
        exit 1
    fi
    UP_TOKEN="$run_id"
    trap up_on_exit EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    if ! cleanup_leftovers; then
        log "an earlier run's server could not be stopped safely; resolve it before starting another"
        exit 1
    fi

    sock_dir="$SOCK_BASE/cmuat-$PORT-$run_id"
    sock="$sock_dir/tmux.sock"
    if [ "${#sock}" -gt $SOCK_PATH_MAX ]; then
        log "socket path is ${#sock} bytes, over the $SOCK_PATH_MAX-byte limit: $sock"
        exit 1
    fi

    UP_STATE="$RUN_DIR/$STATE_NAME"
    rm -f "$UP_STATE"
    state_set "$UP_STATE" run_id "$run_id"
    state_set "$UP_STATE" port "$PORT"
    state_set "$UP_STATE" run_dir "$RUN_DIR"
    state_set "$UP_STATE" sock_dir "$sock_dir"
    state_set "$UP_STATE" status starting

    mkdir -p "$RUN_DIR/root" || exit 1
    # codex's two shared files are keyed by $CODEX_HOME alone, so they cannot be
    # moved without moving codex's login. Record their sha256 here; `down`
    # compares and fails when the run rewrote them. Never written back.
    codex_home="${CODEX_HOME:-$HOME/.codex}"
    for f in "$codex_home/hooks.json" "$codex_home/commandmate/cmate-agent-event.sh"; do
        printf '%s  %s\n' "$([ -f "$f" ] && shasum -a 256 "$f" | cut -d' ' -f1 || echo absent)" "$f"
    done >"$RUN_DIR/codex-shared.sha256" || exit 1

    mkdir -m 700 "$sock_dir" || exit 1
    printf '%s\n' "$RUN_DIR" >"$sock_dir/run-dir" || exit 1
    state_set "$UP_STATE" created "$sock_dir"

    # The tmux server is started from the caller's normal environment: one born
    # under `env -i` loses Keychain access and a claude session in it comes up
    # logged out. Always -S: a bare tmux would reach the user's own server.
    tmux -S "$sock" new-session -d -s keepalive 'sleep 86400' || exit 1
    tmux_pid="$(tmux -S "$sock" display-message -p '#{pid}' 2>/dev/null)"
    [ -n "$tmux_pid" ] || exit 1
    state_set "$UP_STATE" tmux_pid "$tmux_pid"

    cd "$REPO_ROOT" || exit 1
    env -i HOME="$HOME" PATH="$PATH" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/sh}" \
        LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" \
        TMUX="$sock,$tmux_pid,0" \
        NODE_ENV=production CM_PORT="$PORT" CM_BIND=127.0.0.1 \
        CM_DB_PATH="$RUN_DIR/uat.db" CM_ROOT_DIR="$RUN_DIR/root" \
        CM_OPENCODE_V2_DIR="$RUN_DIR/opencode-v2" CM_AGENT_HOOKS_DIR="$RUN_DIR/hooks" \
        nohup node "$SERVER_ENTRY" >"$RUN_DIR/server.log" 2>&1 </dev/null &
    server_pid=$!
    state_set "$UP_STATE" server_pid "$server_pid"
    run_lock_set_pid "$run_id" "$server_pid" || exit 1

    # Record CM_DB_PATH as the running pid sees it, not as this script meant it.
    db=""
    i=0
    while [ $i -lt 50 ] && [ -z "$db" ]; do
        if ! run_lock_pid_alive "$server_pid"; then
            log "the server (pid $server_pid) exited at once; see $RUN_DIR/server.log"
            exit 1
        fi
        db=$(env_value_of "$server_pid" CM_DB_PATH)
        [ -n "$db" ] || sleep 0.1
        i=$((i + 1))
    done
    case "$db" in
        "$RUN_DIR"/*) ;;
        *)
            log "pid $server_pid has CM_DB_PATH='$db', not under $RUN_DIR"
            exit 1
            ;;
    esac
    state_set "$UP_STATE" db_path "$db"
    i=0
    while [ "$WAIT_LISTEN" -gt 0 ] && ! find_listen_pids_by_port "$PORT" | grep -qx "$server_pid"; do
        if ! run_lock_pid_alive "$server_pid"; then
            log "the server (pid $server_pid) exited before it listened on $PORT; see $RUN_DIR/server.log"
            exit 1
        fi
        if [ $i -ge $((WAIT_LISTEN * 10)) ]; then
            log "the server (pid $server_pid) did not listen on $PORT within $WAIT_LISTEN s"
            exit 1
        fi
        sleep 0.1
        i=$((i + 1))
    done
    state_set "$UP_STATE" status up
    UP_DONE=1
    trap - EXIT INT TERM
    log "up: run $run_id, pid $server_pid, port $PORT, tmux $sock"
}

# ---------------------------------------------------------------------- down

cmd_down() {
    local state token sock_dir rc=0 h f n
    require_run_dir
    RUN_DIR="$(cd "$RUN_DIR" 2>/dev/null && pwd)" || {
        log "no run dir: refusing to stop anything by port"
        exit 1
    }
    state="$RUN_DIR/$STATE_NAME"
    if [ ! -f "$state" ]; then
        log "no $state: nothing recorded, and nothing is stopped by port"
        exit 1
    fi
    token=$(state_get "$state" run_id)
    sock_dir=$(state_get "$state" sock_dir)

    if stop_recorded "$state"; then
        remove_socket_dir "$sock_dir"
        state_set "$state" status stopped
        run_lock_release "$token"
    else
        # Keep the lock: our server may still be running.
        remove_socket_dir_tmux_only "$sock_dir"
        state_set "$state" status stop-refused
        rc=1
    fi

    # Fail when the run rewrote codex's shared hook or relay script.
    if [ -f "$RUN_DIR/codex-shared.sha256" ]; then
        while read -r h f; do
            n=$([ -f "$f" ] && shasum -a 256 "$f" | cut -d' ' -f1 || echo absent)
            if [ "$n" != "$h" ]; then
                log "codex shared file changed during the run: $f"
                rc=1
            fi
        done <"$RUN_DIR/codex-shared.sha256"
    fi
    exit $rc
}

# ------------------------------------------------------------------- cleanup

cmd_cleanup() {
    local token
    token="cleanup-$$-$RANDOM"
    if ! run_lock_acquire cleanup $$ "$token"; then
        log "$RUN_LOCK_ERROR"
        exit 1
    fi
    cleanup_leftovers
    local rc=$?
    run_lock_release "$token"
    exit $rc
}

# ---------------------------------------------------------------------- main

SUBCOMMAND="${1:-}"
[ $# -gt 0 ] && shift
parse_args "$@"
case "$SUBCOMMAND" in
    up) cmd_up ;;
    down) cmd_down ;;
    cleanup) cmd_cleanup ;;
    *)
        echo "usage: run-server.sh up --port <port> --run-dir <dir> | down --run-dir <dir> | cleanup" >&2
        exit 2
        ;;
esac
