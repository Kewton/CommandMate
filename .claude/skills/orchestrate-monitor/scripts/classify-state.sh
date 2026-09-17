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
#
# The screen markers of steps 2-4 are per CLI (Issue #2606): the payload's
# `cliToolId` picks agy's set for an Antigravity pane and the Claude set for
# everything else. The priority chain itself is the same for every CLI.
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

# Which CLI drew the pane. Chosen here, where the payload is read, rather than
# inside the monitor-lib helpers, so each helper keeps meaning exactly one CLI's
# screen and a new CLI is one more arm below. Anything that is not agy keeps the
# markers this script has always used, so the Claude / Codex readings are
# untouched by construction.
cli_tool=$(ml_json_scalar "$JSON_FILE" cliToolId)
case "$cli_tool" in
  antigravity)
    is_retrying=ml_agy_is_retrying
    has_prompt_marker=ml_agy_has_prompt_marker
    has_gen_anchor=ml_agy_has_gen_anchor
    ;;
  *)
    is_retrying=ml_is_retrying
    has_prompt_marker=ml_has_prompt_marker
    has_gen_anchor=ml_has_gen_anchor
    ;;
esac

# The CLI's own 5xx backoff means the session is still alive: report GENERATING so
# the loop neither intervenes nor advances the idle streak. Ahead of RATE_LIMIT
# because a 429 backoff prints banner wording while still being a live turn.
if "$is_retrying" "$JSON_FILE"; then
  echo GENERATING
  exit 0
fi

# For agy the text marker is what separates a dialog from generation: an open
# agy dialog prints `esc to cancel` on its status row, the same word agy's
# generation anchor reads, so this branch must stay ahead of the next one.
prompt_waiting=$(ml_json_scalar "$JSON_FILE" isPromptWaiting)
session_status=$(ml_json_scalar "$JSON_FILE" sessionStatus)
if [ "$prompt_waiting" = "true" ] || [ "$session_status" = "waiting" ] || "$has_prompt_marker" "$JSON_FILE"; then
  echo PROMPT
  exit 0
fi

if "$has_gen_anchor" "$JSON_FILE"; then
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
