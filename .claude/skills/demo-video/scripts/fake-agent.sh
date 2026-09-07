#!/usr/bin/env bash
#
# fake-agent.sh — replay a captured agent cassette inside a tmux pane.
#
# The demo drives CommandMate's *real* status detection: the pane content this
# script paints is what `tmux capture-pane` returns, so status-detector.ts, the
# response poller and the sidebar all run unmodified. Nothing is mocked; only
# the LLM is replaced by a deterministic recording.
#
# Issue #2380 widened it from one Claude pane to one pane per tool: `--tool`
# derives CommandMate's own session name and pane geometry for any of the CLI
# tools, `--idle-only` holds a boot screen for the tools that are present but
# never prompted, `@exec` rows let a cassette really run `commandmate …` (so a
# delegation round trip goes through the product's send → wait → History code
# with only the LLM replaced), and `@transcript` rows append the agent's own
# transcript records at the moment the turn happens, so the transcript readers
# write the reply into History as Markdown instead of the poller scraping the
# pane as raw text.
#
# Usage: fake-agent.sh <cassette> [--speed N] [--once] [--dry-run]
#
# bash 3.2 compatible: no associative arrays, no mapfile, no `local -n`.

set -u

# bash 5.2 turned `patsub_replacement` on by default: in `${var//pat/$rep}` an
# unquoted `&` in the replacement becomes the matched text and a backslash
# quotes it, so a message carrying `\` or `&` was mangled on its way into the
# pane echo and the transcript — measured on CI (ubuntu, bash 5.2): `\\`
# collapsed to `\` and the JSON line no longer parsed. Quoting the replacement
# is not the fix: bash 3.2 keeps the quote characters. With the option off the
# replacement is literal on every version from 3.2 up; the option does not
# exist before 5.2, hence the silenced failure.
shopt -u patsub_replacement 2>/dev/null || true

SPEED="1.0"
LOOP=1
DRY_RUN=0
CASSETTE=""
SESSION=""
SESSION_CWD="$PWD"
RECORD_TO=""
# Seconds an `@input` row keeps reading after its first line before deciding the
# submission is over. Whole seconds because bash 3.2's `read -t` takes no
# fraction. 0 turns draining off, which is what a fixture wants when it queues
# several *distinct* submissions on one pipe.
INPUT_SETTLE=1
# Issue #2380. Which CLI tool this pane impersonates. Decides the session name
# (`mcbd-<tool>-<worktreeId>`) and the pane geometry; empty means "claude, or
# whatever the --session name says".
TOOL=""
WORKTREE_ID=""
IDLE_ONLY=0
INNER_REPLAY=0
# `CM_PORT` for `@exec` rows: the demo server's port, so a `commandmate …` run
# from inside the pane dials the isolated instance and never the developer's.
PORT=""
# The transcript file `@transcript` rows append to (absolute path).
TRANSCRIPT=""
# What the word `commandmate` at the head of an `@exec` row runs. The default
# is the binary on PATH; demo-video.sh points it at the checkout's own CLI
# (`node_modules/.bin/tsx src/cli/index.ts`) so no global install is needed.
COMMANDMATE_CMD="commandmate"

# Mirror of CLI_TOOL_IDS (src/lib/cli-tools/types.ts). fake-agent.test.ts pins
# the two lists against each other, so a ninth tool fails there rather than
# silently getting claude's geometry here.
KNOWN_TOOLS="claude codex gemini vibe-local opencode copilot antigravity command-code"

# Matches TUI_PANE_WIDTH / TUI_PANE_HEIGHT (src/config/tmux-pane-config.ts). The
# server force-reconciles adopted sessions to this geometry, so creating the
# pane at the same size keeps it from being reshaped mid-take.
PANE_WIDTH=200
PANE_HEIGHT=1000
# opencode is the one tool sized differently: OPENCODE_PANE_WIDTH (80 — wider
# than 120 paints a sidebar into every captured row, #2047) and
# OPENCODE_PANE_HEIGHT (200, an alternate-screen tool with no scrollback).
OPENCODE_PANE_WIDTH=80
OPENCODE_PANE_HEIGHT=200

