#!/usr/bin/env bash
# classify-state — reduce a single `commandmate capture <id> --json` poll to one
# per-poll state token.
#
# Output (stdout): NOT_RUNNING | RATE_LIMIT | GENERATING | PROMPT | IDLE
#
# Signal priority (each learned from the recipe, see SKILL.md § "根拠"):
#   1. isRunning=false            -> NOT_RUNNING (session_not_running)
#   2. rate-limit / credits banner-> RATE_LIMIT  (send "a" immediately, no sleep)
#   3. generation anchor ↓ [0-9]  -> GENERATING  (NOT isGenerating, NOT `Xm Ys`)
#   4. prompt (waiting / marker)  -> PROMPT       (incl. AskUserQuestion)
#   5. otherwise                  -> IDLE
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/monitor-lib.sh"

JSON_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) shift; JSON_FILE=${1:-};;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
  shift
done
if [ -z "$JSON_FILE" ] || [ ! -f "$JSON_FILE" ]; then
  echo "classify-state: --json <file> required" >&2
  exit 2
fi

running=$(ml_json_scalar "$JSON_FILE" isRunning)
if [ "$running" = "false" ]; then
  echo NOT_RUNNING
  exit 0
fi

if ml_has_rate_limit "$JSON_FILE"; then
  echo RATE_LIMIT
  exit 0
fi

if ml_has_gen_anchor "$JSON_FILE"; then
  echo GENERATING
  exit 0
fi

prompt_waiting=$(ml_json_scalar "$JSON_FILE" isPromptWaiting)
session_status=$(ml_json_scalar "$JSON_FILE" sessionStatus)
if [ "$prompt_waiting" = "true" ] || [ "$session_status" = "waiting" ] || ml_has_prompt_marker "$JSON_FILE"; then
  echo PROMPT
  exit 0
fi

echo IDLE
