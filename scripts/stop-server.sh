#!/bin/bash
#
# Stop Server Script
# Stops the production server running on port 3000
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
PID_FILE="$LOG_DIR/server.pid"
PORT=3000

echo "=== Stopping server ==="

stopped=false

# First, kill all processes using the port (most reliable)
PIDS=$(lsof -ti:$PORT 2>/dev/null)

if [ -n "$PIDS" ]; then
    echo "Stopping process(es) on port $PORT: $PIDS"
    echo "$PIDS" | xargs kill -9 2>/dev/null
    stopped=true
fi

# Also kill the npm process from PID file if it exists
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Stopping npm process (PID: $PID)"
        # Kill the process group to ensure all children are killed
        kill -9 -$PID 2>/dev/null || kill -9 $PID 2>/dev/null
        stopped=true
    fi
    rm -f "$PID_FILE"
fi

# Wait a moment and verify
sleep 1

# Final check - make sure port is free
REMAINING=$(lsof -ti:$PORT 2>/dev/null)
if [ -n "$REMAINING" ]; then
    echo "Cleaning up remaining processes: $REMAINING"
    echo "$REMAINING" | xargs kill -9 2>/dev/null
    sleep 1
fi

if [ "$stopped" = true ]; then
    echo "✓ Server stopped successfully"
else
    echo "No server process found"
fi