die() {
  printf 'fake-agent: %s\n' "$1" >&2
  exit 2
}

usage() {
  cat <<'USAGE'
Usage: fake-agent.sh <cassette> [--speed N] [--once] [--dry-run]
       fake-agent.sh <cassette> --session <tmux-name> [--cwd DIR] [--speed N]
                     [--record-to FILE]
       fake-agent.sh <cassette> --tool <id> --worktree <worktreeId> [--cwd DIR]
                     [--idle-only] [--port N] [--transcript FILE] [--record-to FILE]

  --speed N       divide every delay by N (2.0 = twice as fast). Must be > 0.
  --once          stop after one pass instead of looping back to the idle frame.
  --dry-run       emit a schedule trace on stderr and never sleep. Payloads are
                  still written to stdout, so the trace and the bytes can both
                  be asserted without depending on wall-clock timing. `@exec`
                  rows are traced and NOT run.
  --session NAME  create a detached tmux session running this script, and exit.
                  Use CommandMate's own name, `mcbd-<tool>-<worktreeId>`, so the
                  server adopts the session instead of starting a real CLI.
  --tool ID       which CLI tool this pane impersonates (claude, codex, opencode,
                  antigravity, command-code, …). With --worktree and no
                  --session the name is derived as `mcbd-<tool>-<worktreeId>`;
                  with --session the name must start with `mcbd-<tool>-`.
                  Also picks the pane geometry (opencode 80x200, others
                  200x1000). Default: claude, or the tool named by --session.
  --worktree ID   the worktree id the derived session name is for.
  --idle-only     play the rows before the first @input and then hold that
                  screen: input is swallowed and the idle rows repainted. For
                  the tools that are present in the roster but never prompted.
  --cwd DIR       working directory for --session (default: current directory).
  --port N        CM_PORT handed to `@exec` rows (the demo server's port).
  --transcript F  the transcript file `@transcript` rows append to.
  --commandmate C what the word `commandmate` in an @exec row runs (default:
                  the `commandmate` on PATH; may be several words).
  --record-to F   append the created session name to F, one per line. env-down.sh
                  kills what it finds there, so teardown never has to guess a
                  name pattern — it stops exactly what was started.
  --input-settle N  seconds an @input row keeps reading after its first line, to
                  take a multi-line message as one submission (default 1; 0 off).

Cassette rows are "<delayMs>|@input|@exec|@transcript|@hook <TAB> <payload>";
`#` rows and blank rows are ignored. Payloads of delay and @input rows go through
`printf %b`. `{{INPUT}}` is replaced with the last line read from stdin,
`{{TASK}}` with the first line of the pass — a cassette that answers a mid-run
approval prompt still has to echo the original instruction afterwards, not the
"y" that cleared the prompt — and `{{WORKTREE}}` with --worktree.
`@exec <TAB> commandmate …` runs that command in the pane's cwd and streams its
output to the pane; only commands whose first word is `commandmate`, with no
shell operators, are accepted, and a cassette carrying anything else is refused
before the first row plays. `@transcript <TAB> <template>` appends the
template's lines (relative to the cassette) to --transcript, replacing
`{{NOW}}` `{{TURN}}` `{{SESSION_ID}}` `{{CWD}}` `{{WORKTREE}}` `{{MESSAGE}}`
`{{EXEC_OUTPUT}}` `{{INPUT}}` `{{TASK}}` — the text ones JSON-escaped, since
they land inside JSON strings. `@hook <TAB> UserPromptSubmit|Stop|SessionStart|
SessionEnd` posts that lifecycle hook to the demo server (--port) the way the
real CLI's injected hook does, carrying --tool, --worktree, the session id
from --transcript's name and the pane's cwd; without --port it is skipped.
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
    --tool)
      [ $# -ge 2 ] || die "--tool needs a value"
      TOOL="$2"
      shift 2
      ;;
    --worktree)
      [ $# -ge 2 ] || die "--worktree needs a value"
      WORKTREE_ID="$2"
      shift 2
      ;;
    --idle-only)
      IDLE_ONLY=1
      shift
      ;;
    --inner)
      # Set by the --session launcher on the command it puts in the pane: the
      # replay runs here, and --tool / --worktree name nothing to create.
      INNER_REPLAY=1
      shift
      ;;
    --port)
      [ $# -ge 2 ] || die "--port needs a value"
      PORT="$2"
      shift 2
      ;;
    --transcript)
      [ $# -ge 2 ] || die "--transcript needs a value"
      TRANSCRIPT="$2"
      shift 2
      ;;
    --commandmate)
      [ $# -ge 2 ] || die "--commandmate needs a value"
      COMMANDMATE_CMD="$2"
      shift 2
      ;;
    --cwd)
      [ $# -ge 2 ] || die "--cwd needs a value"
      SESSION_CWD="$2"
      shift 2
      ;;
    --record-to)
      [ $# -ge 2 ] || die "--record-to needs a value"
      RECORD_TO="$2"
      shift 2
      ;;
    --input-settle)
      [ $# -ge 2 ] || die "--input-settle needs a value"
      case "$2" in
        ''|*[!0-9]*) die "--input-settle must be a whole number of seconds, got '$2'" ;;
      esac
      INPUT_SETTLE="$2"
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

