#!/bin/bash
#
# CommandMate - Stop Script
# Stops the application
#

APP_NAME="commandmate"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load .env file (for CM_PORT etc.)
source "$SCRIPT_DIR/load-env.sh"

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

  # Cross-platform PID lookup: lsof (macOS/Linux) -> ss+fuser fallback (WSL2/Linux)
  find_pids_by_port() {
      local port=$1
      if command -v lsof &>/dev/null; then
          lsof -ti:"$port" 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true
      elif command -v ss &>/dev/null && command -v fuser &>/dev/null; then
          fuser "$port"/tcp 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
      else
          echo "WARNING: Neither lsof nor ss+fuser available. Cannot find processes by port." >&2
      fi
  }

  # Safe PID pipeline: validate numeric + deduplicate [D1-002]
  PIDS=$(find_pids_by_port $PORT)

  if [ -n "$PIDS" ]; then
    echo "Stopping process(es) on port $PORT: $(echo $PIDS | tr '\n' ' ')"
    echo "$PIDS" | xargs kill 2>/dev/null

    # SIGTERM -> SIGKILL fallback [D1-002: || true for REMAINING]
    sleep 2
    REMAINING=$(find_pids_by_port $PORT)
    if [ -n "$REMAINING" ]; then
      echo "Force killing remaining processes: $(echo $REMAINING | tr '\n' ' ')"
      echo "$REMAINING" | xargs kill -9 2>/dev/null
      sleep 1
    fi

    echo "✓ Application stopped"
  else
    echo "Application is not running on port $PORT"
  fi
fi
