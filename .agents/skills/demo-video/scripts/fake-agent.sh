#!/usr/bin/env bash
#
# fake-agent.sh — replay a captured agent cassette inside a tmux pane.
#
# The demo drives CommandMate's *real* status detection: the pane content this
# script paints is what `tmux capture-pane` returns, so status-detector.ts, the
# response poller and the sidebar all run unmodified. Nothing is mocked; only
# the LLM is replaced by a deterministic recording.
#
# Usage: fake-agent.sh <cassette> [--speed N] [--once] [--dry-run]
#
# bash 3.2 compatible: no associative arrays, no mapfile, no `local -n`.

set -u

SPEED="1.0"
LOOP=1
DRY_RUN=0
CASSETTE=""
SESSION=""
SESSION_CWD="$PWD"

# Matches TUI_PANE_WIDTH / TUI_PANE_HEIGHT (src/config/tmux-pane-config.ts). The
# server force-reconciles adopted sessions to this geometry, so creating the
# pane at the same size keeps it from being reshaped mid-take.
PANE_WIDTH=200
PANE_HEIGHT=1000

die() {
  printf 'fake-agent: %s\n' "$1" >&2
  exit 2
}

usage() {
  cat <<'USAGE'
Usage: fake-agent.sh <cassette> [--speed N] [--once] [--dry-run]
       fake-agent.sh <cassette> --session <tmux-name> [--cwd DIR] [--speed N]

  --speed N       divide every delay by N (2.0 = twice as fast). Must be > 0.
  --once          stop after one pass instead of looping back to the idle frame.
  --dry-run       emit a schedule trace on stderr and never sleep. Payloads are
                  still written to stdout, so the trace and the bytes can both
                  be asserted without depending on wall-clock timing.
  --session NAME  create a detached tmux session running this script, and exit.
                  Use CommandMate's own name, `mcbd-claude-<worktreeId>`, so the
                  server adopts the session instead of starting a real CLI.
  --cwd DIR       working directory for --session (default: current directory).

Cassette rows are "<delayMs>|@input <TAB> <payload>"; `#` rows and blank rows
are ignored. Payloads go through `printf %b`, and `{{INPUT}}` is replaced with
the last line read from stdin.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --speed)
      [ $# -ge 2 ] || die "--speed needs a value"
      SPEED="$2"
      shift 2
      ;;
    --speed=*)
      SPEED="${1#--speed=}"
      shift
      ;;
    --once)
      LOOP=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --session)
      [ $# -ge 2 ] || die "--session needs a value"
      SESSION="$2"
      shift 2
      ;;
    --cwd)
      [ $# -ge 2 ] || die "--cwd needs a value"
      SESSION_CWD="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [ -z "$CASSETTE" ] || die "only one cassette may be given (got '$CASSETTE' and '$1')"
      CASSETTE="$1"
      shift
      ;;
  esac
done

[ -n "$CASSETTE" ] || { usage >&2; die "no cassette given"; }
[ -f "$CASSETTE" ] || die "cassette not found: $CASSETTE"

case "$SPEED" in
  ''|*[!0-9.]*|.|*.*.*) die "--speed must be a positive number, got '$SPEED'" ;;
esac
if [ "$(awk -v s="$SPEED" 'BEGIN { print (s > 0) ? 1 : 0 }')" != "1" ]; then
  die "--speed must be greater than 0, got '$SPEED'"
fi

if [ -n "$SESSION" ]; then
  command -v tmux >/dev/null 2>&1 || die "tmux not found"
  [ -d "$SESSION_CWD" ] || die "--cwd is not a directory: $SESSION_CWD"
  case "$SESSION" in
    *[!a-zA-Z0-9_-]*) die "session name must match [a-zA-Z0-9_-]+ (CommandMate's SESSION_NAME_PATTERN), got '$SESSION'" ;;
  esac
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    die "tmux session already exists: $SESSION"
  fi
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  CASSETTE_ABS="$(cd "$(dirname "$CASSETTE")" && pwd)/$(basename "$CASSETTE")"
  if [ "$LOOP" -eq 1 ]; then
    tmux new-session -d -s "$SESSION" -c "$SESSION_CWD" -x "$PANE_WIDTH" -y "$PANE_HEIGHT" \
      "$SELF" "$CASSETTE_ABS" --speed "$SPEED"
  else
    tmux new-session -d -s "$SESSION" -c "$SESSION_CWD" -x "$PANE_WIDTH" -y "$PANE_HEIGHT" \
      "$SELF" "$CASSETTE_ABS" --speed "$SPEED" --once
  fi
  printf '%s\n' "$SESSION"
  exit 0
fi

TAB="$(printf '\t')"

# Fail loudly on a comment-only cassette instead of spinning in a no-op loop.
ROW_COUNT=$(awk '!/^[[:space:]]*#/ && NF { n++ } END { print n + 0 }' "$CASSETTE")
[ "$ROW_COUNT" -gt 0 ] || die "cassette has no playable rows: $CASSETTE"

# CommandMate types into the pane and the tty echoes it wherever the cursor
# happens to sit, smearing the TUI box. We repaint the composer ourselves, so
# the raw echo is suppressed.
if [ -t 0 ]; then
  stty -echo 2>/dev/null || true
  trap 'stty echo 2>/dev/null || true' EXIT
fi

LAST_INPUT=""

emit() {
  # Expand the cassette's escapes FIRST, then splice the captured message in as
  # literal text. Substituting first would let a message containing `\e[…` or a
  # `%` directive reach printf and repaint the pane with sequences the cassette
  # never authored.
  # The `_` sentinel survives command substitution's trailing-newline stripping.
  emit_expanded="$(printf '%b_' "$1")"
  emit_expanded="${emit_expanded%_}"
  printf '%s' "${emit_expanded//\{\{INPUT\}\}/$LAST_INPUT}"
}

# Returns 1 when stdin closed while waiting for a message, so callers stop
# instead of repainting the composer with a stale line.
play_once() {
  local step=0
  local delay payload scaled
  # The cassette is read on fd 3: fd 0 has to stay attached to the pane so
  # `@input` rows can read what CommandMate sent.
  while IFS="$TAB" read -r delay payload <&3 || [ -n "$delay" ]; do
    case "$delay" in
      ''|'#'*) continue ;;
    esac
    step=$((step + 1))

    if [ "$delay" = "@input" ]; then
      [ "$DRY_RUN" -eq 1 ] && printf 'trace step=%d kind=input\n' "$step" >&2
      IFS= read -r LAST_INPUT || return 1
      emit "$payload"
      continue
    fi

    case "$delay" in
      *[!0-9]*) die "row $step: delay must be @input or an integer ms, got '$delay'" ;;
    esac

    scaled=$(awk -v d="$delay" -v s="$SPEED" 'BEGIN { printf "%d", (d / s) + 0.5 }')
    if [ "$DRY_RUN" -eq 1 ]; then
      printf 'trace step=%d kind=sleep ms=%s\n' "$step" "$scaled" >&2
    else
      sleep "$(awk -v ms="$scaled" 'BEGIN { printf "%.3f", ms / 1000 }')"
    fi
    emit "$payload"
  done 3<"$CASSETTE"
  return 0
}

while :; do
  play_once || exit 0
  [ "$LOOP" -eq 1 ] || break
done