if [ -n "$PORT" ]; then
  case "$PORT" in
    ''|*[!0-9]*) die "--port must be an integer, got '$PORT'" ;;
  esac
  # The same refusal env-up.sh / env-down.sh / record-scenes.ts make: a
  # `commandmate` run from a cassette must never dial the developer's live
  # instance.
  [ "$PORT" -ne 3000 ] || die "--port must not be 3000: that is the default CommandMate port and a live instance would be driven by the cassette"
fi

if [ -n "$WORKTREE_ID" ]; then
  case "$WORKTREE_ID" in
    *[!a-zA-Z0-9_-]*) die "--worktree must match [a-zA-Z0-9_-]+, got '$WORKTREE_ID'" ;;
  esac
fi

# ---------------------------------------------------------------- tool -------

is_known_tool() {
  local candidate
  for candidate in $KNOWN_TOOLS; do
    [ "$candidate" = "$1" ] && return 0
  done
  return 1
}

# The tool a `mcbd-<tool>-<worktreeId>` name is about. Tool ids contain `-`
# (`command-code`, `vibe-local`), so the prefix is matched against the known
# list, longest id first, rather than split at the second `-`.
tool_of_session() {
  local candidate best=""
  for candidate in $KNOWN_TOOLS; do
    case "$1" in
      "mcbd-$candidate-"*)
        if [ "${#candidate}" -gt "${#best}" ]; then best="$candidate"; fi
        ;;
    esac
  done
  printf '%s' "$best"
}

if [ -n "$TOOL" ]; then
  is_known_tool "$TOOL" || die "--tool must be one of: $KNOWN_TOOLS (got '$TOOL')"
fi

if [ "$INNER_REPLAY" -eq 1 ]; then
  [ -z "$SESSION" ] || die "--inner and --session are exclusive"
elif [ -n "$SESSION" ]; then
  case "$SESSION" in
    *[!a-zA-Z0-9_-]*) die "session name must match [a-zA-Z0-9_-]+ (CommandMate's SESSION_NAME_PATTERN), got '$SESSION'" ;;
  esac
  if [ -n "$TOOL" ]; then
    case "$SESSION" in
      "mcbd-$TOOL-"*) : ;;
      *) die "--session '$SESSION' is not a $TOOL session: CommandMate names them mcbd-$TOOL-<worktreeId> (getSessionName), and a $TOOL cassette in another tool's pane is read by the wrong detector" ;;
    esac
  else
    TOOL="$(tool_of_session "$SESSION")"
  fi
elif [ -n "$TOOL" ] && [ -n "$WORKTREE_ID" ]; then
  SESSION="mcbd-$TOOL-$WORKTREE_ID"
elif [ -n "$TOOL" ] && [ -z "$WORKTREE_ID" ] && [ -n "$RECORD_TO" ]; then
  die "--tool needs --worktree (or --session) to derive the session name"
fi
[ -n "$TOOL" ] || TOOL="claude"

