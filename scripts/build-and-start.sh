#!/bin/bash
#
# Build and Start Script
# Runs npm build and starts the production server
#
# Usage:
#   ./scripts/build-and-start.sh           # Run in foreground
#   ./scripts/build-and-start.sh --daemon  # Run in background (daemon mode)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"

cd "$PROJECT_DIR"

# Create logs directory if it doesn't exist
mkdir -p "$LOG_DIR"

# Check for daemon mode
if [ "$1" = "--daemon" ] || [ "$1" = "-d" ]; then
    echo "=== Starting in daemon mode ==="

    # Check if already running
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if kill -0 "$OLD_PID" 2>/dev/null; then
            echo "Server is already running (PID: $OLD_PID)"
            echo "Use ./scripts/stop-server.sh to stop it first"
            exit 1
        fi
    fi

    # Build first (in foreground to see errors)
    echo "=== Building application ==="
    npm run build

    echo ""
    echo "=== Starting production server in background ==="

    # Start server in background with nohup
    nohup npm start >> "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    echo $SERVER_PID > "$PID_FILE"

    # Wait a moment and check if server started
    sleep 3
    if kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "✓ Server started successfully (PID: $SERVER_PID)"
        echo "  Log file: $LOG_FILE"
        echo "  PID file: $PID_FILE"
        echo ""
        echo "To view logs:  tail -f $LOG_FILE"
        echo "To stop:       ./scripts/stop-server.sh"
    else
        echo "✗ Server failed to start. Check logs: $LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
else
    # Foreground mode
    echo "=== Building application ==="
    npm run build

    echo ""
    echo "=== Starting production server ==="
    npm start
fi
