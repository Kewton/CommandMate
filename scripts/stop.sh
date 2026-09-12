#!/bin/bash
#
# CommandMate - Stop Script
# Stops the application
#

APP_NAME="commandmate"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
PID_FILE="$LOG_DIR/server.pid"

# Load .env file (for CM_PORT etc.)
source "$SCRIPT_DIR/load-env.sh"
# find_listen_pids_by_port / print_port_targets / describe_pid (Issue #2473)
source "$SCRIPT_DIR/lib/port-pids.sh"

# ---------------------------------------------------------------------------
# Issue #2488: wait for the process to be GONE, not for the port to go quiet
# ---------------------------------------------------------------------------
# server.ts's gracefulShutdown closes the listening socket FIRST and only then
# waits — up to 3 seconds — for the connections that are still open (a browser
# tab on the dashboard holds keep-alive sockets with no request in flight). So
# between SIGTERM and exit there is a window in which nobody LISTENS on the port
# and the server process is very much alive, still owning logs/server.pid.
#
# This script used to read that window as "stopped": SIGTERM, `sleep 2`, look
# the port up again, see no listener, print "Application stopped". On
# 2026-09-11 the `./scripts/build-and-start.sh --daemon` chained after it then
# hit `Server is already running (PID: 93368)` and exited 1 BEFORE building, and
# port 3000 was left with no listener at all for three minutes.
#
# Liveness is therefore read from the PIDs we signalled (`kill -0`), never from
# the port. Restricting the wait to those PIDs is also what keeps Issue #2473's
# rule: the list came from a LISTEN-only lookup, so a process that is merely
# CONNECTED to the port is never waited on and never signalled.
#
# still_alive/wait_for_exit are repeated verbatim in stop-server.sh, start.sh
# and build-and-start.sh. Each of the four has to run on its own, and
# scripts/lib/port-pids.sh answers "who is the server on this port", which is a
# different question from "is this PID gone yet".

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

echo "Stopping CommandMate..."

if command -v pm2 &> /dev/null; then
  if pm2 list | grep -q "$APP_NAME"; then
    pm2 stop "$APP_NAME"
    echo "✓ Application stopped"
  else
    echo "Application is not running"
  fi
else
  # If not using PM2, try to find and kill the process
  # Support both CM_PORT and legacy MCBD_PORT
  PORT=${CM_PORT:-${MCBD_PORT:-3000}}

  # Port number validation (bash built-in pattern matching) [S4-001]
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo 'ERROR: Invalid port number specified in CM_PORT or MCBD_PORT' >&2
    exit 1
  fi

  stopped=false

  # Step 1: the process(es) LISTENING on the port.
  # Listeners only (Issue #2473): a process merely CONNECTED to the port (the
  # browser showing CommandMate, another session's CLI) is not the server, and
  # the SIGKILL below leaves it no grace period. The cross-platform lookup and
  # the numeric/dedup validation [D1-002] live in lib/port-pids.sh.
  PIDS=$(find_listen_pids_by_port "$PORT")

  if [ -n "$PIDS" ]; then
    echo "Stopping process(es) listening on port $PORT:"
    # Name each target before signalling it; a bare PID identifies nothing
    # once the process is gone.
    print_port_targets "Stopping" $PIDS
    echo "$PIDS" | xargs kill 2>/dev/null

    # SIGTERM -> SIGKILL fallback [D1-002: || true for REMAINING]
    # Issue #2488: the survivors of the grace period, by PID, not by port.
    REMAINING=$(wait_for_exit "$STOP_GRACE_SECONDS" $PIDS)
    if [ -n "$REMAINING" ]; then
      echo "Force killing remaining processes:"
      print_port_targets "Force killing" $REMAINING
      echo "$REMAINING" | xargs kill -9 2>/dev/null
      REMAINING=$(wait_for_exit 2 $REMAINING)
      if [ -n "$REMAINING" ]; then
        echo "WARNING: still running after SIGKILL: $(echo $REMAINING | tr '\n' ' ')" >&2
      fi
    fi

    stopped=true
  fi

  # Step 2 (Issue #2488): the PID file's `npm start`, the parent of the node the
  # port lookup found. It is not a listener, so Step 1 never saw it, and it is
  # exactly the PID that build-and-start.sh / start.sh read back as "Server is
  # already running". stop-server.sh has had this step since Issue #401; the two
  # stop scripts disagreeing about it is what made /rebuild's failure mode
  # depend on which one the operator happened to run.
  if [ -f "$PID_FILE" ]; then
    # PID file validation: first line only, numeric only
    PID=$(head -1 "$PID_FILE" 2>/dev/null | grep -E '^[0-9]+$')
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      echo "Stopping npm process $PID ($(describe_pid "$PID"))"
      # SIGTERM: send to process group for graceful shutdown [D1-006]
      kill -- -$PID 2>/dev/null || kill $PID 2>/dev/null

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
    # Stale or honoured, the file must not outlive the process it names: a
    # leftover PID file is the other half of `Server is already running`.
    rm -f "$PID_FILE"
  fi

  if [ "$stopped" = true ]; then
    echo "✓ Application stopped"
  else
    echo "Application is not running on port $PORT"
  fi
fi