if [ "$TOOL" = "opencode" ]; then
  PANE_WIDTH="$OPENCODE_PANE_WIDTH"
  PANE_HEIGHT="$OPENCODE_PANE_HEIGHT"
fi

[ -z "$RECORD_TO" ] || [ -n "$SESSION" ] || die "--record-to only means anything together with --session (or --tool with --worktree)"

# --------------------------------------------------------- validation --------

TAB="$(printf '\t')"

# Fail loudly on a comment-only cassette instead of spinning in a no-op loop.
ROW_COUNT=$(awk '!/^[[:space:]]*#/ && NF { n++ } END { print n + 0 }' "$CASSETTE")
[ "$ROW_COUNT" -gt 0 ] || die "cassette has no playable rows: $CASSETTE"

# Whether an `@exec` command is one this replayer will run (Issue #2380).
#
# Two conditions, both necessary. The first word must be exactly `commandmate`:
# the row exists so a Claude cassette can really run `commandmate ask …`, and
# nothing else has a reason to be executed out of a fixture file. And the text
# must carry no shell operator — `;` `&` `|` backticks `$` `<` `>` `(` `)` and a
# newline — because the command is word-split with the shell's quoting rules
# and any of those would let `commandmate ask … ; rm -rf …` pass the first
# check. `{{…}}` placeholders are allowed; what they expand to is checked
# again at run time, after expansion.
exec_allowed() {
  case "$1" in
    'commandmate') return 0 ;;
    'commandmate '*) : ;;
    *) return 1 ;;
  esac
  case "$1" in
    *';'*|*'&'*|*'|'*|*'`'*|*'$'*|*'<'*|*'>'*|*'('*|*')'*) return 1 ;;
  esac
  return 0
}

# Every @exec / @transcript row is checked before the first row plays: a
# cassette that would be refused mid-take is refused now, while there is no
# server and no recording to lose.
validate_cassette() {
  local row=0 kind payload
  while IFS="$TAB" read -r kind payload || [ -n "$kind" ]; do
    case "$kind" in
      ''|'#'*) continue ;;
    esac
    row=$((row + 1))
    case "$kind" in
      '@exec')
        exec_allowed "$payload" \
          || die "row $row: @exec may only run 'commandmate …' with no shell operators, got '$payload'"
        ;;
      '@transcript')
        [ -n "$payload" ] || die "row $row: @transcript needs a template path"
        [ -n "$TRANSCRIPT" ] || die "row $row: cassette has an @transcript row but --transcript was not given"
        [ -f "$(template_path "$payload")" ] \
          || die "row $row: @transcript template not found: $(template_path "$payload")"
        ;;
      '@hook')
        case "$payload" in
          SessionStart|UserPromptSubmit|Stop|SessionEnd) : ;;
          *) die "row $row: @hook must be one of SessionStart, UserPromptSubmit, Stop, SessionEnd (got '$payload')" ;;
        esac
        ;;
    esac
  done <"$CASSETTE"
}

# Template paths are relative to the cassette, so a fixture directory travels
# as one unit.
template_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(cd "$(dirname "$CASSETTE")" && pwd)" "$1" ;;
  esac
}

validate_cassette

# ------------------------------------------------------------- session -------

# Single-quote a value for the command string tmux hands to `sh -c`.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

