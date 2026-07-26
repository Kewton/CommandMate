#!/usr/bin/env bash
# verify-scope — under-delivery / scope guard that does NOT false-positive.
#
# Output (stdout): CLEAN | VIOLATIONS:<n>
#
# Scope completion is verified by grep count, not by trusting an acceptance gate
# (feedback_orchestrate_monitor_recipe item 10). But the guard itself has
# false-reported twice (feedback_orchestrate_monitor_started_guard): it counted
# a forbidden pattern that appeared only in *explanatory prose*, and it used the
# `grep -c ... || echo 0` idiom that yields a two-line "0\n0". Both are handled
# in ml_count_violations: comment lines are excluded and the count is taken as-is.
#
# Default pattern: a bare `npx commandmate` invocation missing the `@latest` pin.
set -u
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/monitor-lib.sh"

TARGET=""
PATTERN='npx commandmate([^@]|$)'
while [ $# -gt 0 ]; do
  case "$1" in
    --file) shift; TARGET=${1:-};;
    --pattern) shift; PATTERN=${1:-};;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
  shift
done
if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "verify-scope: --file <path> required" >&2
  exit 2
fi

n=$(ml_count_violations "$TARGET" "$PATTERN")
if [ "$n" -eq 0 ]; then
  echo CLEAN
else
  echo "VIOLATIONS:$n"
fi
