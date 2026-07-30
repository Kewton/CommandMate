#!/usr/bin/env bash
# check-commandmate-tracking — report which .commandmate/ paths git will track.
#
# `.commandmate/` holds runtime data (chat attachments, caches) and is excluded
# wholesale. A few files in it are *configuration* rather than output and must be
# committed so the whole team shares them:
#
#   .commandmate/verify.yaml       verification gates  (Issue #1540)
#   .commandmate/tasks/*.yaml      execution contracts (Issue #1545)
#
# A config file that is silently ignored looks identical to one that is tracked
# until someone clones the repo and finds it missing, so this script makes the
# answer visible on demand. Run it after editing .gitignore.
#
# Usage: scripts/check-commandmate-tracking.sh
# Exit:  0 = every expectation holds, 1 = at least one is wrong, 2 = not a repo.
#
# bash 3.2 compatible (macOS ships 3.2.57): no associative arrays, no mapfile.
set -u

cd "$(dirname "$0")/.." || exit 2
git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "check-commandmate-tracking: not a git repository" >&2
  exit 2
}

# `git check-ignore` evaluates a pathname against the ignore rules and does NOT
# require the file to exist, so this script never touches the working tree.
#
# --no-index is required, not optional. By default check-ignore consults the
# index, and an already-tracked file is reported as "not ignored" no matter what
# the rules say — which would make every check on a committed file (verify.yaml)
# pass unconditionally and hide a broken rule. We want the verdict of the rules
# alone, which is what decides whether a *new* clone or a *new* file is kept.
#
# Judge by EXIT CODE, never by whether `-v` printed something: with -v git also
# prints the matching *negation* line for paths that are NOT ignored, so
# "produced output" reads a tracked file as ignored.
#   exit 0 -> ignored
#   exit 1 -> tracked
is_ignored() { git check-ignore -q --no-index "$1"; }

fail=0

# expect <tracked|ignored> <path> <why>
expect() {
  want=$1; target=$2; why=$3
  if is_ignored "$target"; then got=ignored; else got=tracked; fi
  if [ "$got" = "$want" ]; then
    printf '  ok   %-38s %s (%s)\n' "$target" "$got" "$why"
  else
    printf '  FAIL %-38s want=%s got=%s (%s)\n' "$target" "$want" "$got" "$why"
    fail=$((fail + 1))
  fi
}

echo "commandmate config tracking (.gitignore):"

# Configuration — must be committed and shared.
expect tracked '.commandmate/verify.yaml'        'verification gates #1540'
expect tracked '.commandmate/tasks/build.yaml'   'execution contract #1545'
expect tracked '.commandmate/tasks/any-name.yaml' 'contract, arbitrary name'

# Runtime output and stray files — must stay out of the repository.
expect ignored '.commandmate/attachments/a.png'  'chat attachment (runtime)'
expect ignored '.commandmate/tasks/scratch.log'  'log beside a contract'
expect ignored '.commandmate/tasks/notes.md'     'non-yaml beside a contract'
expect ignored '.commandmate/cache.json'         'unknown runtime file'

echo
if [ "$fail" -eq 0 ]; then
  echo "OK: all ${0##*/} expectations hold."
  exit 0
fi
echo "FAILED: $fail expectation(s) wrong."
echo
echo "Hint: to track files under a new subdirectory of .commandmate/, one '!' line"
echo "is not enough — git does not descend into an excluded directory, so the"
echo "negation never gets evaluated. Un-exclude the directory first, then narrow:"
echo
echo "    !/.commandmate/<dir>/"
echo "    /.commandmate/<dir>/*"
echo "    !/.commandmate/<dir>/*.yaml"
exit 1