if [ -n "$SESSION" ]; then
  command -v tmux >/dev/null 2>&1 || die "tmux not found"
  [ -d "$SESSION_CWD" ] || die "--cwd is not a directory: $SESSION_CWD"
  if [ -n "$RECORD_TO" ]; then
    # Checked before the session exists: a session created and then not written
    # down is exactly the leak --record-to is here to prevent.
    [ -d "$(dirname "$RECORD_TO")" ] || die "--record-to directory does not exist: $(dirname "$RECORD_TO")"
  fi
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    die "tmux session already exists: $SESSION"
  fi
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  CASSETTE_ABS="$(cd "$(dirname "$CASSETTE")" && pwd)/$(basename "$CASSETTE")"

  # The pane inherits the tmux SERVER's environment, not this shell's — and the
  # default server was started with the developer's real HOME. Everything the
  # replay and its `@exec` children must see is therefore spelled out on the
  # command line: the (isolated) HOME, PATH, and the demo port. A `commandmate`
  # run from the pane would otherwise read the developer's `~/.commandmate/.env`
  # and dial their live instance.
  INNER="env HOME=$(shell_quote "$HOME") PATH=$(shell_quote "$PATH")"
  INNER="$INNER $(shell_quote "$SELF") $(shell_quote "$CASSETTE_ABS")"
  INNER="$INNER --speed $(shell_quote "$SPEED") --input-settle $(shell_quote "$INPUT_SETTLE")"
  INNER="$INNER --inner --tool $(shell_quote "$TOOL") --cwd $(shell_quote "$SESSION_CWD")"
  [ "$LOOP" -eq 1 ] || INNER="$INNER --once"
  [ "$IDLE_ONLY" -eq 0 ] || INNER="$INNER --idle-only"
  [ -z "$WORKTREE_ID" ] || INNER="$INNER --worktree $(shell_quote "$WORKTREE_ID")"
  [ -z "$PORT" ] || INNER="$INNER --port $(shell_quote "$PORT")"
  [ -z "$TRANSCRIPT" ] || INNER="$INNER --transcript $(shell_quote "$TRANSCRIPT")"
  [ "$COMMANDMATE_CMD" = "commandmate" ] || INNER="$INNER --commandmate $(shell_quote "$COMMANDMATE_CMD")"

  tmux new-session -d -s "$SESSION" -c "$SESSION_CWD" -x "$PANE_WIDTH" -y "$PANE_HEIGHT" "$INNER" \
    || die "tmux new-session failed for $SESSION"
  if [ -n "$RECORD_TO" ]; then
    printf '%s\n' "$SESSION" >>"$RECORD_TO" || die "could not append to $RECORD_TO"
  fi
  printf '%s\n' "$SESSION"
  exit 0
fi

# -------------------------------------------------------------- replay -------

# CommandMate types into the pane and the tty echoes it wherever the cursor
# happens to sit, smearing the TUI box. We repaint the composer ourselves, so
# the raw echo is suppressed.
if [ -t 0 ]; then
  stty -echo 2>/dev/null || true
  trap 'stty echo 2>/dev/null || true' EXIT
fi

LAST_INPUT=""
# What the last @exec row printed, for {{EXEC_OUTPUT}} in a transcript.
LAST_EXEC_OUTPUT=""
# Every line of the last submission, newline-joined (Issue #2380). `{{INPUT}}`
# is only its first line — what a TUI echoes for a pasted block — but the
# transcript has to carry the whole prompt, byte for byte, or the reader cannot
# adopt the `/send` row for it (`recordUserTurn` matches on the text).
LAST_MESSAGE=""
# The first message of a pass. Everything after a mid-run approval prompt has to
# keep echoing the original instruction, but LAST_INPUT has by then been
# overwritten by the answer ("y").
TASK_INPUT=""

emit() {
  # Expand the cassette's escapes FIRST, then splice the captured message in as
  # literal text. Substituting first would let a message containing `\e[…` or a
  # `%` directive reach printf and repaint the pane with sequences the cassette
  # never authored.
  # The `_` sentinel survives command substitution's trailing-newline stripping.
  emit_expanded="$(printf '%b_' "$1")"
  emit_expanded="${emit_expanded%_}"
  emit_expanded="${emit_expanded//\{\{INPUT\}\}/$LAST_INPUT}"
  emit_expanded="${emit_expanded//\{\{TASK\}\}/$TASK_INPUT}"
  printf '%s' "${emit_expanded//\{\{WORKTREE\}\}/$WORKTREE_ID}"
}

