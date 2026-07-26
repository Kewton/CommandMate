#!/usr/bin/env bash
# monitor.sh — supervise one or more orchestrate workers with the tested
# decision core (classify-state.sh / verify-completion.sh).
#
# This is the operator entrypoint. The per-poll classification and the
# completion decision live in separate, unit-tested scripts; this file only
# owns the loop, the cross-poll state, and the interventions. It is checked by
# `bash -n` in the test suite and written for bash 3.2 (macOS /bin/bash):
#   - no associative arrays: per-worker state is held in integer-indexed
#     parallel arrays and in temp files under $STATE_DIR
#   - loop variables are never named `path` (that special-var name clobbers PATH
#     under zsh/bash and breaks curl/tmux lookups; feedback_zsh_path_loop_var)
#
# Interventions, in order of how much damage a false positive does:
#   PROMPT      -> Enter (silent auto-approve, counted)
#   RATE_LIMIT  -> "a" immediately, never sleep through a limit
#   IDLE + terminal API error at the idle threshold -> resend --resend-message,
#               capped by --max-resends. This is the only recovery from the CLI
#               exhausting its own retries (Issue #1522): a live backoff is
#               classified GENERATING and must NOT be touched, because input sent
#               mid-backoff is queued and then delivered after the retry succeeds.
#
# Usage:
#   monitor.sh [--interval 20] [--idle-threshold 8] [--session-prefix cm] \
#              [--resend-message continue] [--max-resends 2] [--max-polls 0] \
#              [--verbose] [--hooks <file>] \
#              <worktree-id> [<worktree-id> ...]
#
#   --max-polls N  stop after N poll rounds and exit 0 even if workers are still
#                  working; 0 (default) keeps polling until every worker is
#                  COMPLETE, i.e. the operator behaviour is unchanged. A bounded
#                  run ends on its own instead of having to be killed from the
#                  outside, which is what lets the loop be tested deterministically
#                  (Issue #1527) and doubles as a one-shot `--max-polls 1` probe.
#                  It only adds a stop condition — no state or intervention rule
#                  looks at it.
#
#   --verbose      emit one fixed-format line per poll per worker (see POLL_LINE
#                  below). Opt-in on purpose: the default output stays byte-identical
#                  so an operator reading the stream still sees only interventions
#                  and terminal verdicts (Issue #1533).
#
#   --hooks <file> source <file> after the built-in count_commits /
#                  count_uncommitted stubs, so an operator can supply the real
#                  work counters (Issue #1533). Without it the stubs return 0,
#                  which is what keeps the loop runnable standalone — and also what
#                  makes COMPLETE unreachable, since verify-completion.sh treats
#                  commits=0 && uncommitted=0 as the signature of an unstarted task.
#                  See hooks-git.sh for a ready-to-use implementation.
#
# Env:
#   CM             — commandmate launcher (default: "npx commandmate@latest"; pinned
#                    so the npx cache cannot resume a stale binary).
#   MONITOR_HOOKS  — default for --hooks (the flag wins when both are given).
set -u

INTERVAL=20
IDLE_THRESHOLD=8          # 150s+ of idle at 20s polls; xhigh workers think long
SESSION_PREFIX="cm"
RESEND_MESSAGE="continue"  # sent after the CLI exhausts its own retries
MAX_RESENDS=2
MAX_POLLS=0               # 0 = poll until every worker is COMPLETE (operator default)
VERBOSE=0                 # 0 = default stream (interventions + verdicts only)
HOOKS=${MONITOR_HOOKS:-}
CM=${CM:-"npx commandmate@latest"}

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) shift; INTERVAL=${1:-20};;
    --idle-threshold) shift; IDLE_THRESHOLD=${1:-8};;
    --session-prefix) shift; SESSION_PREFIX=${1:-cm};;
    --resend-message) shift; RESEND_MESSAGE=${1:-continue};;
    --max-resends) shift; MAX_RESENDS=${1:-2};;
    --max-polls) shift; MAX_POLLS=${1:-0};;
    --verbose) VERBOSE=1;;
    --hooks) shift; HOOKS=${1:-};;
    --) shift; break;;
    -*) echo "monitor.sh: unknown flag $1" >&2; exit 2;;
    *) break;;
  esac
  shift
done

