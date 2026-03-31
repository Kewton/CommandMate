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
# Usage (source from other scripts):
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   source "$SCRIPT_DIR/load-env.sh"
#

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