# Split an @exec row into words with the shell's quoting rules and nothing
# else — `set -f` keeps a `*` from globbing, and the operators that would make
# `eval` dangerous were refused by `exec_allowed` — then splice the text
# placeholders into the words. Splicing AFTER the split is what keeps a message
# with a `"` in it from breaking the row's own quoting: the value becomes part
# of one argv element, never re-parsed as shell. The result is left in
# EXEC_WORDS, the first of which is the literal `commandmate`.
EXEC_WORDS=()
split_exec() {
  local words_ok=1 word
  EXEC_WORDS=()
  set -f
  eval "set -- $1" || words_ok=0
  set +f
  [ "$words_ok" -eq 1 ] || die "@exec could not parse: '$1'"
  for word in "$@"; do
    word="${word//\{\{INPUT\}\}/$LAST_INPUT}"
    word="${word//\{\{TASK\}\}/$TASK_INPUT}"
    word="${word//\{\{WORKTREE\}\}/$WORKTREE_ID}"
    EXEC_WORDS+=("$word")
  done
}

# Run one @exec row: the command's output goes to the pane, its exit code is
# reported on stderr (which is also the pane) so a failing `commandmate ask`
# is visible in the take rather than silently absorbed. The replay continues
# either way — the product's History, not this script, is what the next scene
# films.
run_exec() {
  split_exec "$1"
  # The word `commandmate` becomes whatever --commandmate names (several words,
  # split on whitespace — a tsx invocation, not a quoted string).
  set -f
  # shellcheck disable=SC2086
  set -- $COMMANDMATE_CMD "${EXEC_WORDS[@]:1}"
  set +f
  # stdin is /dev/null: the pane's stdin belongs to the next @input row, and a
  # CLI that read from it would eat the message CommandMate sends next. The
  # output goes to the pane through `tee`, and is kept for {{EXEC_OUTPUT}} so a
  # transcript's `tool_result` can carry what the command really printed.
  exec_capture="${TMPDIR:-/tmp}/fake-agent-exec.$$"
  if [ -n "$PORT" ]; then
    env -u DATABASE_PATH -u MCBD_DB_PATH -u MCBD_PORT -u CM_AUTH_TOKEN \
      CM_PORT="$PORT" CM_BIND=127.0.0.1 "$@" </dev/null 2>&1 | tee "$exec_capture"
  else
    "$@" </dev/null 2>&1 | tee "$exec_capture"
  fi
  exec_status=${PIPESTATUS[0]}
  LAST_EXEC_OUTPUT="$(cat "$exec_capture" 2>/dev/null)"
  rm -f "$exec_capture"
  [ "$exec_status" -eq 0 ] || printf 'fake-agent: @exec exited %d\n' "$exec_status" >&2
  return 0
}

trace_exec() {
  split_exec "$1"
  printf 'trace step=%d kind=exec command=%s\n' "$step" "${EXEC_WORDS[*]}" >&2
}

# ---------------------------------------------------------- transcript -------

new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | LC_ALL=C tr 'A-Z' 'a-z'
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    od -An -N16 -tx1 /dev/urandom | tr -d ' \n' \
      | sed -e 's/^\(........\)\(....\)\(....\)\(....\)\(............\)$/\1-\2-\3-\4-\5/'
  fi
}

# The value of a JSON string, minus the quotes: `\` and `"` escaped, a tab
# spelled `\t`. Newlines cannot occur — every source is a single line — except
# in {{MESSAGE}}, whose joiner is written as `\n` below.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$TAB/\\\\t/g"
}

# The session id is the uuid the transcript file is named after — `<uuid>.jsonl`
# for claude, `rollout-<time>-<uuid>.jsonl` for codex — so it is read off the
# name rather than passed twice.
transcript_session_id() {
  local name
  name="$(basename "$TRANSCRIPT")"
  name="${name%.jsonl}"
  # The last 36 characters: 8-4-4-4-12.
  printf '%s' "$name" | awk '{ print substr($0, length($0) - 35) }'
}

