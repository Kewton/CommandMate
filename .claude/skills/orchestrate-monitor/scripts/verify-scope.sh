#!/usr/bin/env bash
# verify-scope — NAIVE baseline (counts every match, including prose/comments,
# and uses the `|| echo 0` idiom). Output: CLEAN | VIOLATIONS:<n>
set -u
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
  echo "verify-scope: --file <path> required" >&2; exit 2
fi

n=$(grep -cE "$PATTERN" "$TARGET" || echo 0)
if [ "$n" -eq 0 ]; then
  echo CLEAN
else
  echo "VIOLATIONS:$n"
fi
