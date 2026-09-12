#!/bin/bash
#
# Stop Server Script
# Stops the production server
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
PID_FILE="$LOG_DIR/server.pid"

# Load .env file (for CM_PORT etc.)
source "$SCRIPT_DIR/load-env.sh"
# find_listen_pids_by_port / print_port_targets (Issue #2473)
source "$SCRIPT_DIR/lib/port-pids.sh"

# Support both CM_PORT and legacy MCBD_PORT
PORT=${CM_PORT:-${MCBD_PORT:-3000}}

# Port number validation (bash built-in pattern matching) [S4-001]
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo 'ERROR: Invalid port number specified in CM_PORT or MCBD_PORT' >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Issue #2488: wait for the process to be GONE, not for the port to go quiet
# ---------------------------------------------------------------------------
# server.ts's gracefulShutdown closes the listening socket FIRST and only then
# waits — up to 3 seconds — for the connections that are still open. `sleep 2`
# followed by a fresh port lookup therefore reports "gone" for a process that is
# still shutting down and still owns logs/server.pid, which is what left
# `build-and-start.sh --daemon` saying `Server is already running` with nothing
# listening on port 3000. Liveness is read from the PIDs we signalled
# (`kill -0`), never from the port — which also keeps Issue #2473's rule, since
# those PIDs came from a LISTEN-only lookup.
#
# Repeated verbatim in stop.sh, start.sh and build-and-start.sh: each of the
# four has to run on its own, and scripts/lib/port-pids.sh answers "who is the
# server on this port", a different question from "is this PID gone yet".

# How long a process that was asked to stop may take to actually exit before it
# is killed outright. Above server.ts's 3-second force-exit, with room for a
# loaded machine.
STOP_GRACE_SECONDS=${CM_STOP_GRACE_SECONDS:-10}
if ! [[ "$STOP_GRACE_SECONDS" =~ ^[0-9]+$ ]] || [ "$STOP_GRACE_SECONDS" -lt 1 ] || [ "$STOP_GRACE_SECONDS" -gt 600 ]; then
    echo 'ERROR: Invalid CM_STOP_GRACE_SECONDS (expected 1-600)' >&2
    exit 1
fi

# still_alive <pid>...
#
# The PIDs that still exist, one per line. Nothing when they are all gone.
still_alive() {
    local pid
    for pid in "$@"; do
        if kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
        fi
    done
}

# wait_for_exit <seconds> <pid>...
#
# Polls every 100ms until every PID is gone or <seconds> elapse, then prints the
# survivors (nothing when they all exited). Always returns 0, so it is safe
# under `set -e` and inside `$(...)`.
wait_for_exit() {
    local seconds=$1
    shift
    local ticks=$(( seconds * 10 ))
    local waited=0
    local remaining
    while :; do
        remaining=$(still_alive "$@")
        if [ -z "$remaining" ] || [ "$waited" -ge "$ticks" ]; then
            break
        fi
        sleep 0.1
        waited=$(( waited + 1 ))
    done
    if [ -n "$remaining" ]; then
        echo "$remaining"
    fi
    return 0
}

echo "=== Stopping server ==="

stopped=false

# Step 1: Port-based stop - kill the process(es) LISTENING on the port (most reliable)
# Listeners only (Issue #2473): a process merely CONNECTED to the port (the
# browser showing CommandMate, another session's CLI) is not the server. The
# cross-platform lookup and the numeric/dedup validation [D1-002] live in
# lib/port-pids.sh.
PIDS=$(find_listen_pids_by_port "$PORT")

if [ -n "$PIDS" ]; then
    echo "Stopping process(es) listening on port $PORT:"
    # Name each target before signalling it; a bare PID identifies nothing
    # once the process is gone.
    print_port_targets "Stopping" $PIDS
    echo "$PIDS" | xargs kill 2>/dev/null  # SIGTERM first

    # SIGKILL fallback [D1-002: || true for REMAINING]
    # Issue #2488: the survivors of the grace period, by PID, not by port.
    REMAINING=$(wait_for_exit "$STOP_GRACE_SECONDS" $PIDS)
    if [ -n "$REMAINING" ]; then
        echo "Force killing remaining:"
        print_port_targets "Force killing" $REMAINING
        echo "$REMAINING" | xargs kill -9 2>/dev/null
        REMAINING=$(wait_for_exit 2 $REMAINING)
        if [ -n "$REMAINING" ]; then
            echo "WARNING: still running after SIGKILL: $(echo $REMAINING | tr '\n' ' ')" >&2
        fi
    fi
    stopped=true
fi

# Step 2: PID file-based stop - kill the npm process from PID file if it exists
if [ -f "$PID_FILE" ]; then
    # PID file validation: first line only, numeric only
    PID=$(cat "$PID_FILE" 2>/dev/null | head -1 | grep -E '^[0-9]+$')
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        echo "Stopping npm process (PID: $PID)"
        # SIGTERM: send to process group for graceful shutdown [D1-006]
        kill -- -$PID 2>/dev/null || kill $PID 2>/dev/null

        # Issue #2488: wait for the PID itself, not a fixed `sleep 2`.
        if [ -n "$(wait_for_exit "$STOP_GRACE_SECONDS" "$PID")" ]; then
            # SIGKILL fallback (existing pattern maintained) [D1-006]
            kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null
            # EPERM warning [S4-004]
            if [ -n "$(wait_for_exit 2 "$PID")" ]; then
                echo 'WARNING: Process could not be stopped (permission denied or other error)' >&2
            fi
        fi
        stopped=true
    fi
    rm -f "$PID_FILE"
fi

# Step 3: Final check - make sure port is free [C2-003]
# At this point SIGTERM->SIGKILL stages already attempted, SIGKILL is justified.
# Issue #2488: this is now a genuine last resort — Steps 1 and 2 returned only
# once the processes they signalled were gone, so anything still listening here
# is a server nobody asked us to stop (a stale orphan from an earlier run).
REMAINING=$(find_listen_pids_by_port "$PORT")
if [ -n "$REMAINING" ]; then
    echo "Cleaning up remaining processes:"
    print_port_targets "Cleaning up" $REMAINING
    echo "$REMAINING" | xargs kill -9 2>/dev/null  # Final check: SIGKILL as last resort
    wait_for_exit 2 $REMAINING > /dev/null
fi

if [ "$stopped" = true ]; then
    echo "✓ Server stopped successfully"
else
    echo "No server process found"
fi