# Append one template to the transcript with this row's values spliced in.
run_transcript() {
  local template turn now cwd sid message exec_output line
  template="$(template_path "$1")"
  turn="$(new_uuid)"
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  cwd="$(json_escape "$SESSION_CWD")"
  sid="$(transcript_session_id)"
  message="$(json_escape "$LAST_MESSAGE")"
  message="${message//$'\n'/\\n}"
  exec_output="$(json_escape "$LAST_EXEC_OUTPUT")"
  exec_output="${exec_output//$'\n'/\\n}"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'trace step=%d kind=transcript template=%s\n' "$step" "$1" >&2
  fi
  mkdir -p "$(dirname "$TRANSCRIPT")" || die "cannot create $(dirname "$TRANSCRIPT")"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    case "$line" in
      '#'*) continue ;;
    esac
    line="${line//\{\{NOW\}\}/$now}"
    line="${line//\{\{TURN\}\}/$turn}"
    line="${line//\{\{SESSION_ID\}\}/$sid}"
    line="${line//\{\{CWD\}\}/$cwd}"
    line="${line//\{\{WORKTREE\}\}/$WORKTREE_ID}"
    line="${line//\{\{MESSAGE\}\}/$message}"
    line="${line//\{\{EXEC_OUTPUT\}\}/$exec_output}"
    line="${line//\{\{INPUT\}\}/$(json_escape "$LAST_INPUT")}"
    line="${line//\{\{TASK\}\}/$(json_escape "$TASK_INPUT")}"
    printf '%s\n' "$line" >>"$TRANSCRIPT" || die "cannot append to $TRANSCRIPT"
  done <"$template"
}

# --------------------------------------------------------------- hooks -------

# Post one lifecycle hook to the demo server, in the agent's own payload shape
# (`hook_event_name` + `session_id` + `cwd`) plus the correlation the injected
# hook URL carries (`worktreeId` / `instanceId`). This is what makes the pane
# report its turn boundaries the way a real CLI with hooks does: `wait` and
# `ask` settle on the agent's `Stop` instead of sitting in their 60 s "the
# hooks are not answering" hold, and the `Stop` receiver reads the transcript
# the moment the turn ends. Fail-open, like the real hook: a server that does
# not answer costs a line on stderr and nothing else.
run_hook() {
  local event="$1" body extra sid prompt
  if [ -z "$PORT" ]; then
    printf 'fake-agent: @hook %s skipped (no --port)\n' "$event" >&2
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'trace step=%d kind=hook event=%s\n' "$step" "$event" >&2
    return 0
  fi
  command -v curl >/dev/null 2>&1 || { printf 'fake-agent: @hook %s skipped (curl not found)\n' "$event" >&2; return 0; }
  sid=""
  [ -z "$TRANSCRIPT" ] || sid="$(transcript_session_id)"
  case "$event" in
    SessionStart) extra=',"source":"startup"' ;;
    UserPromptSubmit)
      prompt="$(json_escape "$LAST_MESSAGE")"
      prompt="${prompt//$'\n'/\\n}"
      extra=",\"prompt\":\"$prompt\""
      ;;
    Stop) extra=',"stop_hook_active":false' ;;
    *) extra='' ;;
  esac
  body="{\"tool\":\"$TOOL\",\"hook_event_name\":\"$event\""
  [ -z "$sid" ] || body="$body,\"session_id\":\"$sid\""
  body="$body,\"cwd\":\"$(json_escape "$SESSION_CWD")\""
  [ -z "$WORKTREE_ID" ] || body="$body,\"worktreeId\":\"$WORKTREE_ID\",\"instanceId\":\"$TOOL\""
  body="$body$extra}"
  curl -fsS -o /dev/null --max-time 5 -X POST "http://127.0.0.1:$PORT/api/hooks/agent-event" \
    -H 'Content-Type: application/json' --data "$body" \
    || printf 'fake-agent: @hook %s was not accepted by 127.0.0.1:%s\n' "$event" "$PORT" >&2
  return 0
}

# --------------------------------------------------------------- rows --------

