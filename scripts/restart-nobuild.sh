#!/bin/bash
#
# CommandMate - Restart Without Building (Issue #2132)
#
# Stops the running server and starts it again in the background, WITHOUT
# running a build. This is the canonical way to pick up an .env change, a
# config change, or to revive a crashed server.
#
# Why a separate script from scripts/restart.sh: that one hands over to
# ./scripts/start.sh with no arguments, which runs in the FOREGROUND when PM2 is
# absent. Before this Issue there was no supported way to restart into the
# background without building, so operators reached for either
# `build-and-start.sh --daemon` — which rewrites .next/BUILD_ID and breaks every
# open tab — or a hand-rolled `nohup npm start`, which starts the server with no
# .env at all when `source scripts/load-env.sh` is run from zsh.
#
# Usage:
#   ./scripts/restart-nobuild.sh          # stop, then start in the background
#   ./scripts/restart-nobuild.sh --help
#
# Honours CM_PORT / MCBD_PORT from the environment or .env, exactly as
# stop-server.sh and start.sh do:
#   CM_PORT=3011 ./scripts/restart-nobuild.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

show_help() {
    cat << EOF
CommandMate Restart Script (never builds)

Usage: $(basename "$0") [OPTIONS]

Options:
    -h, --help      Show this help message

Description:
    Restarts the production server in the background without building:
    1. ./scripts/stop-server.sh   — stop by port, then by PID file
    2. ./scripts/start.sh --daemon — start with nohup, no build

    Because nothing is rebuilt, .next/BUILD_ID does not change and browser tabs
    that are already open keep working. Use ./scripts/build-and-start.sh
    --daemon instead when the application code changed.

Examples:
    $(basename "$0")                  # restart on the port from .env
    CM_PORT=3011 $(basename "$0")     # restart the server on port 3011

EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "ERROR: unknown option: $1" >&2
            echo "Run '$(basename "$0") --help' for usage." >&2
            exit 1
            ;;
    esac
    shift
done

echo "=== Restarting CommandMate (no build) ==="

"$SCRIPT_DIR/stop-server.sh"

# stop-server.sh already waits for the port to clear; this covers the kernel's
# own TIME_WAIT on the listening socket before the new process binds it.
sleep 1

exec "$SCRIPT_DIR/start.sh" --daemon
