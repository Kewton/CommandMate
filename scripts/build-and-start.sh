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
# Support both CM_PORT and legacy MCBD_PORT
PORT=${CM_PORT:-${MCBD_PORT:-3000}}

# Port number validation (bash built-in pattern matching) [S4-001]
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo 'ERROR: Invalid port number specified in CM_PORT or MCBD_PORT' >&2
    exit 1
fi

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

    # Check if already running (PID file-based)
    if [ -f "$PID_FILE" ]; then
        # PID file validation: first line only, numeric only
        OLD_PID=$(cat "$PID_FILE" 2>/dev/null | head -1 | grep -E '^[0-9]+$')
        if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo "Server is already running (PID: $OLD_PID)"
            echo "Use ./scripts/stop-server.sh to stop it first"
            exit 1
        fi
        # PID file is invalid or process has exited -> remove stale PID file
        rm -f "$PID_FILE"
    fi

    # Check if already running (port-based) [D1-004]
    # Detects orphaned processes even when PID file is missing.
    # stop-server.sh Step 1 (port-based stop) can handle this without a PID file.
    PORT_PIDS=$(lsof -ti:$PORT 2>/dev/null | grep -E '^[0-9]+$' | sort -u || true)
    if [ -n "$PORT_PIDS" ]; then
        echo "Port $PORT is already in use by process(es): $(echo $PORT_PIDS | tr '\n' ' ')"
        echo "Use ./scripts/stop-server.sh to stop it first"
        exit 1
    fi

    # Build first (in foreground to see errors)
    echo "=== Building application ==="
    npm run build:all

    echo ""
    echo "=== Starting production server in background ==="

    # Start server in background with nohup
    nohup npm start >> "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    echo $SERVER_PID > "$PID_FILE" && chmod 600 "$PID_FILE"  # [S4-003]

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
