#!/bin/bash
#
# Build and Start Script
# Initializes database, builds application, and starts the production server
#
# Usage:
#   ./scripts/build-and-start.sh           # Run in foreground
#   ./scripts/build-and-start.sh --daemon  # Run in background (daemon mode)
#   ./scripts/build-and-start.sh -h        # Show help
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"
DATA_DIR="$PROJECT_DIR/data"

# Show help
show_help() {
    cat << EOF
CommandMate Build and Start Script

Usage: $(basename "$0") [OPTIONS]

Options:
    -h, --help      Show this help message
    -d, --daemon    Run server in background (daemon mode)

Description:
    This script performs the following steps:
    1. Creates data directory (if needed)
    2. Initializes database (npm run db:init)
    3. Builds application (npm run build:all)
    4. Starts production server (npm start)

Examples:
    $(basename "$0")           # Build and run in foreground
    $(basename "$0") --daemon  # Build and run in background

EOF
}

# Parse arguments
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    show_help
    exit 0
fi

cd "$PROJECT_DIR"

# Create directories
mkdir -p "$LOG_DIR"
mkdir -p "$DATA_DIR"
chmod 755 "$DATA_DIR"

# Initialize database
echo "=== Initializing database ==="
npm run db:init
echo ""

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
    npm run build:all

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
    npm run build:all

    echo ""
    echo "=== Starting production server ==="
    npm start
fi
