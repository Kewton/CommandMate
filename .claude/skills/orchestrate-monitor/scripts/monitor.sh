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
# Usage:
#   monitor.sh [--interval 20] [--idle-threshold 8] [--session-prefix cm] \
#              <worktree-id> [<worktree-id> ...]
#
# Env:
#   CM  — commandmate launcher (default: "npx commandmate@latest"; pinned so the
#         npx cache cannot resume a stale binary).
set -u

INTERVAL=20
IDLE_THRESHOLD=8          # 150s+ of idle at 20s polls; xhigh workers think long
SESSION_PREFIX="cm"
CM=${CM:-"npx commandmate@latest"}

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) shift; INTERVAL=${1:-20};;
    --idle-threshold) shift; IDLE_THRESHOLD=${1:-8};;
    --session-prefix) shift; SESSION_PREFIX=${1:-cm};;
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

STATE_DIR=$(mktemp -d -t cm-monitor.XXXXXX)
cleanup() { rm -rf "$STATE_DIR"; }
trap cleanup EXIT

# Integer-indexed parallel arrays (bash 3.2 has no associative arrays).
IDS=("$@")
n_ids=${#IDS[@]}

i=0
while [ "$i" -lt "$n_ids" ]; do
  wid=${IDS[$i]}
  echo "0" > "$STATE_DIR/$wid.streak"
  echo "0" > "$STATE_DIR/$wid.started"
  echo "0" > "$STATE_DIR/$wid.approvals"
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

echo "monitor: watching $n_ids worker(s), interval=${INTERVAL}s, idle-threshold=${IDLE_THRESHOLD}"

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
      NOT_RUNNING|IDLE)
        streak=$((streak + 1))
        echo "$streak" > "$STATE_DIR/$wid.streak"
        ;;
    esac

    verdict=$("$VERIFY" \
      --started "$(read_state "$wid" started)" \
      --state "$state" \
      --idle-streak "$(read_state "$wid" streak)" \
      --idle-threshold "$IDLE_THRESHOLD" \
      --commits "$(count_commits "$wid")" \
      --uncommitted "$(count_uncommitted "$wid")")

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

  [ "$done_count" -lt "$n_ids" ] && sleep "$INTERVAL"
done

echo "monitor: all $n_ids worker(s) complete"
