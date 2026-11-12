#!/usr/bin/env bash
# cmate-delegate-dev / ask.sh — send one request to another session, wait for the
# turn to end, and print the reply. One command instead of three.
#
# Usage:
#   ask.sh <worktree-id> <instance-id> "<message>"
#          [--timeout <sec>] [--tail <n>] [--on-prompt agent|human] [--cli <launcher>]
#
# stdout  the squeezed pane transcript of the reply, and nothing else.
# stderr  every diagnostic: send/wait output, the prompt JSON, this script's own
#         complaints. A caller that does `reply=$(ask.sh ...)` must not find this
#         wrapper's voice inside the reply.
# exit    THE EXIT CODE OF `wait`, passed through unchanged.
#           0 turn ended / 10 prompt / 21 not started / 99 target unresolved
#           124 timeout / 1 server down / 2 bad arguments
#           11 upstream fault; id=context-limit on stderr when the reply ended in
#              a context-limit error and the CLI did not say so itself
#         `send` failing before that returns send's code instead; nothing was
#         delegated in that case. When `commandmatedev ask` exists, its code is
#         returned instead, with one exception below.
#         The one exception: a reply that ENDS in a context-limit error turns an
#         upstream 0 into 11 with id=context-limit. Only 0 is ever rewritten.
#
# The pass-through is the whole point. `commandmatedev wait ... ; echo done` turns
# every one of those codes into 0, and the caller then reports a timeout as a
# finished delegation. See references/exit-codes.md section 6.
#
# WHAT THIS SCRIPT NEVER DOES: `respond`, `auto-yes`, `interrupt`, `--auto-yes`.
# Answering the other session's prompt is the human's call, not the delegating
# agent's (SKILL.md section 5 and 6). The regression suite greps for these.
#
# bash 3.2 compatible on purpose (macOS ships /bin/bash 3.2.57): no `declare -A`,
# no `mapfile`, no `${var,,}`.
set -u

EXIT_USAGE=2
# UPSTREAM_FAULT. A CLI that knows about context limits returns 11 with
# id=context-limit itself and it passes through untouched; this is the fallback
# for a CLI that does not: the turn "ended" (wait/ask said 0) but the model
# refused the request because the session's context was already full.
EXIT_CONTEXT_LIMIT=11

usage() {
  cat <<'USAGE'
Usage: ask.sh <worktree-id> <instance-id> "<message>" [options]

Options:
  --timeout <sec>          how long to wait for the turn to end (default 1800)
  --tail <n>               lines of squeezed transcript to read back (default 80)
  --on-prompt agent|human  what wait does when the other session asks something.
                           agent (default) returns exit 10 so the prompt can be
                           shown to a human; human blocks until a human answers
                           in the UI and never returns 10.
  --cli <launcher>         commandmatedev launcher (default: $CM, else commandmatedev)
  --                       end of options: what follows is the worktree-id, the
                           instance-id and the message, even when the message
                           itself starts with a dash
  -h, --help               this text

Exit code is the exit code of `commandmatedev wait`, unchanged.
USAGE
}

die() {
  printf 'ask.sh: %s\n' "$1" >&2
  exit "$EXIT_USAGE"
}

WORKTREE_ID=""
INSTANCE_ID=""
MESSAGE=""
TIMEOUT="1800"
TAIL="80"
ON_PROMPT="agent"
CLI_OVERRIDE=""
positional=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --timeout)
      [ "$#" -ge 2 ] || die "--timeout needs a value"
      TIMEOUT="$2"
      shift 2
      ;;
    --tail)
      [ "$#" -ge 2 ] || die "--tail needs a value"
      TAIL="$2"
      shift 2
      ;;
    --on-prompt)
      [ "$#" -ge 2 ] || die "--on-prompt needs a value"
      ON_PROMPT="$2"
      shift 2
      ;;
    --cli)
      [ "$#" -ge 2 ] || die "--cli needs a value"
      CLI_OVERRIDE="$2"
      shift 2
      ;;
    --)
      # Everything after this is a positional, so a brief that opens with a
      # dash still reaches the other session instead of being read as a flag.
      shift
      while [ "$#" -gt 0 ]; do
        positional=$((positional + 1))
        case "$positional" in
          1) WORKTREE_ID="$1" ;;
          2) INSTANCE_ID="$1" ;;
          3) MESSAGE="$1" ;;
          *) die "unexpected argument: $1" ;;
        esac
        shift
      done
      ;;
    -*)
      die "unknown option: $1 (use -- before a message that starts with a dash)"
      ;;
    *)
      positional=$((positional + 1))
      case "$positional" in
        1) WORKTREE_ID="$1" ;;
        2) INSTANCE_ID="$1" ;;
        3) MESSAGE="$1" ;;
        *) die "unexpected argument: $1" ;;
      esac
      shift
      ;;
  esac
done

[ -n "$WORKTREE_ID" ] || { usage >&2; die "worktree-id is required"; }
[ -n "$INSTANCE_ID" ] || { usage >&2; die "instance-id is required"; }
[ -n "$MESSAGE" ] || { usage >&2; die "message is required"; }

case "$ON_PROMPT" in
  agent|human) ;;
  *) die "--on-prompt takes agent or human, not: $ON_PROMPT" ;;
esac

case "$TIMEOUT" in
  ''|*[!0-9]*) die "--timeout takes whole seconds, not: $TIMEOUT" ;;
esac

case "$TAIL" in
  ''|*[!0-9]*) die "--tail takes a whole number of lines, not: $TAIL" ;;
esac

