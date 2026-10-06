#!/bin/bash
#
# CommandMate - start and stop an isolated server for a real-environment run
# (Issue #3359). `.commandmate/uat.yaml` calls it for `up` / `down`; the daily
# check (#3312) is meant to call it too.
#
#   bash scripts/uat/run-server.sh up      --port <port> --run-dir <dir> [--wait-listen <sec>] [--own-home]
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
# is unchanged from #2590 / #3342; `.commandmate/uat.yaml` describes why. The
# server also runs with CM_UAT_ISOLATION=1 (#3360,
# docs/user-guide/uat-isolation.md): it writes none of the agents' shared hook
# files, grants no codex hook trust and reads no user-level claude settings.
# The shared-file record below is the check on that.
#
# --own-home (#3312, for the daily product-path check run as a dedicated OS
# user): the server runs with CM_UAT_ISOLATION=own-home and
# CM_UAT_DEDICATED_USER=$(id -un) instead. It then WRITES the agents' hook
# files, but only inside that user's own HOME (the server checks the user, the
# HOME and every path before each launch, and refuses otherwise). Put the
# sockets and the lock under that HOME with CM_UAT_SOCK_BASE / CM_RUN_LOCK_DIR.
# `down` still records whether the shared files changed, and does not fail on
# it: under own-home they are the dedicated user's, written on purpose. Without
# --own-home nothing changes.
#
# Test hooks: CM_UAT_SOCK_BASE (default /tmp) moves the socket directories,
# CM_UAT_SERVER_ENTRY (default dist/server/server.js) replaces the server.
#
# bash 3.2 compatible (macOS /bin/bash).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
OWN_HOME=0
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
            --own-home)
                OWN_HOME=1
                shift
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

# ------------------------------------------------------- shared-file record

# codex's two shared files are keyed by $CODEX_HOME alone, so they cannot be
# moved without moving codex's login. `up` decides ONE absolute CODEX_HOME (CH)
# and uses it for the record, the private tmux server and the server (#3358);
# `down` reads it back from the record instead of re-deriving it. The record is
# compared, never written back.
#
# <run dir>/codex-shared.sha256, one line per entry, the first word saying what
# the line is (add a new kind as one more `case` arm in each of the two
# functions below):
#   CODEX_HOME  <CH>          the decided home; the lines after it are relative to it
#   <sha256|absent>  <path>   a file under CH, path relative to CH
#   ABSOLUTE  <sha256|absent>  <path>
#                             a shared file outside CH, by absolute path (#3360):
#                             antigravity's ~/.gemini/config/hooks.json and
#                             copilot's ~/.copilot/settings.json (#3391)
SHARED_RECORD_NAME="codex-shared.sha256"
CODEX_SHARED_FILES="hooks.json commandmate/cmate-agent-event.sh"

# sha_of <file> — its sha256, or "absent".
sha_of() {
    if [ -f "$1" ]; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        echo absent
    fi
}

