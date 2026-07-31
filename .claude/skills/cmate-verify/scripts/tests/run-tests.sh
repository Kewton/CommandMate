#!/usr/bin/env bash
# cmate-verify — fixture-based test suite for verify-run.sh.
#
# Self-contained on purpose: the skill is distributed to repositories that have
# no vitest (and no Node), so the suite must run with nothing but bash + git.
# `tests/unit/skills/cmate-verify/verify-run.test.ts` is a thin wrapper that runs
# this file so the same assertions also gate `npm run test:unit`.
#
# Output is TAP-ish (`ok - ...` / `not ok - ...`) plus a final
# `# tests: N passed, M failed`. Exit 0 only when M is 0 and enough assertions ran.
#
# bash 3.2 compatible: no `declare -A`, no `mapfile`, no `${var,,}`.
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RUNNER="$SCRIPT_DIR/../verify-run.sh"
FIXTURES="$SCRIPT_DIR/fixtures"
BASE_BRANCH="cmate-verify-base"

# Floor on the assertion count. A suite that silently stops running cases would
# otherwise exit 0 with "0 failed" — the same empty-glob trap the orchestrate-monitor
# syntax test guards against.
MIN_ASSERTIONS=100

[ -f "$RUNNER" ] || { echo "run-tests: runner not found: $RUNNER" >&2; exit 2; }
[ -d "$FIXTURES" ] || { echo "run-tests: fixtures not found: $FIXTURES" >&2; exit 2; }

TMPBASE=${TMPDIR:-/tmp}
TMPBASE=${TMPBASE%/}
SANDBOX=$(mktemp -d "$TMPBASE/cmate-verify-tests.XXXXXX") || exit 2
trap 'rm -rf "$SANDBOX"' EXIT

TOTAL_PASS=0
TOTAL_FAIL=0
RUN_SEQ=0
RC=0
OUT=""
ERR=""

ok() { TOTAL_PASS=$((TOTAL_PASS + 1)); echo "ok - $1"; }
notok() { TOTAL_FAIL=$((TOTAL_FAIL + 1)); echo "not ok - $1"; }

assert_eq() { # name expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else notok "$1 (expected [$2], got [$3])"; fi
}
# -e is mandatory: a needle that starts with "--" (e.g. "--cwd is not a directory")
# is otherwise parsed by grep as an option and silently never matches.
assert_has() { # name file needle
  if grep -Fq -e "$3" "$2"; then ok "$1"; else notok "$1 (not found in $2: $3)"; fi
}
assert_lacks() { # name file needle
  if grep -Fq -e "$3" "$2"; then notok "$1 (unexpectedly found in $2: $3)"; else ok "$1"; fi
}
assert_file_present() { # name path
  if [ -e "$2" ]; then ok "$1"; else notok "$1 (missing: $2)"; fi
}
assert_file_absent() { # name path
  if [ -e "$2" ]; then notok "$1 (unexpectedly exists: $2)"; else ok "$1"; fi
}
assert_le() { # name actual limit
  if [ "$2" -le "$3" ]; then ok "$1"; else notok "$1 ($2 > $3)"; fi
}

count_procs() { # pattern -> number of live processes whose argv contains it
  ps -A -o args= 2>/dev/null | grep -F -e "$1" | grep -v grep | wc -l | tr -d ' '
}

# Polls instead of sleeping a fixed time: it removes the kill/probe race without
# weakening the assertion, because a surviving orphan lives far longer than the
# poll window.
wait_for_no_procs() { # pattern seconds -> final count
  wp_left=$2
  while [ "$wp_left" -gt 0 ]; do
    wp_n=$(count_procs "$1")
    [ "$wp_n" -eq 0 ] && break
    sleep 1
    wp_left=$((wp_left - 1))
  done
  count_procs "$1"
}

run_verify() { # sets RC / OUT / ERR
  RUN_SEQ=$((RUN_SEQ + 1))
  OUT="$SANDBOX/out.$RUN_SEQ"
  ERR="$SANDBOX/err.$RUN_SEQ"
  bash "$RUNNER" "$@" > "$OUT" 2> "$ERR"
  RC=$?
}

# new_repo <name> — a primary checkout whose HEAD equals $BASE_BRANCH.
new_repo() {
  nr_dir="$SANDBOX/$1"
  mkdir -p "$nr_dir"
  git init -q --template= "$nr_dir" >/dev/null 2>&1
  git -C "$nr_dir" config user.email "test@example.invalid"
  git -C "$nr_dir" config user.name "cmate-verify test"
  git -C "$nr_dir" config commit.gpgsign false
  git -C "$nr_dir" commit -q --allow-empty -m base
  git -C "$nr_dir" branch -f "$BASE_BRANCH"
  echo "$nr_dir"
}

