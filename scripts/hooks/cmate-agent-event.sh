#!/usr/bin/env bash
#
# cmate-agent-event.sh — post a structured agent lifecycle event to CommandMate.
#
# Wired into an agent CLI's own completion hook (Claude Code `Stop`, Codex
# `notify`) so the server learns that a turn ended from the agent itself rather
# than by reading the terminal. See docs/user-guide/agent-event-hooks.md.
#
# **This script is on the critical path for every tool except Claude Code.**
# Issue #1757 measured `type:"http"` handlers against codex, copilot, gemini and
# antigravity and none of the four accept them — codex is the worst case, where
# a single `"type":"http"` entry makes it discard the whole hooks.json and every
# event dies with one line on stderr. So `type:"command"` running this script is
# the only delivery mechanism those tools have, and a word this script refuses
# is a word that tool can never report.
#
# Which is what Issue #1759 fixed here. Before it, `--event` accepted five words
# while the API accepted seven: `pre_tool_use` and `post_tool_use`, added to
# `AGENT_EVENT_TYPES` by #1726, exited 2 rather than posting. `map_event_name`
# also knew only Claude's spellings, so gemini's `BeforeTool` / `AfterAgent`
# family died as "unrecognized hook event name". Both are now complete: seven
# words, and the native spellings of all five push-mode tools.
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
  --event EVENT      stop | notification | session_start | user_prompt_submit |
                     session_end | pre_tool_use | post_tool_use (default: "stop")
  --cwd PATH         Agent working directory (default: $CLAUDE_PROJECT_DIR, else $PWD)
  --session-id ID    Opaque agent session id
  --worktree-id ID   CommandMate worktree id; skips cwd-based resolution
  --instance-id ID   Agent instance id; without it the event lands on the primary
  --detail TEXT      Event subtype; without it, read from the payload
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
#
# The spellings come from Issue #1757's live capture of all four tools
# (docs/design/agent-hooks-phase4-live-verification.md §8.1) and #1721's of
# Claude. Three dialects share this function because a single relay serves every
# tool; a name that is not below is refused rather than guessed at, so a tool
# whose vocabulary grows fails loudly instead of filing an unknown event under
# something adjacent.
#
# Deliberately absent: `PreInvocation` / `PostInvocation` (antigravity),
# `BeforeModel` / `AfterModel` / `PreCompress` (gemini), `PreCompact` /
# `PostCompact` / `SubagentStart` (codex). They are real events with no word in
# AGENT_EVENT_TYPES, and inventing one for them here would put a meaning in the
# API that no consumer agreed to.
map_event_name() {
  case "$1" in
    # Claude Code / codex / copilot / antigravity — the CamelCase dialect.
    # (antigravity never reaches this function from a payload: its payloads carry
    # no event name at all, so its hooks must pass --event. #1757 R2.)
    Stop|SubagentStop|agent-turn-complete) printf 'stop' ;;
    Notification) printf 'notification' ;;
    SessionStart) printf 'session_start' ;;
    SessionEnd) printf 'session_end' ;;
    UserPromptSubmit) printf 'user_prompt_submit' ;;
    PreToolUse) printf 'pre_tool_use' ;;
    PostToolUse) printf 'post_tool_use' ;;
    # gemini renames four of the seven. The table is the CLI's own, read out of
    # `gemini hooks migrate --from-claude` rather than guessed (#1757 §5.3.1).
    BeforeAgent) printf 'user_prompt_submit' ;;
    AfterAgent) printf 'stop' ;;
    BeforeTool) printf 'pre_tool_use' ;;
    AfterTool) printf 'post_tool_use' ;;
    *) printf '' ;;
  esac
}

# The event's subtype, where it has one. Each event spells it differently and
# none of them share a field. Notification is judged on notification_type, never
# on the human-facing "message" (Issue #1721, D3).
#
# pre_tool_use / post_tool_use carry `tool_name`, which is what the receiver
# stores as the detail and what a matcher is tested against (Issue #1726).
detail_field_for_event() {
  case "$1" in
    notification) printf 'notification_type' ;;
    session_end) printf 'reason' ;;
    session_start) printf 'source' ;;
    pre_tool_use|post_tool_use) printf 'tool_name' ;;
    *) printf '' ;;
  esac
}

TOOL="${CM_AGENT_TOOL:-claude}"
EVENT=""
CWD=""
SESSION_ID=""
WORKTREE_ID=""
INSTANCE_ID=""
DETAIL=""
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
    --worktree-id) [ $# -ge 2 ] || die "--worktree-id requires a value"; WORKTREE_ID="$2"; shift 2 ;;
    --instance-id) [ $# -ge 2 ] || die "--instance-id requires a value"; INSTANCE_ID="$2"; shift 2 ;;
    --detail) [ $# -ge 2 ] || die "--detail requires a value"; DETAIL="$2"; shift 2 ;;
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
  # Session id spellings, in preference order. `session_id` covers Claude,
  # codex, copilot and gemini; `conversationId` is antigravity's protojson name
  # for the same thing (#1757 R4). The two turn-ids are last because they
  # identify a turn rather than a session and are only worth sending when
  # nothing better exists: `turn_id` is codex's, `turn-id` predates #1757 and is
  # kept so a hook configured against an older release keeps working.
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(json_string_field "$HOOK_JSON" 'session_id')"
  fi
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(json_string_field "$HOOK_JSON" 'conversationId')"
  fi
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(json_string_field "$HOOK_JSON" 'turn_id')"
  fi
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(json_string_field "$HOOK_JSON" 'turn-id')"
  fi
fi

[ -n "$EVENT" ] || EVENT="stop"

# All seven words of AGENT_EVENT_TYPES. Kept in the same order as
# src/lib/hooks/agent-event-types.ts so the two are read side by side; a word
# missing here is a word the API accepts and the relay silently cannot send.
case "$EVENT" in
  stop|notification|session_start|user_prompt_submit|session_end|pre_tool_use|post_tool_use) ;;
  *) die "--event must be one of: stop, notification, session_start, user_prompt_submit, session_end, pre_tool_use, post_tool_use (got \"$EVENT\")" ;;
esac

if [ -z "$DETAIL" ] && [ -n "$HOOK_JSON" ]; then
  DETAIL_FIELD="$(detail_field_for_event "$EVENT")"
  if [ -n "$DETAIL_FIELD" ]; then
    DETAIL="$(json_string_field "$HOOK_JSON" "$DETAIL_FIELD")"
  fi
fi

# antigravity nests the tool name under `toolCall.name` and has no `tool_name`
# at all (#1757 R3: its payload is camelCase protojson throughout). Only
# consulted when the flat field produced nothing, so no other tool's payload can
# reach it.
if [ -z "$DETAIL" ] && [ -n "$HOOK_JSON" ]; then
  case "$EVENT" in
    pre_tool_use|post_tool_use) DETAIL="$(json_string_field "$HOOK_JSON" 'name')" ;;
  esac
fi

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
# Correlation keys are omitted when unset rather than sent empty: the receiver
# falls back to resolving the worktree from cwd and to the primary instance,
# which is exactly what a hand-configured hook from Issue #1549 wants.
if [ -n "$WORKTREE_ID" ]; then
  BODY="$BODY,\"worktreeId\":\"$(json_escape "$WORKTREE_ID")\""
fi
if [ -n "$INSTANCE_ID" ]; then
  BODY="$BODY,\"instanceId\":\"$(json_escape "$INSTANCE_ID")\""
fi
if [ -n "$DETAIL" ]; then
  BODY="$BODY,\"detail\":\"$(json_escape "$DETAIL")\""
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