# decide_codex_home — sets CH. Returns 1 (with a message) for a value the run
# must not start with. Writes nothing.
#
# Absolute, because a relative value means the server's cwd for CommandMate
# and codex's own cwd for codex: two places. The server
# (src/config/system-directories.ts, VIRTUAL_FILESYSTEM_ROOTS) swaps a
# CODEX_HOME under /proc, /sys or /dev for ~/.codex, so the record would watch
# one place while the server writes another: refused in the lexical and the
# symlink-resolved form. An explicit value must already be a directory (a typo
# would silently check nothing); the default may be absent (no codex here).
decide_codex_home() {
    local ch_real d
    CH="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${CODEX_HOME:-$HOME/.codex}")"
    ch_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CH")"
    if [ -z "$CH" ] || [ -z "$ch_real" ]; then
        log "cannot resolve CODEX_HOME"
        return 1
    fi
    for d in "$CH" "$ch_real"; do
        case "$d" in
            /proc|/proc/*|/sys|/sys/*|/dev|/dev/*)
                log "CODEX_HOME is refused by the server (virtual filesystem): $d"
                return 1
                ;;
        esac
    done
    if [ -n "${CODEX_HOME:-}" ] && [ ! -d "$CH" ]; then
        log "CODEX_HOME is not an existing directory: $CH"
        return 1
    fi
}

# write_shared_record <record file> — needs CH.
write_shared_record() {
    local n
    {
        printf 'CODEX_HOME  %s\n' "$CH"
        for n in $CODEX_SHARED_FILES; do
            printf '%s  %s\n' "$(sha_of "$CH/$n")" "$n"
        done
        # The server's os.homedir() is this $HOME (env -i passes it through).
        for n in "$HOME/.gemini/config/hooks.json" "$HOME/.copilot/settings.json"; do
            printf 'ABSOLUTE  %s  %s\n' "$(sha_of "$n")" "$n"
        done
    }>"$1"
}

# check_shared_record <record file> — 0 when nothing changed, 1 (with one
# message per change) otherwise.
check_shared_record() {
    local kind rest base="" rc=0 h p
    while read -r kind rest; do
        case "$kind" in
            '') ;;
            CODEX_HOME) base="$rest" ;;
            ABSOLUTE)
                h=${rest%%  *}
                p=${rest#*  }
                if [ "$(sha_of "$p")" != "$h" ]; then
                    log "shared agent hook file changed during the run: $p"
                    rc=1
                fi
                ;;
            *)
                if [ -z "$base" ]; then
                    log "$1: a file line before the CODEX_HOME line: $kind $rest"
                    rc=1
                elif [ "$(sha_of "$base/$rest")" != "$kind" ]; then
                    log "codex shared file changed during the run: $base/$rest"
                    rc=1
                fi
                ;;
        esac
    done <"$1"
    return $rc
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
    local run_id sock_dir sock tmux_pid server_pid db i isolation=1
    # --own-home (#3312): appended after CM_UAT_ISOLATION=1 on the server line,
    # so env sets the later value. Empty otherwise (the expansion below is the
    # bash 3.2 `set -u` safe form of an empty array).
    local own_home_env=()
    if [ "$OWN_HOME" -eq 1 ]; then
        isolation=own-home
        own_home_env=(CM_UAT_ISOLATION=own-home "CM_UAT_DEDICATED_USER=$(id -un)")
    fi
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
    # Before anything is made or started (#3358).
    decide_codex_home || exit 1
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
    state_set "$UP_STATE" isolation "$isolation"
    state_set "$UP_STATE" status starting

    mkdir -p "$RUN_DIR/root" || exit 1
    write_shared_record "$RUN_DIR/$SHARED_RECORD_NAME" || exit 1

    mkdir -m 700 "$sock_dir" || exit 1
    printf '%s\n' "$RUN_DIR" >"$sock_dir/run-dir" || exit 1
    state_set "$UP_STATE" created "$sock_dir"

    # The tmux server is started from the caller's normal environment: one born
    # under `env -i` loses Keychain access and a claude session in it comes up
    # logged out. Always -S: a bare tmux would reach the user's own server. Its
    # environment is what a codex it launches inherits when hook setup fails and
    # CommandMate leaves CODEX_HOME off the launch line, so it carries CH too.
    CODEX_HOME="$CH" tmux -S "$sock" new-session -d -s keepalive 'sleep 86400' || exit 1
    tmux_pid="$(tmux -S "$sock" display-message -p '#{pid}' 2>/dev/null)"
    [ -n "$tmux_pid" ] || exit 1
    state_set "$UP_STATE" tmux_pid "$tmux_pid"

    cd "$REPO_ROOT" || exit 1
    env -i HOME="$HOME" PATH="$PATH" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/sh}" \
        CODEX_HOME="$CH" LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" \
        TMUX="$sock,$tmux_pid,0" \
        NODE_ENV=production CM_PORT="$PORT" CM_BIND=127.0.0.1 CM_UAT_ISOLATION=1 \
        ${own_home_env[@]+"${own_home_env[@]}"} \
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
    local state token sock_dir rc=0
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

    # Fail when the run rewrote codex's shared hook or relay script, or
    # antigravity's ~/.gemini/config/hooks.json, or copilot's
    # ~/.copilot/settings.json. Under --own-home (#3312) the change is recorded
    # (the messages, and shared_changed in the state) but is not a failure.
    if [ -f "$RUN_DIR/$SHARED_RECORD_NAME" ]; then
        if [ "$(state_get "$state" isolation)" = "own-home" ]; then
            if check_shared_record "$RUN_DIR/$SHARED_RECORD_NAME"; then
                state_set "$state" shared_changed no
            else
                state_set "$state" shared_changed yes
                log "own-home: the dedicated user's shared hook files changed (recorded, not a failure)"
            fi
        else
            check_shared_record "$RUN_DIR/$SHARED_RECORD_NAME" || rc=1
        fi
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

main() {
    local subcommand="${1:-}"
    [ $# -gt 0 ] && shift
    parse_args "$@"
    case "$subcommand" in
        up) cmd_up ;;
        down) cmd_down ;;
        cleanup) cmd_cleanup ;;
        *)
            echo "usage: run-server.sh up --port <port> --run-dir <dir> [--own-home] | down --run-dir <dir> | cleanup" >&2
            exit 2
            ;;
    esac
}

# Sourcing defines the functions only (the tests call decide_codex_home and
# the record functions without starting anything).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
