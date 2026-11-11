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
#   - The shared run lock (run-lock.sh, the machine-wide lock of scripts/lib/machine-lock.sh)
#     is taken before anything starts and released after the server is gone. The server is
#     started as the leader of a process group of its own and waits for a signal; the lock's
#     owner is then rewritten with that group (pgid=) and the server's pid under a new token
#     (<run id>-g<pid>) BEFORE the signal, so the lock outlives the `up` shell and is held
#     while any process of the group is alive (docs/design/run-lock-machine-lock-4288.md).
#     `down` stops the server and what is left of its group (only what is shown to be this
#     run's), then releases the lock as the head of its queue; it says "stopped" only then.
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
# Its checks are .commandmate/uat-own-home.yaml.
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

# group_members <G> — the pids (not the leader <G>) whose process group is <G>, one per
# line. Returns 1 when ps cannot say. Zombies are listed (a zombie keeps its group alive).
group_members() {
    local out
    out=$(ps -A -o pid= -o pgid= 2>/dev/null) || return 1
    [ -n "$out" ] || return 1
    printf '%s\n' "$out" | awk -v g="$1" '$2 == g && $1 != g { print $1 }'
}

# drain_members <G> <pid>... — TERM, grace, KILL for those of the pids that are still in group <G>
# (one by one, never the group's number: an emptied group's number may be reused). Returns 0 when
# the group <G> is empty afterwards (ESRCH), 1 when it is not or cannot be shown to be.
drain_members() {
    local g=$1 p alive="" i
    shift
    for p in "$@"; do
        kill -0 "$p" 2>/dev/null || continue
        [ "$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')" = "$g" ] || continue
        alive="$alive $p"
    done
    if [ -n "$alive" ]; then
        log "stopping what is left of group $g:$alive"
        for p in $alive; do kill -s TERM "$p" 2>/dev/null || true; done
        i=0
        while [ $i -lt 50 ]; do
            [ "$(lock_obs_kill0 group "-$g")" = gone ] && return 0
            sleep 0.1
            i=$((i + 1))
        done
        for p in $alive; do kill -s KILL "$p" 2>/dev/null || true; done
        i=0
        while [ $i -lt 20 ]; do
            [ "$(lock_obs_kill0 group "-$g")" = gone ] && return 0
            sleep 0.1
            i=$((i + 1))
        done
    fi
    [ "$(lock_obs_kill0 group "-$g")" = gone ]
}

# stop_recorded <state file> [new|old]
#
# Stops the server recorded in <state file>, verified: alive, not a zombie, its CM_DB_PATH under
# the run dir, listening alone on the port (or not yet), and — in the new form — the leader of
# a group of its own. Sets LEADER_STATE: unrecorded | dead | zombie | alive-unverified |
# alive-verified, and, for a verified leader in the new form, GROUP_SNAPSHOT (the pids that were in
# its group while it lived; GROUP_SNAPSHOT_RC 1 when ps could not say). LEADER_STUCK=1 when it was
# sent TERM and did not end. Returns 0 when it is gone (or was never started), 1 when it refused or
# the pid would not exit.
LEADER_STATE=""
LEADER_STUCK=0
GROUP_SNAPSHOT=""
GROUP_SNAPSHOT_RC=0
# A pid the caller is the parent of (up's trap): reaped with `wait` as soon as it has ended.
DOWN_REAP_PID=""
stop_recorded() {
    local state=$1 form=${2:-new} pid port run_dir db listeners i kout stat leads
    LEADER_STATE=unrecorded
    LEADER_STUCK=0
    GROUP_SNAPSHOT=""
    GROUP_SNAPSHOT_RC=0
    pid=$(state_get "$state" server_pid)
    port=$(state_get "$state" port)
    run_dir=$(state_get "$state" run_dir)
    [ -n "$pid" ] || return 0
    kout=$(lock_obs_kill0 pid "$pid")
    case "$kout" in
        alive) ;;
        gone)
            LEADER_STATE=dead
            return 0
            ;;
        *)
            LEADER_STATE="alive-unverified"
            log "pid $pid cannot be observed (${kout#unknown:}): not stopping it"
            return 1
            ;;
    esac
    stat=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ')
    case "$stat" in
        Z*)
            LEADER_STATE=zombie
            log "pid $pid is a zombie (its parent $(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') has not reaped it): not stopping anything"
            return 1
            ;;
    esac
    LEADER_STATE="alive-unverified"
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
    if [ "$form" = new ]; then
        leads=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
        if [ "$leads" != "$pid" ]; then
            log "pid $pid does not lead a process group of its own (pgid '$leads'): not stopping it"
            return 1
        fi
    fi
    LEADER_STATE="alive-verified"
    if [ "$form" = new ]; then
        if GROUP_SNAPSHOT=$(group_members "$pid"); then
            GROUP_SNAPSHOT=$(printf '%s' "$GROUP_SNAPSHOT" | tr '\n' ' ')
        else
            GROUP_SNAPSHOT=""
            GROUP_SNAPSHOT_RC=1
        fi
    fi
    log "stopping $pid ($(describe_pid "$pid"))"
    kill "$pid" 2>/dev/null || true
    i=0
    while [ $i -lt $STOP_WAIT_TENTHS ] && ! run_lock_child_ended "$pid"; do
        sleep 0.1
        i=$((i + 1))
    done
    if ! run_lock_child_ended "$pid"; then
        LEADER_STUCK=1
        log "pid $pid did not exit within $((STOP_WAIT_TENTHS / 10)) s"
        return 1
    fi
    if [ "$DOWN_REAP_PID" = "$pid" ]; then wait "$pid" 2>/dev/null; fi
    state_set "$state" server_pid_stopped "$pid"
    return 0
}