# Read one submission off stdin. Returns 1 when stdin closed, so callers stop
# instead of repainting the composer with a stale line.
read_submission() {
  IFS= read -r LAST_INPUT || return 1
  LAST_MESSAGE="$LAST_INPUT"
  # One submission, however many lines it is (Issue #1810).
  #
  # CommandMate types the whole message into the pane and then presses
  # Enter, so a multi-line message arrives as multiple lines on stdin —
  # and `commandmate send --contract` prepends a preamble dozens of lines
  # long. Treating each line as its own `@input` made the cassette race
  # through a complete pass per line: the approval frame was painted and
  # immediately answered by the next line of the same message, `wait`
  # reported `Completed` about work that had not happened, and the pane
  # ended up showing a frame from a later pass. The remaining lines are
  # therefore drained here; what the pane echoes is the first line, which
  # is what a TUI shows for a pasted block, and the whole text is kept for
  # `{{MESSAGE}}`.
  #
  # `--input-settle` is whole seconds because bash 3.2's `read -t` takes no
  # fraction. Every already-buffered line returns immediately, so the wait
  # is only paid once, after the last line of the submission — and not at
  # all when stdin is a closed pipe, which is what the tests feed.
  if [ "$INPUT_SETTLE" -gt 0 ]; then
    while IFS= read -r -t "$INPUT_SETTLE" drained_line; do
      LAST_MESSAGE="$LAST_MESSAGE
$drained_line"
    done
  fi
  [ -n "$TASK_INPUT" ] || TASK_INPUT="$LAST_INPUT"
  return 0
}

sleep_row() {
  local scaled
  scaled=$(awk -v d="$1" -v s="$SPEED" 'BEGIN { printf "%d", (d / s) + 0.5 }')
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'trace step=%d kind=sleep ms=%s\n' "$step" "$scaled" >&2
  else
    sleep "$(awk -v ms="$scaled" 'BEGIN { printf "%.3f", ms / 1000 }')"
  fi
}

# Returns 1 when stdin closed while waiting for a message.
play_once() {
  local delay payload
  step=0
  TASK_INPUT=""
  # The cassette is read on fd 3: fd 0 has to stay attached to the pane so
  # `@input` rows can read what CommandMate sent.
  while IFS="$TAB" read -r delay payload <&3 || [ -n "$delay" ]; do
    case "$delay" in
      ''|'#'*) continue ;;
    esac
    step=$((step + 1))

    case "$delay" in
      '@input')
        [ "$DRY_RUN" -eq 1 ] && printf 'trace step=%d kind=input\n' "$step" >&2
        read_submission || return 1
        emit "$payload"
        continue
        ;;
      '@exec')
        if [ "$DRY_RUN" -eq 1 ]; then
          trace_exec "$payload"
        else
          run_exec "$payload"
        fi
        continue
        ;;
      '@transcript')
        run_transcript "$payload"
        continue
        ;;
      '@hook')
        run_hook "$payload"
        continue
        ;;
      *[!0-9]*)
        die "row $step: delay must be @input or an integer ms (or @exec / @transcript / @hook), got '$delay'"
        ;;
    esac

    sleep_row "$delay"
    emit "$payload"
  done 3<"$CASSETTE"
  return 0
}

# --idle-only: the rows before the first @input, and nothing after it.
play_idle() {
  local delay payload
  step=0
  while IFS="$TAB" read -r delay payload <&3 || [ -n "$delay" ]; do
    case "$delay" in
      ''|'#'*) continue ;;
      '@input') break ;;
    esac
    step=$((step + 1))
    case "$delay" in
      '@exec')
        if [ "$DRY_RUN" -eq 1 ]; then
          trace_exec "$payload"
        else
          run_exec "$payload"
        fi
        continue
        ;;
      '@transcript')
        run_transcript "$payload"
        continue
        ;;
      '@hook')
        run_hook "$payload"
        continue
        ;;
      *[!0-9]*)
        die "row $step: delay must be @input or an integer ms (or @exec / @transcript / @hook), got '$delay'"
        ;;
    esac
    sleep_row "$delay"
    emit "$payload"
  done 3<"$CASSETTE"
  return 0
}

if [ "$IDLE_ONLY" -eq 1 ]; then
  play_idle
  # Hold the boot screen. Anything typed into the pane is swallowed — a tool
  # that is only present is never prompted, and a stray send must not advance
  # a script that has nothing to advance to — and the idle rows are repainted
  # so the composer never shows a smeared echo. EOF ends the hold.
  while read_submission; do
    [ "$DRY_RUN" -eq 1 ] && printf 'trace kind=idle-hold\n' >&2
    play_idle
  done
  exit 0
fi

while :; do
  play_once || exit 0
  [ "$LOOP" -eq 1 ] || break
done
