#!/usr/bin/env bash
# verify-completion — decide whether a worker is done, with the STARTED guard.
#
# Output (stdout): COMPLETE | NOT_STARTED | WORKING
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
while [ $# -gt 0 ]; do
  case "$1" in
    --started) shift; started=${1:-0};;
    --state) shift; state=${1:-};;
    --idle-streak) shift; idle_streak=${1:-0};;
    --idle-threshold) shift; idle_threshold=${1:-5};;
    --commits) shift; commits=${1:-0};;
    --uncommitted) shift; uncommitted=${1:-0};;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
  shift
done

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

# A live signal means the worker is still busy regardless of the idle streak.
case "$state" in
  GENERATING|PROMPT|PROMPT_LIVE|RATE_LIMIT)
    echo WORKING
    exit 0
    ;;
esac

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
