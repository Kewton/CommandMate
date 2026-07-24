#!/usr/bin/env bash
# verify-completion — NAIVE baseline (no STARTED guard).
# Output: COMPLETE | WORKING
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

if [ "$idle_streak" -ge "$idle_threshold" ]; then
  echo COMPLETE
else
  echo WORKING
fi
