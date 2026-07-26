#!/usr/bin/env bash
# classify-state — reduce a single `commandmate capture <id> --json` poll to one
# per-poll state token.
#
# Output (stdout): NOT_RUNNING | RATE_LIMIT | GENERATING | PROMPT | IDLE
#
# Signal priority (each learned from the recipe, see SKILL.md § "根拠").
# The order is the fix for Issue #1522 as much as the anchors are: every branch
# below either injects input or suppresses it, so a branch that fires too early
# damages a healthy session.
#   1. isRunning=false        -> NOT_RUNNING (session_not_running)
#   2. own retry backoff      -> GENERATING  (alive; intervening only queues input)
#   3. prompt (waiting/marker)-> PROMPT      (before GENERATING: an approval prompt
#                                             keeps the `esc to interrupt` footer,
#                                             so the reverse order never approves)
#   4. generation anchor      -> GENERATING  (NOT isGenerating, NOT `Xm Ys`)
#   5. rate-limit banner      -> RATE_LIMIT  (last: see below; then send "a", no sleep)
#   6. otherwise              -> IDLE
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

# The CLI's own 5xx backoff means the session is still alive: report GENERATING so
# the loop neither intervenes nor advances the idle streak. Ahead of RATE_LIMIT
# because a 429 backoff prints banner wording while still being a live turn.
if ml_is_retrying "$JSON_FILE"; then
  echo GENERATING
  exit 0
fi

prompt_waiting=$(ml_json_scalar "$JSON_FILE" isPromptWaiting)
session_status=$(ml_json_scalar "$JSON_FILE" sessionStatus)
if [ "$prompt_waiting" = "true" ] || [ "$session_status" = "waiting" ] || ml_has_prompt_marker "$JSON_FILE"; then
  echo PROMPT
  exit 0
fi

if ml_has_gen_anchor "$JSON_FILE"; then
  echo GENERATING
  exit 0
fi

# Checked LAST, and only once generation has been ruled out. A real usage limit
# stops the turn, so banner-ish text on a still-generating frame is by definition
# something the worker is reading or writing (rate-limiter source, the task text)
# rather than a block — and acting on it injects an `a` into a healthy session.
if ml_has_rate_limit "$JSON_FILE"; then
  echo RATE_LIMIT
  exit 0
fi

echo IDLE