# down_classify <state file> — prints what the lock's record is, against uat-run.state (design
# §2.4): t1 | t0-up-alive | t0-up-dead | old | other | absent.
down_classify() {
    local state=$1 run_id lock_token server_pid
    run_id=$(state_get "$state" run_id)
    lock_token=$(state_get "$state" lock_token)
    server_pid=$(state_get "$state" server_pid)
    run_lock_begin "$(run_lock_dir)"
    lock_obs_owner down-owner "$(run_lock_dir)"
    run_lock_end
    case "$LOB_CLASS" in
        missing)
            echo absent
            ;;
        record)
            if [ -n "$lock_token" ] && [ "$LOB_TOKEN" = "$lock_token" ]; then
                echo t1
            elif [ "$LOB_TOKEN" = "$run_id" ]; then
                if [ -z "$lock_token" ] && [ -z "$LOB_PGID" ] && [ "$LOB_PID" = "$server_pid" ]; then
                    echo old
                elif run_lock_child_ended "$LOB_PID"; then
                    echo t0-up-dead
                else
                    echo t0-up-alive
                fi
            else
                echo other
            fi
            ;;
        *)
            echo other
            ;;
    esac
}

# down_procedure <state file> [<record class>] — what `down` does, and what the failure trap of `up`
# does after the signal (design §2.4 tables C and C′): stop the server and, in the new form, what is
# left of its group when that is shown to be this run's; then release the lock as the head. Sets
# DOWN_STATUS (stopped | stop-refused | stop-refused-group | stop-refused-lock) and DOWN_SERVER_STOPPED.
# "stopped" only when the release answered released or missing. Returns 0 only for stopped.
DOWN_STATUS=""
DOWN_SERVER_STOPPED=0
down_procedure() {
    local state=$1 class=${2:-} run_id lock_token server_pid run_dir form=new members="" p db unverified="" tokens gs
    DOWN_STATUS=stop-refused
    DOWN_SERVER_STOPPED=0
    run_id=$(state_get "$state" run_id)
    lock_token=$(state_get "$state" lock_token)
    server_pid=$(state_get "$state" server_pid)
    run_dir=$(state_get "$state" run_dir)
    [ -n "$class" ] || class=$(down_classify "$state")
    case "$class" in
        t0-up-alive)
            log "up (pid $(run_lock_field "$(run_lock_dir)" pid)) is still running and holds the lock: wait for it to finish, or stop it, then run down again"
            DOWN_STATUS=stop-refused-lock
            return 1
            ;;
        old) form=old ;;
    esac
    if ! stop_recorded "$state" "$form"; then
        if [ "$LEADER_STUCK" -ne 1 ]; then
            DOWN_STATUS=stop-refused
            return 1
        fi
    fi
    if [ "$form" = new ] && [ "$LEADER_STUCK" -ne 1 ] && [ -n "$server_pid" ]; then
        case "$LEADER_STATE" in
            alive-verified)
                if [ "$GROUP_SNAPSHOT_RC" -ne 0 ]; then
                    log "ps cannot say who else is in group $server_pid: only the server was stopped, the lock is kept"
                    DOWN_STATUS=stop-refused-group
                    return 1
                fi
                members=$GROUP_SNAPSHOT
                ;;
            dead)
                gs=$(lock_obs_kill0 group "-$server_pid")
                case "$gs" in
                    gone) ;;
                    alive)
                        if members=$(group_members "$server_pid") && [ -n "$members" ]; then
                            members=$(printf '%s' "$members" | tr '\n' ' ')
                            for p in $members; do
                                db=$(env_value_of "$p" CM_DB_PATH)
                                case "$db" in
                                    "$run_dir"/*) ;;
                                    *) unverified="$unverified $p" ;;
                                esac
                            done
                            if [ -n "$unverified" ]; then
                                log "group $server_pid of the dead server still has:$unverified (CM_DB_PATH not under $run_dir, or not readable): not stopping them, the lock is kept"
                                DOWN_STATUS=stop-refused-group
                                return 1
                            fi
                        else
                            log "group $server_pid of the dead server is not empty and ps cannot say who is in it: the lock is kept"
                            DOWN_STATUS=stop-refused-group
                            return 1
                        fi
                        ;;
                    *)
                        log "group $server_pid of the dead server cannot be shown empty ($gs): the lock is kept"
                        DOWN_STATUS=stop-refused-group
                        return 1
                        ;;
                esac
                ;;
        esac
        # shellcheck disable=SC2086 # pids
        if ! drain_members "$server_pid" $members; then
            log "group $server_pid is not empty after KILL (left: $(group_members "$server_pid" | tr '\n' ' ')): the lock is kept"
            DOWN_STATUS=stop-refused-group
            return 1
        fi
    fi
    DOWN_SERVER_STOPPED=1
    tokens="$run_id"
    [ -z "$lock_token" ] || tokens="$tokens $lock_token"
    # shellcheck disable=SC2086 # the tokens are [A-Za-z0-9-]+
    run_lock_release_as_head $tokens
    case "$RUN_LOCK_RESULT" in
        released | missing)
            DOWN_STATUS=stopped
            return 0
            ;;
        deferred)
            if [ "$LEADER_STUCK" -eq 1 ]; then DOWN_SERVER_STOPPED=0; fi
            log "the lock is kept: its holder (pid $server_pid) or group is still there, or cannot be told"
            ;;
        kept) log "the lock is held by another run (token): this run's server is stopped" ;;
        not-head) log "could not become the head of the lock's queue within 10 s: run down again" ;;
        *) log "the lock's owner cannot be read: the lock is kept (${RUN_LOCK_RESULT:-unknown})" ;;
    esac
    DOWN_STATUS=stop-refused-lock
    return 1
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
    local dir run_dir state form rc=0
    for dir in "$SOCK_BASE"/cmuat-*-*; do
        [ -d "$dir" ] && [ -O "$dir" ] && [ -f "$dir/run-dir" ] || continue
        run_dir=$(cat "$dir/run-dir")
        state="$run_dir/$STATE_NAME"
        log "leftover from an earlier run: $dir (run dir $run_dir)"
        if [ -f "$state" ]; then
            form=new
            [ -n "$(state_get "$state" lock_token)" ] || form=old
            if ! stop_recorded "$state" "$form"; then
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
#   OBSERVED  <sha256|absent>  <path>
#                             opencode V1's two records in ~/.commandmate (#4149).
#                             Reported, never a failure: the run's server is pointed
#                             away from them, and a production server on this machine
#                             keeps writing them, so a change does not say who did it.
#                             isolation.checks is what holds the run's server to it.
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
        for n in "$HOME/.commandmate/opencode-sessions.json" "$HOME/.commandmate/opencode-ports.json"; do
            printf 'OBSERVED  %s  %s\n' "$(sha_of "$n")" "$n"
        done
    }>"$1"
}

# check_shared_record <record file> — 0 when nothing changed, 1 (with one
# message per change) otherwise. An OBSERVED line only sets OBSERVED_CHANGED.
OBSERVED_CHANGED=no
check_shared_record() {
    local kind rest base="" rc=0 h p
    while read -r kind rest; do
        case "$kind" in
            '') ;;
            CODEX_HOME) base="$rest" ;;
            OBSERVED)
                h=${rest%%  *}
                p=${rest#*  }
                if [ "$(sha_of "$p")" != "$h" ]; then
                    log "opencode V1 record changed during the run: $p (not a failure: a production server writes it too)"
                    OBSERVED_CHANGED=yes
                fi
                ;;
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
UP_PHASE=before-go
UP_SERVER_PID=""
UP_CHILD_REAPED=0
UP_GO=""
UP_ACK=""

# Undoes a failed `up`: only what this run made and recorded (design §4.5). Before `go` the server (the
# waiting child) is stopped by pid (before the publish) or by its group (after it) and the lock is
# released by D12; after `go` it is down's own procedure on the record t1, once a server that ended
# by itself has been reaped.
up_on_exit() {
    local rc=$? st sock_dir
    [ "$UP_DONE" -eq 1 ] && return 0
    [ -n "$UP_TOKEN" ] || return 0
    log "up failed (exit $rc): removing what this run made"
    sock_dir=""
    [ -z "$UP_STATE" ] || [ ! -f "$UP_STATE" ] || sock_dir=$(state_get "$UP_STATE" sock_dir)
    if [ "$UP_PHASE" = after-go ]; then
        run_lock_reap_if_ended "$UP_SERVER_PID"
        DOWN_REAP_PID=$UP_SERVER_PID
        down_procedure "$UP_STATE" t1
        if [ "$DOWN_STATUS" = stopped ]; then st=failed; else st=failed-server-left; fi
    else
        if [ -n "$UP_SERVER_PID" ] && [ "$UP_CHILD_REAPED" != 1 ]; then
            if [ -n "$RUN_LOCK_G" ]; then
                lock_stop_gate "$RUN_LOCK_G" "$UP_SERVER_PID"
            else
                kill -s KILL "$UP_SERVER_PID" 2>/dev/null
                wait "$UP_SERVER_PID" 2>/dev/null
            fi
            UP_CHILD_REAPED=1
        fi
        run_lock_release "$UP_TOKEN"
        case "$RUN_LOCK_RESULT" in
            released | missing | none) st=failed ;;
            *) st=failed-lock-left ;;
        esac
    fi
    if [ "$st" = failed-server-left ]; then
        # Our server could not be verified or stopped: keep the lock and the pointer, so `down` / the next run deal with it.
        remove_socket_dir_tmux_only "$sock_dir"
    else
        remove_socket_dir "$sock_dir"
    fi
    if [ -n "$UP_STATE" ] && [ -f "$UP_STATE" ]; then state_set "$UP_STATE" status "$st"; fi
    rm -rf "$UP_GO" "$UP_ACK" 2>/dev/null
    exit "$rc"
}

remove_socket_dir_tmux_only() {
    local sock="$1/tmux.sock"
    [ -n "$1" ] && [ -S "$sock" ] || return 0
    tmux -S "$sock" kill-server 2>/dev/null || true
}

fail_up() { # <message> — says why and ends `up`; the state and the release are up_on_exit's
    log "up: $1"
    exit 1
}

# up_handoff_fail <stage> — a step of the handover failed while this shell lives (table D, UAT column).
# Never waits for the child's own deadline: the KILL is followed by a `wait` that returns at once.
up_handoff_fail() {
    local stage=$1
    if [ "$stage" = abort ]; then
        # `go` was already there: did the child start (ack) or withdraw?
        case "$(run_lock_abort_settle "$UP_SERVER_PID" "$UP_ACK")" in
            acked) stage=abort-acked ;;
            stuck) kill -s KILL "$UP_SERVER_PID" 2>/dev/null ;;
        esac
    fi
    case "$stage" in
        arg | token | group | tmp | mv)
            # before the publish: the child waits alone in its group, signal its pid only
            kill -s KILL "$UP_SERVER_PID" 2>/dev/null
            wait "$UP_SERVER_PID" 2>/dev/null
            UP_CHILD_REAPED=1
            ;;
        verify | verify-unreadable | signal)
            # published, `go` not made: the group only when the leader is alive and leads it (never an unchecked number)
            if [ "$(lock_obs_kill0 pid "$UP_SERVER_PID")" = alive ] &&
                [ "$(lock_obs_pgid handoff-group "$UP_SERVER_PID")" = "$UP_SERVER_PID" ]; then
                kill -s KILL -- "-$UP_SERVER_PID" 2>/dev/null
                wait "$UP_SERVER_PID" 2>/dev/null
                UP_CHILD_REAPED=1
                lock_drain_group "$UP_SERVER_PID" 1
            else
                kill -s KILL "$UP_SERVER_PID" 2>/dev/null
                wait "$UP_SERVER_PID" 2>/dev/null
                UP_CHILD_REAPED=1
            fi
            ;;
        abort)
            # the child withdrew without making ack and ended: reap it
            wait "$UP_SERVER_PID" 2>/dev/null
            UP_CHILD_REAPED=1
            ;;
        abort-acked)
            # the child started: the trap runs down's procedure on t1
            UP_PHASE=after-go
            ;;
    esac
    fail_up "handoff-failed stage=${stage%%-*}"
}

# up_server_ended — 0 when the server has ended (ESRCH or a zombie of this shell, which is reaped here).
up_server_ended() {
    run_lock_child_ended "$UP_SERVER_PID" || return 1
    wait "$UP_SERVER_PID" 2>/dev/null
    UP_CHILD_REAPED=1
    return 0
}

cmd_up() {
    local run_id sock_dir sock tmux_pid db i isolation=1 deadline v
    # --own-home (#3312): appended after CM_UAT_ISOLATION=1 on the server line,
    # so env sets the later value. Empty otherwise (the expansion below is the
    # bash 3.2 `set -u` safe form of an empty array).
    local own_home_env=()
    # Test seams only, set across env -i (empty in production; ${arr[@]+...} is the bash 3.2 form).
    local test_seams=()
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
    # Not a child of another run: a token left in the environment would "inherit" a live run's lock.
    unset CM_RUN_LOCK_TOKEN
    # Before anything is made or started (#3358).
    decide_codex_home || exit 1
    mkdir -p "$RUN_DIR" || exit 1
    RUN_DIR="$(cd "$RUN_DIR" && pwd)"

    run_id="$(date -u +%y%m%d%H%M%S)-$(printf '%04x' $RANDOM)"
    if ! run_lock_acquire uat $$ "$run_id" "$RUN_DIR"; then
        if [ -n "$RUN_LOCK_HOLDER_RUN_DIR" ]; then
            log "$RUN_LOCK_ERROR; stop it with: scripts/uat/run-server.sh down --run-dir $RUN_LOCK_HOLDER_RUN_DIR"
        else
            log "$RUN_LOCK_ERROR"
        fi
        exit 1
    fi
    UP_TOKEN="$run_id"
    UP_PHASE=before-go
    UP_CHILD_REAPED=0
    UP_SERVER_PID=""
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
    # The handover's signal (go) and receipt (ack) are named by this run: a second `up` on the same run dir
    # (after `down`) never meets an earlier run's. Removed and seen absent before the fork, or nothing starts.
    UP_GO="$RUN_DIR/handoff-$run_id.go"
    UP_ACK="$RUN_DIR/handoff-$run_id.ack"
    rm -rf "$UP_GO" "$UP_ACK" 2>/dev/null
    if [ -e "$UP_GO" ] || [ -e "$UP_ACK" ] || [ -L "$UP_GO" ] || [ -L "$UP_ACK" ]; then
        fail_up "handoff-failed stage=arg"
    fi
    deadline=$(($(date +%s) + HANDOFF_WAIT_SEC))
    for v in CM_VERIFY_TEST_HANDOFF CM_VERIFY_TEST_HANDOFF_DIR CM_VERIFY_TEST_OBS_FAULT CM_VERIFY_TEST_OBS_FAULT_FILE; do
        [ -z "${!v+x}" ] || test_seams+=("$v=${!v}")
    done
    # The server is started as the leader of a group of its own (set -m) and waits for `go` before it
    # execs: the lock's owner names that group first (run_lock_set_pid), then the signal is made.
    set -m
    # shellcheck disable=SC2016 # the child's script is single-quoted on purpose: its $1..$5 are the child's
    env -i HOME="$HOME" PATH="$PATH" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/sh}" \
        CODEX_HOME="$CH" LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-xterm-256color}" \
        TMUX="$sock,$tmux_pid,0" \
        NODE_ENV=production CM_PORT="$PORT" CM_BIND=127.0.0.1 CM_UAT_ISOLATION=1 \
        ${own_home_env[@]+"${own_home_env[@]}"} \
        CM_DB_PATH="$RUN_DIR/uat.db" CM_ROOT_DIR="$RUN_DIR/root" \
        CM_OPENCODE_V2_DIR="$RUN_DIR/opencode-v2" CM_AGENT_HOOKS_DIR="$RUN_DIR/hooks" \
        CM_AGENT_ROLE_ARTIFACTS_DIR="$RUN_DIR/agent-roles" \
        CM_OPENCODE_SESSION_FILE="$RUN_DIR/opencode-sessions.json" \
        CM_OPENCODE_PORT_FILE="$RUN_DIR/opencode-ports.json" \
        ${test_seams[@]+"${test_seams[@]}"} \
        nohup /bin/bash -c '. "$1" || exit 75; lock_child_wait "$2" "$3" "$4" "$5" || exit 75; unset CM_VERIFY_TEST_HANDOFF CM_VERIFY_TEST_HANDOFF_DIR CM_VERIFY_TEST_OBS_FAULT CM_VERIFY_TEST_OBS_FAULT_FILE; shift 6; exec "$@"' \
        cm-uat-child "$REPO_ROOT/scripts/lib/machine-lock.sh" "$UP_GO" "$UP_ACK" "$deadline" "$$" -- node "$SERVER_ENTRY" >"$RUN_DIR/server.log" 2>&1 </dev/null &
    UP_SERVER_PID=$!
    set +m
    if ! state_set "$UP_STATE" server_pid "$UP_SERVER_PID" ||
        ! state_set "$UP_STATE" lock_token "$run_id-g$UP_SERVER_PID"; then
        kill -s KILL "$UP_SERVER_PID" 2>/dev/null
        wait "$UP_SERVER_PID" 2>/dev/null
        UP_CHILD_REAPED=1
        fail_up "state-write-failed"
    fi
    run_lock_set_pid "$run_id" "$UP_SERVER_PID" "$UP_SERVER_PID" "$UP_GO" || up_handoff_fail "$RUN_LOCK_STAGE"
    UP_PHASE=after-go

    # Record CM_DB_PATH as the running pid sees it, not as this script meant it.
    db=""
    i=0
    while [ $i -lt 50 ] && [ -z "$db" ]; do
        if up_server_ended; then
            log "the server (pid $UP_SERVER_PID) exited at once; see $RUN_DIR/server.log"
            exit 1
        fi
        db=$(env_value_of "$UP_SERVER_PID" CM_DB_PATH)
        [ -n "$db" ] || sleep 0.1
        i=$((i + 1))
    done
    case "$db" in
        "$RUN_DIR"/*) ;;
        *)
            log "pid $UP_SERVER_PID has CM_DB_PATH='$db', not under $RUN_DIR"
            exit 1
            ;;
    esac
    state_set "$UP_STATE" db_path "$db"
    i=0
    while [ "$WAIT_LISTEN" -gt 0 ] && ! find_listen_pids_by_port "$PORT" | grep -qx "$UP_SERVER_PID"; do
        if up_server_ended; then
            log "the server (pid $UP_SERVER_PID) exited before it listened on $PORT; see $RUN_DIR/server.log"
            exit 1
        fi
        if [ $i -ge $((WAIT_LISTEN * 10)) ]; then
            log "the server (pid $UP_SERVER_PID) did not listen on $PORT within $WAIT_LISTEN s"
            exit 1
        fi
        sleep 0.1
        i=$((i + 1))
    done
    state_set "$UP_STATE" status up
    UP_DONE=1
    trap - EXIT INT TERM
    rm -rf "$UP_GO" "$UP_ACK" 2>/dev/null
    log "up: run $run_id, pid $UP_SERVER_PID, port $PORT, tmux $sock"
}

# ---------------------------------------------------------------------- down

cmd_down() {
    local state sock_dir rc=0
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
    sock_dir=$(state_get "$state" sock_dir)

    if down_procedure "$state"; then
        remove_socket_dir "$sock_dir"
    else
        # The lock stays when the server or its group may still be running (or the lock is another run's).
        if [ "$DOWN_SERVER_STOPPED" -eq 1 ]; then
            remove_socket_dir "$sock_dir"
        else
            remove_socket_dir_tmux_only "$sock_dir"
        fi
        rc=1
    fi
    state_set "$state" status "$DOWN_STATUS"

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
        state_set "$state" opencode_v1_real_changed "$OBSERVED_CHANGED"
    fi
    exit $rc
}

# ------------------------------------------------------------------- cleanup

cmd_cleanup() {
    local token
    token="cleanup-$$-$RANDOM"
    unset CM_RUN_LOCK_TOKEN
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