# Self-delegation. Only provable when CommandMate exported both ids into this
# session; when it did not, SKILL.md section 1 is what stops it, not this check.
if [ -n "${CM_WORKTREE_ID:-}" ] && [ -n "${CM_INSTANCE_ID:-}" ]; then
  if [ "$WORKTREE_ID" = "$CM_WORKTREE_ID" ] && [ "$INSTANCE_ID" = "$CM_INSTANCE_ID" ]; then
    die "refusing to delegate to this session itself ($CM_WORKTREE_ID/$CM_INSTANCE_ID)"
  fi
fi

# Launcher: --cli, else $CM, else the plain binary. Split on spaces so
# `CM="npx commandmate@latest"` works, the same convention monitor.sh and the
# Node runners use. The shell is never involved, so a value carrying shell
# syntax is refused rather than silently misfiring.
LAUNCHER="$CLI_OVERRIDE"
[ -n "$LAUNCHER" ] || LAUNCHER="${CM:-commandmatedev}"
case "$LAUNCHER" in
  *'|'*|*'&'*|*';'*|*'<'*|*'>'*|*'('*|*')'*|*'$'*|*'`'*|*'\'*|*'"'*|*"'"*|*'*'*|*'?'*|*'['*)
    die "launcher must be a plain command, not shell syntax: $LAUNCHER"
    ;;
esac

CM_ARGV=()
for token in $LAUNCHER; do
  CM_ARGV[${#CM_ARGV[@]}]="$token"
done
[ "${#CM_ARGV[@]}" -gt 0 ] || die "launcher resolved to nothing"

cm() {
  "${CM_ARGV[@]}" "$@"
}

CONTEXT_LIMIT_DECOR="^(●|⎿|⏺|✗|⚠|[[:space:]>*•-])*((API )?Error:? *)?([0-9]{3}:? +)?"
CONTEXT_LIMIT_RE="${CONTEXT_LIMIT_DECOR}This model's maximum context length is [0-9]+ tokens"

# Does this reply END in a context-limit error? Reads the reply on stdin.
#
# The error has to be a line of its own, not a sentence that mentions it: a
# reply that quotes "Prompt is too long" while explaining something is a normal
# reply. So each pattern is anchored at the start of the line (after only
# bullet/indent decoration, an optional "API Error:" / "Error:" and an optional
# HTTP status), and only the last 20 non-blank lines are looked at, so an error
# that scrolled past in an earlier turn does not condemn this one.
#   ⚠ Error: 400 This model's maximum context length is N tokens ...  (measured)
# Claude's "Prompt is too long" and OpenAI's context_length_exceeded are left
# out on purpose (separate issue).
# The literal `\n` of a --json reply is turned into a real newline first.
has_context_limit_error() {
  awk '{ gsub(/\\n/, "\n"); print }' | grep -v '^[[:space:]]*$' | tail -n 20 | grep -E -q "$CONTEXT_LIMIT_RE"
}

context_limit_advice() {
  printf 'ask.sh: id=context-limit: the other session refused the request, its context is full. Nothing was done.\n' >&2
  printf 'ask.sh: id=context-limit: waiting and resending will not help. Start a fresh session and send it again: commandmatedev instances %s kill %s\n' \
    "$WORKTREE_ID" "$INSTANCE_ID" >&2
}

# `commandmatedev ask` (CommandMate#2376) does send+wait+capture server-side. When
# it exists it is the real thing and this wrapper gets out of the way, exit code
# included.
if cm ask --help >/dev/null 2>&1; then
  # The reply is held (byte for byte, via the trailing sentinel) so it can be
  # read before it is printed. Only an upstream 0 can become 11.
  ask_out=$(cm ask "$WORKTREE_ID" --instance "$INSTANCE_ID" "$MESSAGE" --timeout "$TIMEOUT" --json; printf 'x%s' "$?")
  ask_rc=${ask_out##*x}
  ask_out=${ask_out%x*}
  printf '%s' "$ask_out"
  if [ "$ask_rc" -eq 0 ] && printf '%s' "$ask_out" | has_context_limit_error; then
    context_limit_advice
    exit "$EXIT_CONTEXT_LIMIT"
  fi
  exit "$ask_rc"
fi

cm send "$WORKTREE_ID" "$MESSAGE" --instance "$INSTANCE_ID" >&2
send_rc=$?
if [ "$send_rc" -ne 0 ]; then
  printf 'ask.sh: send failed (exit %s). Nothing was delegated.\n' "$send_rc" >&2
  exit "$send_rc"
fi

# wait writes the prompt JSON to ITS stdout. That is a diagnostic here, not the
# reply, so it is folded into stderr and the exit code is kept.
wait_out=$(cm wait "$WORKTREE_ID" --instance "$INSTANCE_ID" \
  --on-prompt "$ON_PROMPT" --timeout "$TIMEOUT" 2>&1)
wait_rc=$?
if [ -n "$wait_out" ]; then
  printf '%s\n' "$wait_out" >&2
fi

capture_out=$(cm capture "$WORKTREE_ID" --instance "$INSTANCE_ID" --pane --tail "$TAIL"; printf 'x%s' "$?")
capture_rc=${capture_out##*x}
capture_out=${capture_out%x*}
printf '%s' "$capture_out"
if [ "$capture_rc" -ne 0 ]; then
  printf 'ask.sh: capture failed (exit %s). The reply was not read back; wait said %s.\n' \
    "$capture_rc" "$wait_rc" >&2
fi

if [ "$wait_rc" -eq 0 ] && printf '%s' "$capture_out" | has_context_limit_error; then
  context_limit_advice
  exit "$EXIT_CONTEXT_LIMIT"
fi

exit "$wait_rc"
