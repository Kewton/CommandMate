#!/usr/bin/env bash
# verify-completion — decide whether a worker is done.
#
# Output (stdout): COMPLETE | VERIFY_FAILED | NOT_STARTED | WORKING
#
# Sources, in the order they are consulted (Issue #1581, design principle
# "demote string parsing"):
#
#   1. the live pane state — a worker that is visibly generating/prompting is
#      not done, whatever any record says;
#   2. `--task-status`: the terminal status the server recorded for the
#      worktree's newest execution contract. This is the *primary* completion
#      source when the delegation used `send --contract`, because that status is
#      written after the verification gates ran — it is an adjudicated verdict,
#      not an inference;
#   3. the capture-derived heuristics below (STARTED guard + idle streak + work
#      counters), which are the fallback for contract-less delegation and for
#      tasks that have not reached a terminal status yet.
#
# The STARTED guard exists because worker monitoring once reported an *unstarted*
# session as COMPLETE (feedback_orchestrate_monitor_started_guard): `commandmate
# send` left the task text in the composer with Enter unconfirmed, the worker
# never generated, the idle streak climbed, and a guard without this check
# emitted `COMPLETE commits=0 uncommitted=0`. Rules:
#   - `--started` is 1 only after a generation anchor was observed at least once.
#   - `commits=0 && uncommitted=0` is the signature of an unsent task, not a
#     finished one: a worker that did anything leaves at least uncommitted changes.
set -u
state=""; idle_streak=0; idle_threshold=5; started=0; commits=0; uncommitted=0
task_status=""
while [ $# -gt 0 ]; do
  case "$1" in
    --started) shift; started=${1:-0};;
    --state) shift; state=${1:-};;
    --idle-streak) shift; idle_streak=${1:-0};;
    --idle-threshold) shift; idle_threshold=${1:-5};;
    --commits) shift; commits=${1:-0};;
    --uncommitted) shift; uncommitted=${1:-0};;
    --task-status) shift; task_status=${1:-};;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
  shift
done

# A live signal means the worker is still busy regardless of the idle streak —
# and regardless of the task ledger. This branch is what keeps a *stale* terminal
# status from ending the watch: if the pane is generating while the newest task
# says `succeeded`, that status belongs to an earlier send, not to this turn.
case "$state" in
  GENERATING|PROMPT|PROMPT_LIVE|RATE_LIMIT)
    echo WORKING
    exit 0
    ;;
esac

# Primary source: the adjudicated task status. Only terminal statuses decide —
# `pending` / `running` / `waiting_input` / `verifying` mean the state machine has
# not ruled yet, so they fall through to the heuristics below (which is how the
# STARTED guard still catches a task the CLI marked `running` while the Enter
# never landed in the composer). An unrecognised value falls through too.
case "$task_status" in
  succeeded)
    # The gates already ran server-side, work-evidence included, so this needs no
    # corroboration from the commit counters.
    echo COMPLETE
    exit 0
    ;;
  failed|cancelled)
    # Terminal but not mergeable. Distinct from COMPLETE on purpose: the whole
    # point of contract delegation is that "the worker stopped" and "the work is
    # good" stop being the same signal.
    echo VERIFY_FAILED
    exit 0
    ;;
  not_started)
    echo NOT_STARTED
    exit 0
    ;;
esac

# STARTED guard: never call an unstarted, work-free session COMPLETE.
if [ "$started" != "1" ]; then
  if [ "$commits" -eq 0 ] && [ "$uncommitted" -eq 0 ]; then
    echo NOT_STARTED
  else
    # Work exists but we never latched the anchor (e.g. a very fast worker or a
    # missed poll): not complete, keep watching rather than false-complete.
    echo WORKING
  fi
  exit 0
fi

# Idle and started: only COMPLETE with evidence of real work. A started worker
# that is idle yet shows zero work is suspicious (e.g. it crashed on launch), so
# report NOT_STARTED rather than a false COMPLETE.
if [ "$idle_streak" -ge "$idle_threshold" ]; then
  if [ "$commits" -gt 0 ] || [ "$uncommitted" -gt 0 ]; then
    echo COMPLETE
  else
    echo NOT_STARTED
  fi
else
  echo WORKING
fi