new_marker() {
  RUN_SEQ=$((RUN_SEQ + 1))
  echo "$SANDBOX/marker.$RUN_SEQ"
}

echo "# cmate-verify fixture suite"

# --- 0. harness self-check ----------------------------------------------------
# Every assertion below is only worth its green if a wrong expectation is really
# recorded as a failure. Each probe runs in a subshell so its counter mutations
# do not leak into the real totals.
probe=$(TOTAL_FAIL=0; assert_eq p a b >/dev/null; echo "$TOTAL_FAIL")
assert_eq "harness: assert_eq counts a mismatch as a failure" "1" "$probe"
probe=$(TOTAL_PASS=0; assert_eq p a a >/dev/null; echo "$TOTAL_PASS")
assert_eq "harness: assert_eq counts a match as a pass" "1" "$probe"
echo "needle" > "$SANDBOX/probe.txt"
probe=$(TOTAL_FAIL=0; assert_has p "$SANDBOX/probe.txt" "absent-string" >/dev/null; echo "$TOTAL_FAIL")
assert_eq "harness: assert_has counts a missing needle as a failure" "1" "$probe"
probe=$(TOTAL_FAIL=0; assert_lacks p "$SANDBOX/probe.txt" "needle" >/dev/null; echo "$TOTAL_FAIL")
assert_eq "harness: assert_lacks counts a present needle as a failure" "1" "$probe"
probe=$(TOTAL_FAIL=0; assert_file_absent p "$SANDBOX/probe.txt" >/dev/null; echo "$TOTAL_FAIL")
assert_eq "harness: assert_file_absent counts an existing file as a failure" "1" "$probe"
probe=$(TOTAL_FAIL=0; assert_file_present p "$SANDBOX/no-such-file" >/dev/null; echo "$TOTAL_FAIL")
assert_eq "harness: assert_file_present counts a missing file as a failure" "1" "$probe"

# --- 1. every gate passes -----------------------------------------------------
repo=$(new_repo worked)
git -C "$repo" commit -q --allow-empty -m work
run_verify --config "$FIXTURES/all-pass.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "all-pass: exit code is 0" "0" "$RC"
assert_has "all-pass: work-evidence counts the commit" "$OUT" "GATE work-evidence PASS commits=1 uncommitted=0"
assert_has "all-pass: first gate passes" "$OUT" "GATE first PASS exit=0 duration="
assert_has "all-pass: second gate passes" "$OUT" "GATE second PASS exit=0 duration="
assert_has "all-pass: verdict is passed" "$OUT" "RESULT passed"

# --- 2. one gate fails, the rest still run ------------------------------------
run_verify --config "$FIXTURES/one-fail.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "one-fail: exit code is 20" "20" "$RC"
assert_has "one-fail: gate before the failure passes" "$OUT" "GATE ok PASS exit=0 duration="
assert_has "one-fail: green-looking output with exit 3 is a FAIL" "$OUT" "GATE broken FAIL exit=3 duration="
assert_has "one-fail: execution continues past the failure" "$OUT" "GATE after PASS exit=0 duration="
assert_has "one-fail: verdict is failed" "$OUT" "RESULT failed"
assert_has "one-fail: the failing gate output is reported on stderr" "$ERR" "Tests 100 passed"
assert_lacks "one-fail: stdout stays parseable (no log tail)" "$OUT" "Tests 100 passed"

# --- 3. timeout ---------------------------------------------------------------
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
export CMATE_VERIFY_TEST_MARKER
started=$(date +%s)
run_verify --config "$FIXTURES/timeout.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
elapsed=$(( $(date +%s) - started ))
assert_eq "timeout: exit code is 20" "20" "$RC"
assert_has "timeout: the slow gate is reported as TIMEOUT" "$OUT" "GATE slow TIMEOUT exit=124 duration="
assert_has "timeout: execution continues past the timeout" "$OUT" "GATE after PASS exit=0 duration="
assert_has "timeout: verdict is failed" "$OUT" "RESULT failed"
# The gate would touch the marker at +4144s; the elapsed bound proves we did not
# wait it out rather than killing it.
assert_file_absent "timeout: the killed gate never reached its side effect" "$marker"
assert_le "timeout: the run ends well before the gate would have finished" "$elapsed" "15"
# The gate backgrounded a child carrying this run's marker path in its argv.
# Killing only the direct child would leave it running for over an hour, so a
# zero count here is what proves the whole process group was killed. The probe
# is scoped to this run's marker so an orphan leaked by an earlier run cannot
# fail (or mask) this one.
orphans=$(wait_for_no_procs "cmate-verify-orphan-probe $marker" 5)
assert_eq "timeout: no orphan survives the kill" "0" "$orphans"

