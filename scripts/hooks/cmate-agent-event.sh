#!/usr/bin/env bash
#
# cmate-agent-event.sh — post a structured agent lifecycle event to CommandMate.
#
# Wired into an agent CLI's own completion hook (Claude Code `Stop`, Codex
# `notify`) so the server learns that a turn ended from the agent itself rather
# than by reading the terminal. See docs/user-guide/agent-event-hooks.md.
#
# Written for bash 3.2 — the version macOS still ships — so no associative
# arrays, `mapfile`, or `${var^^}`.
#
# Exits 0 even when the POST fails: a hook that breaks the agent's session
# because the CommandMate server happens to be down is worse than a missed
# event. Pass --strict to propagate the failure instead.

set -u

PROGRAM_NAME="cmate-agent-event.sh"

usage() {
  cat <<'USAGE'
Usage: cmate-agent-event.sh [options] [JSON]

Options:
  --tool ID          Agent CLI id (default: $CM_AGENT_TOOL, else "claude")
  --event EVENT      stop | notification | session_start (default: "stop")
  --cwd PATH         Agent working directory (default: $CLAUDE_PROJECT_DIR, else $PWD)
  --session-id ID    Opaque agent session id
  --json JSON        Hook payload to read cwd/session/event from
  --stdin-json       Read that payload from stdin instead
  --url URL          Endpoint (default: http://$CM_HOST:$CM_PORT/api/hooks/agent-event)
  --strict           Exit non-zero when the POST fails
  -h, --help         Show this help

Environment:
  CM_HOST            Server host (default: 127.0.0.1)
  CM_PORT            Server port (default: 3000)
  CM_HOOK_URL        Full endpoint URL; overrides CM_HOST/CM_PORT
  CM_AUTH_TOKEN      Sent as "Authorization: Bearer <token>" when set
USAGE
}

die() {
  printf '%s: %s\n' "$PROGRAM_NAME" "$1" >&2
  exit 2
}

# Extract a flat JSON string field. Good enough for the small, machine-generated
# payloads agent CLIs pass; anything richer belongs in the --cwd flag.
json_string_field() {
  printf '%s' "$1" | tr -d '\n' |
    sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# Escape a value for embedding in a JSON string literal.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Map an agent's own event name onto the API vocabulary.
map_event_name() {
  case "$1" in
    Stop|SubagentStop|agent-turn-complete) printf 'stop' ;;
    Notification) printf 'notification' ;;
    SessionStart) printf 'session_start' ;;
    *) printf '' ;;
  esac
}

TOOL="${CM_AGENT_TOOL:-claude}"
EVENT=""
CWD=""
SESSION_ID=""
HOOK_JSON=""
READ_STDIN=0
URL="${CM_HOOK_URL:-}"
STRICT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tool) [ $# -ge 2 ] || die "--tool requires a value"; TOOL="$2"; shift 2 ;;
    --event) [ $# -ge 2 ] || die "--event requires a value"; EVENT="$2"; shift 2 ;;
    --cwd) [ $# -ge 2 ] || die "--cwd requires a value"; CWD="$2"; shift 2 ;;
    --session-id) [ $# -ge 2 ] || die "--session-id requires a value"; SESSION_ID="$2"; shift 2 ;;
    --json) [ $# -ge 2 ] || die "--json requires a value"; HOOK_JSON="$2"; shift 2 ;;
    --url) [ $# -ge 2 ] || die "--url requires a value"; URL="$2"; shift 2 ;;
    --stdin-json) READ_STDIN=1; shift ;;
    --strict) STRICT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    # Codex passes its notify payload as a bare positional argument.
    *) HOOK_JSON="$1"; shift ;;
  esac
done

if [ "$READ_STDIN" -eq 1 ]; then
  HOOK_JSON="$(cat)"
fi

if [ -n "$HOOK_JSON" ]; then
  if [ -z "$EVENT" ]; then
    JSON_EVENT="$(json_string_field "$HOOK_JSON" 'hook_event_name')"
    if [ -z "$JSON_EVENT" ]; then
      JSON_EVENT="$(json_string_field "$HOOK_JSON" 'type')"
    fi
    if [ -n "$JSON_EVENT" ]; then
      EVENT="$(map_event_name "$JSON_EVENT")"
      [ -n "$EVENT" ] || die "unrecognized hook event name: $JSON_EVENT"
    fi
  fi
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(json_string_field "$HOOK_JSON" 'session_id')"
  fi
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(json_string_field "$HOOK_JSON" 'turn-id')"
  fi
fi

[ -n "$EVENT" ] || EVENT="stop"

case "$EVENT" in
  stop|notification|session_start) ;;
  *) die "--event must be one of: stop, notification, session_start (got \"$EVENT\")" ;;
esac

[ -n "$TOOL" ] || die "--tool must not be empty"

if [ -z "$CWD" ]; then
  CWD="${CM_AGENT_CWD:-}"
fi
if [ -z "$CWD" ]; then
  CWD="${CLAUDE_PROJECT_DIR:-}"
fi
if [ -z "$CWD" ] && [ -n "$HOOK_JSON" ]; then
  CWD="$(json_string_field "$HOOK_JSON" 'cwd')"
fi
if [ -z "$CWD" ]; then
  CWD="$PWD"
fi

case "$CWD" in
  /*) ;;
  *) die "--cwd must be an absolute path (got \"$CWD\")" ;;
esac

if [ -z "$URL" ]; then
  URL="http://${CM_HOST:-127.0.0.1}:${CM_PORT:-3000}/api/hooks/agent-event"
fi

BODY="{\"tool\":\"$(json_escape "$TOOL")\""
BODY="$BODY,\"event\":\"$(json_escape "$EVENT")\""
BODY="$BODY,\"cwd\":\"$(json_escape "$CWD")\""
if [ -n "$SESSION_ID" ]; then
  BODY="$BODY,\"sessionId\":\"$(json_escape "$SESSION_ID")\""
fi
BODY="$BODY}"

# Token via --header rather than the command line of a subprocess: argv is world
# readable in `ps` on most systems.
set -- -fsS -X POST -H 'Content-Type: application/json' --max-time "${CM_HOOK_TIMEOUT:-5}"
if [ -n "${CM_AUTH_TOKEN:-}" ]; then
  set -- "$@" -H "Authorization: Bearer ${CM_AUTH_TOKEN}"
fi
set -- "$@" --data-binary "$BODY" "$URL"

if curl "$@" >/dev/null; then
  exit 0
fi

printf '%s: failed to POST %s to %s\n' "$PROGRAM_NAME" "$EVENT" "$URL" >&2
if [ "$STRICT" -eq 1 ]; then
  exit 1
fi
exit 0
