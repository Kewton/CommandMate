#!/bin/bash
#
# CommandMate - Stop Script
# Stops the application
#

APP_NAME="commandmate"

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
  PID=$(lsof -ti:$PORT 2>/dev/null || true)

  if [ -n "$PID" ]; then
    kill "$PID"
    echo "✓ Application stopped (PID: $PID)"
  else
    echo "Application is not running on port $PORT"
  fi
fi