# --- 4. work-evidence -> not_started ------------------------------------------
clean=$(new_repo clean)
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$clean" --base-ref "$BASE_BRANCH"
assert_eq "not_started: exit code is 21" "21" "$RC"
assert_has "not_started: work-evidence reports zero work" "$OUT" "GATE work-evidence FAIL commits=0 uncommitted=0"
assert_has "not_started: verdict is not_started" "$OUT" "RESULT not_started"
assert_lacks "not_started: no command gate is reported" "$OUT" "GATE sidefx"
assert_file_absent "not_started: no command gate is executed" "$marker"

# --- 5. missing config file ---------------------------------------------------
run_verify --config "$SANDBOX/there-is-no-such-file.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "missing-config: exit code is 2" "2" "$RC"
assert_has "missing-config: the path is named on stderr" "$ERR" "config file not found"
assert_lacks "missing-config: no verdict is emitted" "$OUT" "RESULT"

# --- 6. work-evidence also passes on uncommitted changes ----------------------
echo scratch > "$clean/untracked.txt"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$clean" --base-ref "$BASE_BRANCH"
assert_eq "uncommitted: exit code is 0" "0" "$RC"
assert_has "uncommitted: work-evidence passes on a dirty tree alone" "$OUT" "GATE work-evidence PASS commits=0 uncommitted=1"
assert_file_present "uncommitted: the command gate ran" "$marker"
rm -f "$clean/untracked.txt"

# --- 7. --skip-work-evidence bypasses the not_started guard -------------------
# Pairs with case 4: same repo, same config, only the flag differs. Without this
# the not_started assertions could be passing for the wrong reason.
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$clean" --base-ref "$BASE_BRANCH" --skip-work-evidence
assert_eq "skip-work-evidence: exit code is 0" "0" "$RC"
assert_has "skip-work-evidence: the gate is reported as skipped" "$OUT" "GATE work-evidence SKIP reason=flag"
assert_has "skip-work-evidence: verdict is passed" "$OUT" "RESULT passed"
assert_file_present "skip-work-evidence: the command gate ran" "$marker"

# --- 8. primary checkout is skipped by default --------------------------------
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/default-options.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "primary-checkout: exit code is 22" "22" "$RC"
assert_has "primary-checkout: the gate is skipped" "$OUT" "GATE sidefx SKIP reason=primary-checkout"
assert_has "primary-checkout: verdict is skipped, not passed" "$OUT" "RESULT skipped"
assert_lacks "primary-checkout: an all-skipped run is never reported as passed" "$OUT" "RESULT passed"
assert_file_absent "primary-checkout: no command runs in the primary checkout" "$marker"

# --- 9. the same config runs in a linked worktree ------------------------------
# Pairs with case 8: identical fixture, identical defaults, only the checkout kind
# differs — so case 8 cannot be green because of a broken config.
linked="$SANDBOX/linked"
git -C "$repo" worktree add -q "$linked" -b cmate-verify-linked >/dev/null 2>&1
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/default-options.yaml" --cwd "$linked" --base-ref "$BASE_BRANCH"
assert_eq "linked-worktree: exit code is 0" "0" "$RC"
assert_has "linked-worktree: the gate is not skipped" "$OUT" "GATE sidefx PASS exit=0 duration="
assert_has "linked-worktree: verdict is passed" "$OUT" "RESULT passed"
assert_file_present "linked-worktree: the command gate ran" "$marker"

# --- 10. --gates selection ----------------------------------------------------
run_verify --config "$FIXTURES/one-fail.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH" --gates ok,after
assert_eq "gates-subset: exit code is 0" "0" "$RC"
assert_has "gates-subset: a selected gate runs" "$OUT" "GATE ok PASS exit=0 duration="
assert_lacks "gates-subset: an unselected gate does not run" "$OUT" "GATE broken"
assert_has "gates-subset: verdict is passed" "$OUT" "RESULT passed"

