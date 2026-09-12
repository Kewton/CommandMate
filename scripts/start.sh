#!/bin/bash
#
# CommandMate - Start Script
# Starts the application using PM2 or direct npm start.
#
# This script NEVER builds. That is its reason to exist next to
# scripts/build-and-start.sh (Issue #2132): restarting a running server to pick
# up an .env change, a config change or a crash must not regenerate .next, and
# `npm run build` writes a new BUILD_ID that breaks every already-open tab.
#
# Usage:
#   ./scripts/start.sh              # foreground (PM2 when available)
#   ./scripts/start.sh --daemon     # background, no build
#   ./scripts/start.sh --help
#

set -e

APP_NAME="commandmate"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"
MAX_LOG_SIZE_MB=10           # Log rotation threshold (MB)
MAX_LOG_GENERATIONS=3        # Number of log generations to keep

show_help() {
    cat << EOF
CommandMate Start Script (never builds)

Usage: $(basename "$0") [OPTIONS]

Options:
    -h, --help      Show this help message
    -d, --daemon    Run server in background (daemon mode), without building

Description:
    Starts the already-built production server.
    1. Loads .env (the custom server does not auto-load it)
    2. Starts \`npm start\` — in the foreground, or with nohup under --daemon

    No build step runs here, so .next/BUILD_ID is left alone and open browser
    tabs survive the restart. Use ./scripts/build-and-start.sh when the code
    changed and a build IS what you want.

Examples:
    $(basename "$0")           # run in foreground (or hand over to PM2)
    $(basename "$0") --daemon  # run in background, no build
    $(basename "$0") -d        # same

Related:
    ./scripts/restart-nobuild.sh   # stop + start --daemon in one command
    ./scripts/build-and-start.sh   # build first, then start
    ./scripts/stop-server.sh       # stop a --daemon server (PID file + port)

EOF
}

# Parse arguments before touching the environment, so --help always answers.
DAEMON_MODE=false
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            show_help
            exit 0
            ;;
        -d|--daemon)
            DAEMON_MODE=true
            ;;
        *)
            echo "ERROR: unknown option: $1" >&2
            echo "Run '$(basename "$0") --help' for usage." >&2
            exit 1
            ;;
    esac
    shift
done

# Load .env file (custom server does not auto-load .env)
source "$SCRIPT_DIR/load-env.sh"
# find_listen_pids_by_port (Issue #2473)
source "$SCRIPT_DIR/lib/port-pids.sh"

# ---------------------------------------------------------------------------
# Issue #2488: a PID that is still alive may be a server on its way OUT
# ---------------------------------------------------------------------------
# server.ts's gracefulShutdown closes the listening socket FIRST and only then
# waits — up to 3 seconds — for the connections that are still open. A stop that
# has just returned can therefore leave the previous `npm start` alive for a
# moment longer, still named by logs/server.pid. The PID-file check below used
# to read that moment as "already running" and exit 1, which under
# `stop.sh && build-and-start.sh --daemon` left port 3000 with no listener at
# all for three minutes on 2026-09-11.
#
# So the check waits for the PID to go, and only calls it a running server if it
# is still there afterwards. A server that really is up outlives the wait and is
# refused exactly as before.
#
# still_alive/wait_for_exit are repeated verbatim in stop.sh, stop-server.sh and
# build-and-start.sh: each of the four has to run on its own, and
# scripts/lib/port-pids.sh answers "who is the server on this port", a different
# question from "is this PID gone yet".

# How long a process that was asked to stop may take to actually exit. Above
# server.ts's 3-second force-exit, with room for a loaded machine.
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

echo "Starting CommandMate..."

if [ "$DAEMON_MODE" = true ]; then
    # ---------------------------------------------------------------------
    # Daemon mode (Issue #2132)
    # ---------------------------------------------------------------------
    # Ported from scripts/build-and-start.sh with the build step removed. The
    # security annotations came with it and must stay: [S4-003] restricts the
    # PID file, [S4-005] the log, [S4-006] refuses to rotate a symlink,
    # [D1-004] catches an orphan that outlived its PID file.
    #
    # The rotation below duplicates build-and-start.sh's rotate_logs rather
    # than sharing it: that file is a script, not a library, and sourcing it to
    # borrow one function would run a build.

    # Support both CM_PORT and legacy MCBD_PORT
    PORT=${CM_PORT:-${MCBD_PORT:-3000}}

    # Port number validation (bash built-in pattern matching) [S4-001]
    if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
        echo 'ERROR: Invalid port number specified in CM_PORT or MCBD_PORT' >&2
        exit 1
    fi

    cd "$PROJECT_DIR"

    # A start that does not build can only start something already built.
    # Saying so by name beats a PID file pointing at a process that died
    # three seconds later with MODULE_NOT_FOUND.
    if [ ! -f "$PROJECT_DIR/dist/server/server.js" ]; then
        echo "ERROR: dist/server/server.js not found — nothing to start." >&2
        echo "       This script never builds. Use ./scripts/build-and-start.sh --daemon once" >&2
        echo "       to produce it, then --daemon here for every later restart." >&2
        exit 1
    fi

    echo "=== Starting in daemon mode (no build) ==="

    mkdir -p "$LOG_DIR"

    # Rotate the log before nohup opens it (safe: nothing is writing yet).
    rotate_logs() {
        [ -f "$LOG_FILE" ] || return 0

        # [S4-006] Symlink guard: refuse to rotate a symbolic link
        if [ -L "$LOG_FILE" ]; then
            echo "WARNING: Log file is a symbolic link, skipping rotation" >&2
            return 1
        fi

        local file_size_bytes
        file_size_bytes=$(wc -c < "$LOG_FILE")
        local max_size_bytes=$((MAX_LOG_SIZE_MB * 1024 * 1024))
        [ "$file_size_bytes" -lt "$max_size_bytes" ] && return 0

        echo "=== Rotating log file ($(( file_size_bytes / 1024 / 1024 ))MB > ${MAX_LOG_SIZE_MB}MB) ==="

        if [ -f "${LOG_FILE}.${MAX_LOG_GENERATIONS}" ]; then
            if [ -L "${LOG_FILE}.${MAX_LOG_GENERATIONS}" ]; then
                echo "WARNING: ${LOG_FILE}.${MAX_LOG_GENERATIONS} is a symbolic link, skipping rotation" >&2
                return 1
            fi
            rm -f "${LOG_FILE}.${MAX_LOG_GENERATIONS}"
        fi

        local i=$((MAX_LOG_GENERATIONS - 1))
        while [ "$i" -ge 1 ]; do
            if [ -f "${LOG_FILE}.${i}" ]; then
                if [ -L "${LOG_FILE}.${i}" ]; then
                    echo "WARNING: ${LOG_FILE}.${i} is a symbolic link, skipping rotation" >&2
                    return 1
                fi
                mv "${LOG_FILE}.${i}" "${LOG_FILE}.$((i + 1))"
            fi
            i=$((i - 1))
        done

        mv "$LOG_FILE" "${LOG_FILE}.1"
        echo "Log rotated: ${LOG_FILE} -> ${LOG_FILE}.1"
    }
    rotate_logs || echo "WARNING: Log rotation failed, continuing with server startup" >&2

    # Check if already running (PID file-based)
    if [ -f "$PID_FILE" ]; then
        # PID file validation: first line only, numeric only
        OLD_PID=$(head -1 "$PID_FILE" 2>/dev/null | grep -E '^[0-9]+$' || true)
        # Issue #2488: give a shutting-down predecessor the grace period before
        # calling it a running server. See the note next to wait_for_exit.
        if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo "Previous server (PID: $OLD_PID) is still exiting, waiting up to ${STOP_GRACE_SECONDS}s..."
            if [ -n "$(wait_for_exit "$STOP_GRACE_SECONDS" "$OLD_PID")" ]; then
                echo "Server is already running (PID: $OLD_PID)"
                echo "Use ./scripts/stop-server.sh to stop it first"
                exit 1
            fi
            echo "Previous server (PID: $OLD_PID) has exited."
        fi
        # PID file is invalid or process has exited -> remove stale PID file
        rm -f "$PID_FILE"
    fi

    # Check if already running (port-based) [D1-004]
    # Detects orphaned processes even when the PID file is missing.
    # Listeners only (Issue #2473): a process that is merely connected to the
    # port is not a server.
    PORT_PIDS=$(find_listen_pids_by_port "$PORT")
    if [ -n "$PORT_PIDS" ]; then
        echo "Port $PORT is already in use by process(es): $(echo $PORT_PIDS | tr '\n' ' ')"
        echo "Use ./scripts/stop-server.sh to stop it first"
        exit 1
    fi

    # Start server in background with nohup
    nohup npm start >> "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    echo $SERVER_PID > "$PID_FILE" && chmod 600 "$PID_FILE"  # [S4-003]

    # Wait a moment for nohup to create the log file, then set permissions
    sleep 1
    chmod 640 "$LOG_FILE" 2>/dev/null || true  # [S4-005]

    # Wait a moment and check if the server survived startup
    sleep 3
    if kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "✓ Server started successfully (PID: $SERVER_PID)"
        echo "  Port:     $PORT"
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

# Check if PM2 is available
elif command -v pm2 &> /dev/null; then
  echo "Using PM2..."

  # Check if already running
  if pm2 list | grep -q "$APP_NAME"; then
    echo "Application is already running!"
    pm2 status "$APP_NAME"
    exit 0
  fi

  # Start with PM2
  pm2 start npm --name "$APP_NAME" -- start

  echo "✓ Application started with PM2"
  echo ""
  echo "Useful commands:"
  echo "  - View logs: pm2 logs $APP_NAME"
  echo "  - Monitor: pm2 monit"
  echo "  - Status: pm2 status"
  echo "  - Stop: ./scripts/stop.sh"
  echo ""
  echo "To enable auto-restart on system boot:"
  echo "  pm2 startup"
  echo "  pm2 save"

else
  echo "PM2 not found, starting directly..."
  echo "Note: Application will run in foreground. Press Ctrl+C to stop."
  echo "      Use --daemon to start in the background instead (no build)."
  echo ""
  npm start
fi
