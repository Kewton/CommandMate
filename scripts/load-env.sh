#!/bin/bash
#
# CommandMate - .env Loader
# Loads environment variables from .env file
#
# The custom server (node dist/server/server.js) does not support
# Next.js automatic .env loading. This script exports variables
# from .env so they are available to the server process.
#
# Variables already set in the environment are NOT overwritten.
#
# Usage (source from other scripts, which must themselves be bash):
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   source "$SCRIPT_DIR/load-env.sh"
#

# ---------------------------------------------------------------------------
# Shell guard (Issue #2132) — refuse loudly instead of loading nothing quietly
# ---------------------------------------------------------------------------
# This file is bash-only twice over: it resolves its own directory from
# ${BASH_SOURCE[0]}, and it classifies comment lines with bash's [[ ... =~ ]].
# zsh — this repository's default interactive shell — has neither, and, worse,
# fails at neither: ${BASH_SOURCE[0]} expands to the empty string, `dirname ""`
# answers ".", the .env one directory above the project is simply not found, and
# the loop is never entered. The script exports nothing and returns 0.
#
# `#!/bin/bash` above does not protect against this. A shebang selects an
# interpreter for a file that is EXECUTED; `source` reads the file with the
# shell that is already running.
#
# The silence is what makes it expensive. During the Epic #2002 device UAT
# (2026-08-29) a server was started after sourcing this file from zsh, so
# CM_VAPID_PUBLIC_KEY / CM_VAPID_PRIVATE_KEY / CM_VAPID_SUBJECT / CM_DB_PATH /
# CM_ROOT_DIR / CM_PORT / CM_BIND were all absent. Web Push died on every
# device, two UAT rounds were spent on it, and the conclusion nearly reached was
# "the iOS notification replacement is broken".
#
# So the answer to a non-bash shell is a message, not a return code nobody
# checks. An operator who reads it loses ten seconds; one who reads nothing
# loses an afternoon.
if [ -z "${BASH_SOURCE+x}" ]; then
    echo "ERROR: scripts/load-env.sh must be sourced from bash." >&2
    echo "       Your shell does not define BASH_SOURCE (zsh, dash, ...), and this" >&2
    echo "       script needs it to find the project's .env. Sourced from such a" >&2
    echo "       shell it would export NOTHING and still report success, which is" >&2
    echo "       how Issue #2132 started a server with no CM_* variables at all." >&2
    echo "" >&2
    echo "       Use one of these instead:" >&2
    echo "         ./scripts/start.sh --daemon      # start in the background, no build" >&2
    echo "         ./scripts/restart-nobuild.sh     # stop + start in the background, no build" >&2
    echo "         bash -c 'source scripts/load-env.sh && exec <your command>'" >&2
    return 1 2>/dev/null || exit 1
fi

# Determine project directory
_LOAD_ENV_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_LOAD_ENV_PROJECT_DIR="$(dirname "$_LOAD_ENV_SCRIPT_DIR")"

if [ -f "$_LOAD_ENV_PROJECT_DIR/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        # Extract variable name
        var_name="${line%%=*}"
        # Skip if variable is already set in environment
        if [ -z "${!var_name+x}" ]; then
            export "$line"
        fi
    done < "$_LOAD_ENV_PROJECT_DIR/.env"
fi

# Clean up internal variables
unset _LOAD_ENV_SCRIPT_DIR _LOAD_ENV_PROJECT_DIR
