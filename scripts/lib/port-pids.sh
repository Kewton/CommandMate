#!/bin/bash
#
# CommandMate - which process is the server on this port?
#
# Sourced, not executed, by stop.sh / stop-server.sh / start.sh /
# build-and-start.sh / status.sh / health-check.sh:
#
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   source "$SCRIPT_DIR/lib/port-pids.sh"
#
# Issue #2473: only a process that LISTENS on the port is the server.
# `lsof -i:<port>` matches every socket whose local OR remote port is <port>,
# so without `-sTCP:LISTEN` it also returns each process holding a connection
# TO the port: the browser showing CommandMate (Chrome's network service,
# which carries every other tab's traffic too), another session's
# `commandmate wait`, a hook relay's curl. stop.sh sent all of them SIGTERM
# and, two seconds later, SIGKILL, and logged nothing but their PIDs.
#
# .claude/lib/process-utils.sh get_pid_by_port() was already LISTEN-only.
# This file does not depend on it: scripts/ must work without .claude/.
#
# bash 3.2 compatible (macOS /bin/bash).

# find_listen_pids_by_port <port>
#
# Prints the PIDs listening on TCP <port>: one per line, numeric,
# deduplicated [D1-002]. Prints nothing when nobody listens. Always returns 0,
# so it is safe under `set -e` and inside `$(...)`.
#
# lsof (macOS/Linux) -> ss+fuser fallback (WSL2/Linux). The fallback is left
# as it was: `fuser <port>/tcp` names the LOCAL port only, so a process that
# is connected to <port> is not returned there in the first place.
find_listen_pids_by_port() {
    local port=$1
    if command -v lsof &>/dev/null; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true
    elif command -v ss &>/dev/null && command -v fuser &>/dev/null; then
        fuser "$port"/tcp 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
    else
        echo "WARNING: Neither lsof nor ss+fuser available. Cannot find processes by port." >&2
    fi
}

# describe_pid <pid>
#
# The command line of <pid> on one line (tabs and newlines flattened, cut at
# 400 characters), or "command unavailable" when ps cannot say, typically
# because the process exited between the lookup and this call.
describe_pid() {
    local cmd
    cmd=$(ps -ww -o command= -p "$1" 2>/dev/null || true)
    cmd=$(printf '%s' "$cmd" | tr '\t\r\n' '   ' | sed -e 's/^ *//' -e 's/ *$//' | cut -c1-400)
    printf '%s\n' "${cmd:-command unavailable}"
}

# print_port_targets <verb> <pid>...
#
# One line per PID, "<verb> <pid> (<command line>)", e.g.
#   Stopping 31511 (node dist/server/server.js)
# Call it BEFORE sending the signal. Once a process is gone its PID says
# nothing about what it was: Issue #2473 could not tell what 51331 had been.
print_port_targets() {
    local verb=$1 pid
    shift
    for pid in "$@"; do
        echo "$verb $pid ($(describe_pid "$pid"))"
    done
}
