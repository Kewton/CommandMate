#!/bin/bash
#
# CommandMate - Stop Script
# Stops the application
#

APP_NAME="commandmate"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env file (for CM_PORT etc.)
source "$SCRIPT_DIR/load-env.sh"
# find_listen_pids_by_port / print_port_targets (Issue #2473)
source "$SCRIPT_DIR/lib/port-pids.sh"

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
    sleep 2
    REMAINING=$(find_listen_pids_by_port "$PORT")
    if [ -n "$REMAINING" ]; then
      echo "Force killing remaining processes:"
      print_port_targets "Force killing" $REMAINING
      echo "$REMAINING" | xargs kill -9 2>/dev/null
      sleep 1
    fi

    echo "✓ Application stopped"
  else
    echo "Application is not running on port $PORT"
  fi
fi
