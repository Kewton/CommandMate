#!/usr/bin/env bash
# quality-gate — run a command and judge PASS/FAIL by its REAL exit code.
#
# Output (stdout): PASS | FAIL:<code>     (log path is printed on stderr)
# Usage: quality-gate.sh [--log <file>] -- <command> [args...]
#
# Never pipe the command into grep to decide pass/fail. `cmd | grep ...` hands $?
# to grep and hides a non-zero exit — vitest can print "Tests 100 passed" yet
# exit 1 on an Unhandled Rejection, and a grep summary would call that a PASS
# (feedback_quality_gate_grep_hides_exit_code). So we run `cmd > log 2>&1` and
# read `$?` directly; grep, if any, is for human summaries only.
set -u
LOG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --log) shift; LOG=${1:-};;
    --) shift; break;;
    *) break;;
  esac
  shift
done

if [ $# -eq 0 ]; then
  echo "quality-gate: no command given (use -- <command>)" >&2
  exit 2
fi
if [ -z "$LOG" ]; then
  LOG=$(mktemp -t cm-qgate.XXXXXX)
fi

"$@" > "$LOG" 2>&1
code=$?

echo "log: $LOG" >&2
if [ "$code" -eq 0 ]; then
  echo PASS
else
  echo "FAIL:$code"
fi
