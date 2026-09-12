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
    sleep 2

    # SIGKILL fallback [D1-002: || true for REMAINING]
    REMAINING=$(find_listen_pids_by_port "$PORT")
    if [ -n "$REMAINING" ]; then
        echo "Force killing remaining:"
        print_port_targets "Force killing" $REMAINING
        echo "$REMAINING" | xargs kill -9 2>/dev/null
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
        sleep 2

        # SIGKILL fallback (existing pattern maintained) [D1-006]
        if kill -0 "$PID" 2>/dev/null; then
            kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null
            sleep 1
            # EPERM warning [S4-004]
            if kill -0 "$PID" 2>/dev/null; then
                echo 'WARNING: Process could not be stopped (permission denied or other error)' >&2
            fi
        fi
        stopped=true
    fi
    rm -f "$PID_FILE"
fi

# Wait a moment and verify
sleep 1

# Step 3: Final check - make sure port is free [C2-003]
# At this point SIGTERM->SIGKILL stages already attempted, SIGKILL is justified
REMAINING=$(find_listen_pids_by_port "$PORT")
if [ -n "$REMAINING" ]; then
    echo "Cleaning up remaining processes:"
    print_port_targets "Cleaning up" $REMAINING
    echo "$REMAINING" | xargs kill -9 2>/dev/null  # Final check: SIGKILL as last resort
    sleep 1
fi

if [ "$stopped" = true ]; then
    echo "✓ Server stopped successfully"
else
    echo "No server process found"
fi