if [ $# -eq 0 ]; then
  echo "monitor.sh: at least one worktree-id is required" >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CLASSIFY="$SCRIPT_DIR/classify-state.sh"
VERIFY="$SCRIPT_DIR/verify-completion.sh"
. "$SCRIPT_DIR/monitor-lib.sh"

STATE_DIR=$(mktemp -d -t cm-monitor.XXXXXX)
cleanup() { rm -rf "$STATE_DIR"; }
trap cleanup EXIT INT TERM

# Integer-indexed parallel arrays (bash 3.2 has no associative arrays).
IDS=("$@")
n_ids=${#IDS[@]}

i=0
while [ "$i" -lt "$n_ids" ]; do
  wid=${IDS[$i]}
  echo "0" > "$STATE_DIR/$wid.streak"
  echo "0" > "$STATE_DIR/$wid.started"
  echo "0" > "$STATE_DIR/$wid.approvals"
  echo "0" > "$STATE_DIR/$wid.resends"
  i=$((i + 1))
done

# read_state <worktree-id> <suffix> -> echoes stored value (0 if missing)
read_state() {
  cat "$STATE_DIR/$1.$2" 2>/dev/null || echo 0
}

# count_uncommitted <worktree-id>: best-effort change count. Left to the operator
# to wire to the worker's checkout; returns 0 here so the loop stays runnable.
count_uncommitted() {
  echo 0
}
count_commits() {
  echo 0
}

# Completion hooks. The stubs above are the reason a stock run never reports
# COMPLETE: verify-completion.sh reads commits=0 && uncommitted=0 as "the task was
# never sent" (the STARTED-guard signature), so the COMPLETE branch is unreachable
# until the counters are wired to the worker's checkout. Sourcing happens *after*
# the stubs so a hooks file that defines either name wins, and a hooks file that
# defines only one leaves the other stubbed.
if [ -n "$HOOKS" ]; then
  if [ ! -f "$HOOKS" ]; then
    echo "monitor.sh: hooks file not found: $HOOKS" >&2
    exit 2
  fi
  . "$HOOKS"
fi

echo "monitor: watching $n_ids worker(s), interval=${INTERVAL}s, idle-threshold=${IDLE_THRESHOLD}, max-resends=${MAX_RESENDS}"

poll_round=0
done_count=0
while [ "$done_count" -lt "$n_ids" ]; do
  done_count=0
  i=0
  while [ "$i" -lt "$n_ids" ]; do
    wid=${IDS[$i]}
    i=$((i + 1))

    if [ -f "$STATE_DIR/$wid.done" ]; then
      done_count=$((done_count + 1))
      continue
    fi

    poll="$STATE_DIR/$wid.poll.json"
    if ! $CM capture "$wid" --json > "$poll" 2>/dev/null; then
      # Transient empty/parse frame (redraw): do not advance the idle streak,
      # do not treat as idle (feedback_orchestrate_monitor_recipe).
      echo "monitor[$wid]: capture failed, skipping poll"
      continue
    fi

    state=$("$CLASSIFY" --json "$poll")

    started=$(read_state "$wid" started)
    streak=$(read_state "$wid" streak)

    case "$state" in
      GENERATING)
        echo "1" > "$STATE_DIR/$wid.started"
        echo "0" > "$STATE_DIR/$wid.streak"
        ;;
      RATE_LIMIT)
        # Resume immediately; never sleep through a rate limit.
        echo "monitor[$wid]: rate limit -> sending 'a'"
        tmux send-keys -t "${SESSION_PREFIX}-${wid}" a Enter 2>/dev/null || true
        echo "0" > "$STATE_DIR/$wid.streak"
        ;;
      PROMPT)
        # Silent auto-approve + counter, so the notifier is not flooded.
        approvals=$(read_state "$wid" approvals)
        approvals=$((approvals + 1))
        echo "$approvals" > "$STATE_DIR/$wid.approvals"
        tmux send-keys -t "${SESSION_PREFIX}-${wid}" Enter 2>/dev/null || true
        echo "0" > "$STATE_DIR/$wid.streak"
        ;;
      IDLE)
        streak=$((streak + 1))
        echo "$streak" > "$STATE_DIR/$wid.streak"
        # Retry-exhaustion death: the CLI burned through its own backoff
        # (`attempt 10/10`), printed a terminal API error and fell back to an idle
        # prompt. Nothing resumes from here on its own, and without a resend the
        # worker is either left forever or — worse — reported COMPLETE with
        # half-finished uncommitted work once the streak crosses the threshold.
        # Deliberately narrow, because this branch injects input:
        #   - IDLE only, so a live backoff (GENERATING via ml_is_retrying) and an
        #     open prompt are never interrupted;
        #   - the idle threshold must already be reached, so a transient frame
        #     cannot trigger it;
        #   - ml_has_terminal_api_error reads the current pane only, so an error
        #     that has scrolled out of view after a successful resume no longer
        #     counts;
        #   - capped by --max-resends, then escalated to the operator.
        if [ "$streak" -ge "$IDLE_THRESHOLD" ] && ml_has_terminal_api_error "$poll"; then
          resends=$(read_state "$wid" resends)
          if [ "$resends" -lt "$MAX_RESENDS" ]; then
            resends=$((resends + 1))
            echo "$resends" > "$STATE_DIR/$wid.resends"
            echo "monitor[$wid]: terminal API error at an idle prompt -> resending ($resends/$MAX_RESENDS)"
            tmux send-keys -t "${SESSION_PREFIX}-${wid}" "$RESEND_MESSAGE" Enter 2>/dev/null || true
            echo "0" > "$STATE_DIR/$wid.streak"
          else
            echo "monitor[$wid]: terminal API error and resend budget spent ($MAX_RESENDS) — operator needed"
          fi
        fi
        ;;
      NOT_RUNNING)
        # No pane to type into; the streak drives the NOT_STARTED report instead.
        streak=$((streak + 1))
        echo "$streak" > "$STATE_DIR/$wid.streak"
        ;;
    esac

    post_started=$(read_state "$wid" started)
    post_streak=$(read_state "$wid" streak)
    commits=$(count_commits "$wid")
    uncommitted=$(count_uncommitted "$wid")

    verdict=$("$VERIFY" \
      --started "$post_started" \
      --state "$state" \
      --idle-streak "$post_streak" \
      --idle-threshold "$IDLE_THRESHOLD" \
      --commits "$commits" \
      --uncommitted "$uncommitted")

    # POLL_LINE — one line per poll per worker, opt-in via --verbose. Fixed field
    # order so a run can be reduced mechanically, e.g.
    #   grep -o 'poll [0-9]* -> [A-Z_]*' log | awk '{print $4}' | sort | uniq -c
    # gives the state distribution, and the trailing key=value pairs carry the
    # inputs verify-completion.sh actually saw, i.e. the evidence behind the
    # verdict rather than the verdict alone (Issue #1533, #1513 G2).
    if [ "$VERBOSE" = "1" ]; then
      echo "monitor[$wid]: poll $((poll_round + 1)) -> $state started=$post_started streak=$post_streak commits=$commits uncommitted=$uncommitted verdict=$verdict"
    fi

    case "$verdict" in
      COMPLETE)
        echo "monitor[$wid]: COMPLETE (approvals=$(read_state "$wid" approvals))"
        touch "$STATE_DIR/$wid.done"
        done_count=$((done_count + 1))
        ;;
      NOT_STARTED)
        if [ "$(read_state "$wid" streak)" -ge "$IDLE_THRESHOLD" ]; then
          echo "monitor[$wid]: NOT_STARTED — idle with no work; check the composer / Enter"
        fi
        ;;
    esac
  done

  poll_round=$((poll_round + 1))
  # Deterministic stop for bounded runs: end the loop from the inside after
  # MAX_POLLS rounds rather than relying on something outside to kill it. Checked
  # after the completion tally so a run that finishes on its final round still
  # reports "all complete"; skipped entirely when MAX_POLLS is 0.
  if [ "$done_count" -lt "$n_ids" ] && [ "$MAX_POLLS" -gt 0 ] && [ "$poll_round" -ge "$MAX_POLLS" ]; then
    echo "monitor: reached --max-polls ($MAX_POLLS) after $poll_round poll round(s); stopping"
    exit 0
  fi

  [ "$done_count" -lt "$n_ids" ] && sleep "$INTERVAL"
done

echo "monitor: all $n_ids worker(s) complete"