run_verify --config "$FIXTURES/one-fail.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH" --gates ok,nosuch
assert_eq "gates-unknown: a typo is a config error, not a silent pass" "2" "$RC"
assert_has "gates-unknown: the unknown id is named" "$ERR" "unknown gate id: nosuch"
assert_lacks "gates-unknown: no verdict is emitted" "$OUT" "RESULT"

# --- 11. parsing of comments, quotes and embedded colons ----------------------
run_verify --config "$FIXTURES/parsing.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "parsing: exit code is 0" "0" "$RC"
assert_has "parsing: a quoted command keeps its hash and colon" "$OUT" "GATE quoted PASS exit=0 duration="
assert_has "parsing: an unquoted command keeps its embedded quotes" "$OUT" "GATE unquoted PASS exit=0 duration="
assert_has "parsing: verdict is passed" "$OUT" "RESULT passed"

# --- 12. git context errors ---------------------------------------------------
run_verify --config "$FIXTURES/all-pass.yaml" --cwd "$repo"
assert_eq "base-ref: an unresolvable default is a config error" "2" "$RC"
assert_has "base-ref: the fix is spelled out" "$ERR" "cannot determine baseRef"

run_verify --config "$FIXTURES/all-pass.yaml" --cwd "$repo" --base-ref no/such/ref
assert_eq "base-ref: an unknown ref is a config error" "2" "$RC"
assert_has "base-ref: the bad ref is named" "$ERR" "baseRef does not resolve to a commit"

mkdir -p "$SANDBOX/not-a-repo"
run_verify --config "$FIXTURES/all-pass.yaml" --cwd "$SANDBOX/not-a-repo" --base-ref "$BASE_BRANCH"
assert_eq "non-git cwd: exit code is 2" "2" "$RC"
assert_has "non-git cwd: the path is named" "$ERR" "not a git repository"

run_verify --config "$FIXTURES/all-pass.yaml" --cwd "$SANDBOX/no-such-directory" --base-ref "$BASE_BRANCH"
assert_eq "missing cwd: exit code is 2" "2" "$RC"
assert_has "missing cwd: the path is named" "$ERR" "--cwd is not a directory"

run_verify --config "$FIXTURES/all-pass.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH" --bogus
assert_eq "unknown argument: exit code is 2" "2" "$RC"

# --- 13. rejected configs -----------------------------------------------------
# Every one of these must be a config error (exit 2) AND must not emit a verdict:
# a malformed config that reported `passed` would be the worst possible failure.
assert_rejected() { # fixture expected-message
  run_verify --config "$FIXTURES/$1" --cwd "$repo" --base-ref "$BASE_BRANCH"
  assert_eq "reject $1: exit code is 2" "2" "$RC"
  assert_has "reject $1: explains why" "$ERR" "$2"
  assert_lacks "reject $1: emits no verdict" "$OUT" "RESULT"
}

assert_rejected bad-version.yaml "version must be 1"
assert_rejected bad-no-version.yaml "missing top-level"
assert_rejected bad-duplicate-id.yaml "duplicate gate id: a"
assert_rejected bad-reserved-id.yaml "gate id is reserved: work-evidence"
assert_rejected bad-invalid-id.yaml "invalid gate id: Lint_Gate"
assert_rejected bad-timeout-range.yaml "timeoutSec must be 1..7200"
assert_rejected bad-timeout-type.yaml "timeoutSec must be an integer"
assert_rejected bad-missing-command.yaml "gate is missing command:"
assert_rejected bad-missing-id.yaml "gate is missing id:"
assert_rejected bad-gate-key.yaml "unknown gate key: retries"
assert_rejected bad-option-key.yaml "unknown options key: parallel"
assert_rejected bad-option-value.yaml "skipInPrimaryCheckout must be true or false"
assert_rejected bad-flow.yaml "flow-style values are not supported"
assert_rejected bad-anchor.yaml "anchors/aliases are not supported"
assert_rejected bad-block-scalar.yaml "block scalars are not supported"
assert_rejected bad-indent.yaml "indentation must be a multiple of 2 spaces"
assert_rejected bad-tab.yaml "tab characters are not allowed"
assert_rejected bad-no-gates.yaml "no gates are defined"

# --- summary ------------------------------------------------------------------
total=$((TOTAL_PASS + TOTAL_FAIL))
echo "# tests: $TOTAL_PASS passed, $TOTAL_FAIL failed"
if [ "$total" -lt "$MIN_ASSERTIONS" ]; then
  echo "not ok - suite ran only $total assertions (expected at least $MIN_ASSERTIONS)"
  exit 1
fi
[ "$TOTAL_FAIL" -eq 0 ] || exit 1
exit 0
