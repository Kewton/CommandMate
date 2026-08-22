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
MIN_ASSERTIONS=300

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
RAWOUT=""
ERR=""
# Path of the annotated out.N belonging to the most recent run_verify, and whether
# it has already been dumped for that run. Both are reset by run_verify.
FAIL_CONTEXT=""
FAIL_CONTEXT_SHOWN=0
# Upper bound on the context dump so one pathological gate log cannot bury the
# rest of the suite output. The runner already caps its tail at maxLogTailBytes.
MAX_CONTEXT_LINES=200

ok() { TOTAL_PASS=$((TOTAL_PASS + 1)); echo "ok - $1"; }

# A failing assertion names where the reason lives and then prints it. The CI red
# in Issue #1607 left only `not ok - parsing: ...` behind: the sandbox holding
# err.N is removed by the EXIT trap, so anything not echoed here is gone for good.
notok() {
  TOTAL_FAIL=$((TOTAL_FAIL + 1))
  if [ -n "$FAIL_CONTEXT" ]; then
    echo "not ok - $1 [context: $FAIL_CONTEXT]"
  else
    echo "not ok - $1"
  fi
  [ -n "$FAIL_CONTEXT" ] || return 0
  [ "$FAIL_CONTEXT_SHOWN" -eq 0 ] || return 0
  FAIL_CONTEXT_SHOWN=1
  echo "# context: $FAIL_CONTEXT (verify-run stdout, plus its exit code and stderr when it failed)"
  sed -n "1,${MAX_CONTEXT_LINES}p" "$FAIL_CONTEXT" | sed 's/^/#   /'
  if [ "$(wc -l < "$FAIL_CONTEXT" | tr -d ' ')" -gt "$MAX_CONTEXT_LINES" ]; then
    echo "#   ... truncated at $MAX_CONTEXT_LINES lines ..."
  fi
  echo "# end context: $FAIL_CONTEXT"
}

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
# Every line the runner writes to stdout must be one of the two documented record
# shapes. This is what pins the machine-readable contract while out.N is allowed
# to carry stderr: if a diagnostic ever leaked into stdout, `RESULT` would stop
# being the last line and `commandmate verify` would parse garbage.
STDOUT_CONTRACT_RE='^(GATE [a-z0-9-]+ (PASS|FAIL|FLAKY|TIMEOUT|SKIP) [^ ].*|RESULT (passed|failed|not_started|skipped))$'
assert_stdout_contract() { # name file
  as_lines=$(grep -c . "$2" | tr -d ' ')
  as_bad=$(grep -v -E "$STDOUT_CONTRACT_RE" "$2" | head -3 | tr '\n' '/')
  if [ "$as_lines" -eq 0 ]; then
    notok "$1 (stdout is empty, so the contract check would be vacuous)"
  elif [ -n "$as_bad" ]; then
    notok "$1 (line outside the machine-readable contract: $as_bad)"
  else
    ok "$1"
  fi
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

# Sets RC / RAWOUT / OUT / ERR.
#
#   RAWOUT — exactly what the runner wrote to stdout. Assertions about the
#            machine-readable contract must use this file and only this file.
#   ERR    — exactly what the runner wrote to stderr.
#   OUT    — the diagnostic view: RAWOUT, plus the exit code and the stderr that
#            explains it appended whenever the run failed.
#
# The split has to stay (that is the contract under test), but a failure message
# that points at out.N has to be enough on its own: the sandbox holding err.N is
# gone by the time anyone reads the CI log (Issue #1607).
run_verify() {
  RUN_SEQ=$((RUN_SEQ + 1))
  OUT="$SANDBOX/out.$RUN_SEQ"
  RAWOUT="$SANDBOX/stdout.$RUN_SEQ"
  ERR="$SANDBOX/err.$RUN_SEQ"
  bash "$RUNNER" "$@" > "$RAWOUT" 2> "$ERR"
  RC=$?
  cat "$RAWOUT" > "$OUT"
  if [ "$RC" -ne 0 ]; then
    {
      echo "--- verify-run exit=$RC (stderr captured in $ERR) ---"
      if [ -s "$ERR" ]; then cat "$ERR"; else echo "(stderr was empty)"; fi
      echo "--- end verify-run exit=$RC ---"
    } >> "$OUT"
  fi
  FAIL_CONTEXT="$OUT"
  FAIL_CONTEXT_SHOWN=0
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
# The diagnostic dump is the whole point of Issue #1607, so it gets the same
# treatment: prove that a failure really carries the captured output with it,
# and that a passing assertion does not spray context into the log.
printf 'GATE g FAIL exit=7 duration=0s\n--- verify-run exit=20 ---\nreason-needle\n' > "$SANDBOX/probe-ctx.txt"
probe=$(FAIL_CONTEXT="$SANDBOX/probe-ctx.txt"; FAIL_CONTEXT_SHOWN=0; notok "p")
case "$probe" in
  *"[context: $SANDBOX/probe-ctx.txt]"*) ok "harness: a failure names the captured output";;
  *) notok "harness: a failure names the captured output (got [$probe])";;
esac
case "$probe" in
  *"#   reason-needle"*) ok "harness: a failure prints the captured output, not just its path";;
  *) notok "harness: a failure prints the captured output, not just its path (got [$probe])";;
esac
probe=$(FAIL_CONTEXT="$SANDBOX/probe-ctx.txt"; FAIL_CONTEXT_SHOWN=0; notok "first"; notok "second")
probe=$(printf '%s\n' "$probe" | grep -c '^# context:' | tr -d ' ')
assert_eq "harness: the context is dumped once per run, not once per assertion" "1" "$probe"
probe=$(FAIL_CONTEXT=""; ok "p")
case "$probe" in
  *context*) notok "harness: a passing assertion stays a single line (got [$probe])";;
  *) ok "harness: a passing assertion stays a single line";;
esac

# --- 1. every gate passes -----------------------------------------------------
# The work commit has to touch a file. Since Issue #1651 the commit counter runs
# under a pathspec (`:(top)` plus the contract exclusion), and git's history
# simplification drops commits that modify no path — so a `--allow-empty` commit
# now counts as 0. That is the product engine's behaviour too (#1580), and it is
# the right answer: a commit that changed nothing is not work.
repo=$(new_repo worked)
printf 'agent output\n' > "$repo/work.txt"
git -C "$repo" add -A >/dev/null 2>&1
git -C "$repo" commit -q -m work
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
assert_lacks "one-fail: stdout stays parseable (no log tail)" "$RAWOUT" "Tests 100 passed"

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
# The slow gate blocks in `sleep` and prints nothing, so its log is empty. Before
# Issue #1607 that made the TIMEOUT branch silent: the status line was the entire
# report. Both halves are pinned — the runner says it on stderr, and the harness
# carries it into out.N where a CI reader can actually reach it.
assert_has "timeout: a silent timeout still states its reason" "$ERR" "gate slow (TIMEOUT after 1s): no output captured"
assert_has "timeout: out.N carries the timeout reason" "$OUT" "gate slow (TIMEOUT after 1s): no output captured"
assert_lacks "timeout: the reason stays off stdout" "$RAWOUT" "no output captured"
assert_stdout_contract "timeout: stdout holds only GATE/RESULT records" "$RAWOUT"
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
assert_lacks "not_started: no command gate is reported" "$RAWOUT" "GATE sidefx"
assert_file_absent "not_started: no command gate is executed" "$marker"

# --- 5. missing config file ---------------------------------------------------
run_verify --config "$SANDBOX/there-is-no-such-file.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "missing-config: exit code is 2" "2" "$RC"
assert_has "missing-config: the path is named on stderr" "$ERR" "config file not found"
assert_lacks "missing-config: no verdict is emitted" "$RAWOUT" "RESULT"

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
assert_lacks "primary-checkout: an all-skipped run is never reported as passed" "$RAWOUT" "RESULT passed"
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
assert_lacks "gates-subset: an unselected gate does not run" "$RAWOUT" "GATE broken"
assert_has "gates-subset: verdict is passed" "$OUT" "RESULT passed"

run_verify --config "$FIXTURES/one-fail.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH" --gates ok,nosuch
assert_eq "gates-unknown: a typo is a config error, not a silent pass" "2" "$RC"
assert_has "gates-unknown: the unknown id is named" "$ERR" "unknown gate id: nosuch"
assert_lacks "gates-unknown: no verdict is emitted" "$RAWOUT" "RESULT"

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
  assert_lacks "reject $1: emits no verdict" "$RAWOUT" "RESULT"
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
assert_rejected bad-require-commit.yaml "requireCommit must be true or false"
assert_rejected bad-flow.yaml "flow-style values are not supported"
assert_rejected bad-anchor.yaml "anchors/aliases are not supported"
assert_rejected bad-block-scalar.yaml "block scalars are not supported"
assert_rejected bad-indent.yaml "indentation must be a multiple of 2 spaces"
assert_rejected bad-tab.yaml "tab characters are not allowed"
assert_rejected bad-no-gates.yaml "no gates are defined"
# Issues #223 / #224: the keys are accepted, their VALUE DOMAINS are not open.
assert_rejected bad-reserved-env-clean.yaml "gate id is reserved: env-clean"
assert_rejected bad-retry-range.yaml "retryOnFail must be 0 or 1"
assert_rejected bad-retry-type.yaml "retryOnFail must be 0 or 1"
assert_rejected bad-flaky-alone.yaml "flakyIsPass: true requires retryOnFail: 1"
assert_rejected bad-flaky-type.yaml "flakyIsPass must be true or false"
assert_rejected bad-mutex-name.yaml "invalid mutex name: e2e/port"
assert_rejected bad-mutex-length.yaml "mutex must be at most 64 characters"
assert_rejected bad-env-clean.yaml "requireEnvClean must be true or false"

# --- 14. a failing run leaves its reason inside out.N (Issue #1607) ------------
# The CI red that opened this issue printed three `not ok - parsing: ...` lines
# and nothing else: err.N lived in a sandbox the EXIT trap had already deleted,
# and the vitest wrapper reduced the suite output to its `not ok` lines. out.N is
# the one file a failure message can point at, so the reason has to be in it.
run_verify --config "$FIXTURES/one-fail.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "diagnostics: exit code is 20" "20" "$RC"
assert_has "diagnostics: out.N records the runner exit code" "$OUT" "--- verify-run exit=20 "
assert_has "diagnostics: out.N names where stderr was captured" "$OUT" "$ERR"
assert_has "diagnostics: out.N carries the failing gate's own exit code" "$OUT" "GATE broken FAIL exit=3"
assert_has "diagnostics: out.N carries the stderr that explains the failure" "$OUT" "Tests 100 passed"
assert_has "diagnostics: out.N labels which gate the tail belongs to" "$OUT" "gate broken (FAIL exit=3)"
assert_stdout_contract "diagnostics: stdout holds only GATE/RESULT records" "$RAWOUT"

# Pairs with the run above: a passing run gets no diagnostics block, so the block
# cannot be a constant that appears whatever happened.
run_verify --config "$FIXTURES/all-pass.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "diagnostics: a green run still exits 0" "0" "$RC"
assert_lacks "diagnostics: a green run appends nothing to out.N" "$OUT" "--- verify-run exit="
assert_has "diagnostics: a green run keeps its verdict in out.N" "$OUT" "RESULT passed"
assert_stdout_contract "diagnostics: a green run's stdout holds only GATE/RESULT records" "$RAWOUT"

# --- 15. a FAIL that printed nothing still explains itself ---------------------
run_verify --config "$FIXTURES/silent-fail.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "silent-fail: exit code is 20" "20" "$RC"
assert_has "silent-fail: an empty-output gate is still a FAIL" "$OUT" "GATE silent FAIL exit=3 duration="
assert_has "silent-fail: the runner states the reason on stderr" "$ERR" "gate silent (FAIL exit=3): no output captured"
assert_has "silent-fail: the reason reaches out.N" "$OUT" "gate silent (FAIL exit=3): no output captured"
assert_lacks "silent-fail: the reason stays off stdout" "$RAWOUT" "no output captured"
# 126/127 with an empty log is what an exec that never got off the ground looks
# like from here; the hint is a lead to follow, not a diagnosis.
assert_has "silent-fail: a command that cannot be executed is a FAIL" "$OUT" "GATE notfound FAIL exit=127 duration="
assert_has "silent-fail: exit 127 with no output is called out as a possible spawn failure" "$ERR" "may not have started"
assert_has "silent-fail: the spawn hint names the command" "$ERR" "cmate-verify-no-such-command-1607"
assert_lacks "silent-fail: an ordinary non-zero exit gets no spawn hint" "$ERR" "gate silent exited 3 with no output"
assert_has "silent-fail: verdict is failed" "$OUT" "RESULT failed"
assert_stdout_contract "silent-fail: stdout holds only GATE/RESULT records" "$RAWOUT"

# --- 16. maxLogTailBytes: 0 says so instead of going quiet ---------------------
run_verify --config "$FIXTURES/no-log-tail.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
assert_eq "no-log-tail: exit code is 20" "20" "$RC"
assert_has "no-log-tail: the gate fails with its exit code" "$OUT" "GATE noisy FAIL exit=5 duration="
assert_has "no-log-tail: the disabled tail is reported, not silently skipped" "$OUT" "gate noisy (FAIL exit=5): log tail disabled (maxLogTailBytes=0)"
assert_lacks "no-log-tail: the tail really is suppressed" "$OUT" "tail-should-not-appear"
assert_stdout_contract "no-log-tail: stdout holds only GATE/RESULT records" "$RAWOUT"

# --- 17. options.requireCommit (Issue #1639) ----------------------------------
# `commits=0 uncommitted=1` is the right answer to "did anything happen here" and
# the wrong one to "is this finished": a contract that says 未 commit の作業は未完了
# とみなされる was still collecting RESULT passed over work nobody committed
# (#1628 D-4). Every case below pairs a verdict with the marker file, because the
# label the runner prints about itself is not evidence that a gate ran.
rc_dirty=$(new_repo require-commit-dirty)
echo scratch > "$rc_dirty/work.txt"

marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
export CMATE_VERIFY_TEST_MARKER
run_verify --config "$FIXTURES/require-commit.yaml" --cwd "$rc_dirty" --base-ref "$BASE_BRANCH"
assert_eq "requireCommit: an uncommitted change alone is exit 21" "21" "$RC"
assert_has "requireCommit: the flag is echoed in the gate line" "$OUT" \
  "GATE work-evidence FAIL commits=0 uncommitted=1 requireCommit=true"
assert_has "requireCommit: verdict is not_started" "$OUT" "RESULT not_started"
assert_has "requireCommit: FAIL over a dirty tree explains itself on stderr" "$ERR" \
  "options.requireCommit is set: uncommitted changes are not work evidence, commit them."
assert_lacks "requireCommit: the reason stays off stdout" "$RAWOUT" "not work evidence"
assert_stdout_contract "requireCommit: stdout holds only GATE/RESULT records" "$RAWOUT"
assert_file_absent "requireCommit: no command gate is executed" "$marker"

# Pairs with the case above: same repo, same fixture, only the commit differs. A
# runner that rejected everything would otherwise look correct.
git -C "$rc_dirty" add -A >/dev/null 2>&1
git -C "$rc_dirty" commit -q -m work
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/require-commit.yaml" --cwd "$rc_dirty" --base-ref "$BASE_BRANCH"
assert_eq "requireCommit: the same change committed is exit 0" "0" "$RC"
assert_has "requireCommit: the commit is counted" "$OUT" \
  "GATE work-evidence PASS commits=1 uncommitted=0 requireCommit=true"
assert_has "requireCommit: verdict is passed" "$OUT" "RESULT passed"
assert_file_present "requireCommit: the command gate ran" "$marker"

# ...and the opposite pairing: the same dirty tree under the default option is
# still work evidence, so the new branch cannot be firing unconditionally.
rc_default=$(new_repo require-commit-default)
echo scratch > "$rc_default/work.txt"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$rc_default" --base-ref "$BASE_BRANCH"
assert_eq "requireCommit: absent by default, so a dirty tree passes" "0" "$RC"
assert_lacks "requireCommit: the flag is not echoed when it is off" "$RAWOUT" "requireCommit"
assert_file_present "requireCommit: the command gate ran under the default" "$marker"

# Zero work is still plain not_started: the requireCommit reason would be the
# wrong diagnosis for a repository where nothing happened at all.
rc_empty=$(new_repo require-commit-empty)
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/require-commit.yaml" --cwd "$rc_empty" --base-ref "$BASE_BRANCH"
assert_eq "requireCommit: zero work is still exit 21" "21" "$RC"
assert_has "requireCommit: zero work reports both counters" "$OUT" \
  "GATE work-evidence FAIL commits=0 uncommitted=0 requireCommit=true"
assert_lacks "requireCommit: zero work is not blamed on the commit rule" "$ERR" \
  "not work evidence"
assert_file_absent "requireCommit: zero work runs no command gate" "$marker"

# --skip-work-evidence still bypasses the whole gate, requireCommit included:
# the flag turns the gate off, it does not soften it.
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/require-commit.yaml" --cwd "$rc_empty" --base-ref "$BASE_BRANCH" --skip-work-evidence
assert_eq "requireCommit: --skip-work-evidence bypasses it" "0" "$RC"
assert_has "requireCommit: the gate reports the flag skip" "$OUT" "GATE work-evidence SKIP reason=flag"
assert_file_present "requireCommit: the command gate ran after the skip" "$marker"

# --- 18. contract files are not work evidence (Issue #1651 / #1580) -----------
# `.commandmate/tasks/` is the orchestrator's own evidence. A worktree holding
# nothing but the contract that was just dropped into it is a worktree where the
# agent did nothing, and reporting `RESULT passed` over it is the same defect
# class as #1628 D-4: a pass over something nobody looked at. Every case pairs
# the verdict with the marker file, because the label the runner prints about
# itself is not evidence that a gate ran.
ct=$(new_repo contract-only)
mkdir -p "$ct/.commandmate/tasks"
printf 'version: 1\ntitle: t\n' > "$ct/.commandmate/tasks/issue-1651.yaml"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
export CMATE_VERIFY_TEST_MARKER
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$ct" --base-ref "$BASE_BRANCH"
assert_eq "contract: an untracked contract file alone is exit 21" "21" "$RC"
assert_has "contract: neither counter sees it" "$OUT" \
  "GATE work-evidence FAIL commits=0 uncommitted=0"
assert_has "contract: verdict is not_started" "$OUT" "RESULT not_started"
# Without -uall this entry is `?? .commandmate/`, which does not match the
# prefix and comes back as work — so this case also pins the untracked mode.
assert_has "contract: two zeroes over a dirty tree explain themselves on stderr" "$ERR" \
  "the only changes here are execution contracts under .commandmate/tasks/"
assert_lacks "contract: the reason stays off stdout" "$RAWOUT" "execution contracts"
assert_stdout_contract "contract: stdout holds only GATE/RESULT records" "$RAWOUT"
assert_file_absent "contract: no command gate is executed" "$marker"

# A setup commit carrying only the contract is not a commit's worth of work
# either. This is the pathspec half of the exclusion.
git -C "$ct" add -A >/dev/null 2>&1
git -C "$ct" commit -q -m "setup: contract"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$ct" --base-ref "$BASE_BRANCH"
assert_eq "contract: a commit carrying only the contract is still exit 21" "21" "$RC"
assert_has "contract: the setup commit is not counted" "$OUT" \
  "GATE work-evidence FAIL commits=0 uncommitted=0"
assert_file_absent "contract: the setup commit runs no command gate" "$marker"

# The countering half: real work in the very same tree is still counted, so the
# exclusion cannot be a blanket off switch for the gate.
printf 'agent output\n' > "$ct/work.txt"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$ct" --base-ref "$BASE_BRANCH"
assert_eq "contract: real work beside the contract is exit 0" "0" "$RC"
assert_has "contract: only the non-contract entry is counted" "$OUT" \
  "GATE work-evidence PASS commits=0 uncommitted=1"
assert_lacks "contract: a passing gate prints no exclusion note" "$ERR" "execution contracts"
assert_file_present "contract: the command gate ran" "$marker"

git -C "$ct" add -A >/dev/null 2>&1
git -C "$ct" commit -q -m work
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$ct" --base-ref "$BASE_BRANCH"
assert_eq "contract: a commit touching real files is exit 0" "0" "$RC"
assert_has "contract: the commit that carries real work is counted" "$OUT" \
  "GATE work-evidence PASS commits=1 uncommitted=0"
assert_file_present "contract: the command gate ran after the work commit" "$marker"

# An entry counts when ANY of its paths is outside the contract directory, so a
# rename that moves the contract into real work is a change — in both
# directions. Judging the destination alone would miss the second one.
ren=$(new_repo contract-rename)
mkdir -p "$ren/.commandmate/tasks"
printf 'version: 1\ntitle: t\n' > "$ren/.commandmate/tasks/issue-1651.yaml"
git -C "$ren" add -A >/dev/null 2>&1
git -C "$ren" commit -q -m "setup: contract"
mkdir -p "$ren/src"
git -C "$ren" mv .commandmate/tasks/issue-1651.yaml "src/real work.yaml"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$ren" --base-ref "$BASE_BRANCH"
assert_eq "contract-rename: contract moved into real work is exit 0" "0" "$RC"
assert_has "contract-rename: the rename counts as one change" "$OUT" \
  "GATE work-evidence PASS commits=0 uncommitted=1"
assert_file_present "contract-rename: the command gate ran" "$marker"

git -C "$ren" add -A >/dev/null 2>&1
git -C "$ren" commit -q -m "rename out"
git -C "$ren" mv "src/real work.yaml" .commandmate/tasks/issue-1651.yaml
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$ren" --base-ref "$BASE_BRANCH"
assert_eq "contract-rename: real work moved into the contract dir is exit 0" "0" "$RC"
assert_has "contract-rename: the origin path outside the contract still counts" "$OUT" \
  "uncommitted=1"
assert_file_present "contract-rename: the command gate ran on the reverse rename" "$marker"

# Paths the human porcelain format would C-quote. Read through `--porcelain`
# without -z the entry below is `?? ".commandmate/tasks/issue 1651.yaml"`, whose
# leading quote does not match the prefix — i.e. the contract would be counted.
sp=$(new_repo contract-spaces)
mkdir -p "$sp/.commandmate/tasks"
printf 'version: 1\n' > "$sp/.commandmate/tasks/issue 1651.yaml"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$sp" --base-ref "$BASE_BRANCH"
assert_eq "contract-spaces: a quoted contract path is still excluded" "21" "$RC"
assert_has "contract-spaces: neither counter sees it" "$OUT" \
  "GATE work-evidence FAIL commits=0 uncommitted=0"
assert_file_absent "contract-spaces: no command gate is executed" "$marker"

printf 'x\n' > "$sp/a real file.txt"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$sp" --base-ref "$BASE_BRANCH"
assert_eq "contract-spaces: a quoted non-contract path is counted" "0" "$RC"
assert_has "contract-spaces: exactly the one real file is counted" "$OUT" \
  "GATE work-evidence PASS commits=0 uncommitted=1"
assert_file_present "contract-spaces: the command gate ran" "$marker"

# -uall, stated as its own assertion: a fresh untracked directory is judged file
# by file. Under the default untracked mode this reports 1 (the directory), which
# used to be a pinned divergence from the TS engine (#1639 -> #1651).
ua=$(new_repo untracked-dir)
mkdir -p "$ua/generated"
printf 'a\n' > "$ua/generated/a.txt"
printf 'b\n' > "$ua/generated/b.txt"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/side-effect.yaml" --cwd "$ua" --base-ref "$BASE_BRANCH"
assert_eq "untracked-dir: exit code is 0" "0" "$RC"
assert_has "untracked-dir: a new directory is counted per file, not once" "$OUT" \
  "GATE work-evidence PASS commits=0 uncommitted=2"
assert_file_present "untracked-dir: the command gate ran" "$marker"

# --- 20. mutex, retry/FLAKY and env injection (Issues #223 / #224) ------------
#
# CM_VERIFY_LOCK_ROOT is not optional here. A suite that took its locks under the
# real ~/.commandmate/locks would serialize against — and be failed by — the
# parallel worktrees a developer has running on the same machine, which is the
# exact false red this feature exists to remove.
LOCK_ROOT="$SANDBOX/locks"
CM_VERIFY_LOCK_ROOT="$LOCK_ROOT"
export CM_VERIFY_LOCK_ROOT
LOCK_DIR="$LOCK_ROOT/cmate-verify-selftest.lock"

mx=$(new_repo mutex-and-retry)
printf 'agent output\n' > "$mx/work.txt"
git -C "$mx" add -A >/dev/null 2>&1
git -C "$mx" commit -q -m work

# The non-regression first: a gate that declares no mutex prints no `waited=`, so
# a repository that does not use the feature sees byte-identical output.
run_verify --config "$FIXTURES/all-pass.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_lacks "mutex: a gate without a mutex prints no waited=" "$RAWOUT" "waited="

# --- FLAKY, default: a retry does not make the gate weaker --------------------
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/retry-flaky.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "flaky-default: exit code is 20" "20" "$RC"
assert_has "flaky-default: the gate is FLAKY, not PASS and not FAIL" "$OUT" "GATE unit FLAKY exit=1,0 duration="
assert_has "flaky-default: the run continues past a FLAKY gate" "$OUT" "GATE after PASS exit=0 duration="
assert_has "flaky-default: FLAKY counts as a failure by default" "$OUT" "RESULT failed"
assert_stdout_contract "flaky-default: stdout holds only GATE/RESULT records" "$RAWOUT"
assert_has "flaky-default: the machine-readable anchor is written" "$ERR" "[flaky] runs=2 outcome=flaky exit=1,0 duration="
assert_has "flaky-default: the anchor records how the run counted it" "$ERR" "verdict=fail"
# Both runs' logs are kept: "what differed between the two" is the single
# question this feature exists to answer, and one log cannot answer it.
assert_has "flaky-default: run 1 is on the record" "$ERR" "first-run-red"
assert_has "flaky-default: run 2 is on the record" "$ERR" "second-run-green"
assert_has "flaky-default: run 1 is labelled" "$ERR" "--- [flaky] run 1/2: failed exit=1 duration="
assert_has "flaky-default: run 2 is labelled" "$ERR" "--- [flaky] run 2/2: passed exit=0 duration="
assert_lacks "flaky-default: the log tail stays off stdout" "$RAWOUT" "first-run-red"

# --- FLAKY, tolerated: same word, different verdict ---------------------------
# The two-point pair. Only `flakyIsPass` differs between the two fixtures, and
# only the RESULT and the exit code may move: spelling a tolerated FLAKY as PASS
# would erase the one fact this feature exists to make visible.
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/retry-flaky-pass.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "flaky-tolerated: exit code is 0" "0" "$RC"
assert_has "flaky-tolerated: the word does not change with flakyIsPass" "$OUT" "GATE unit FLAKY exit=1,0 duration="
assert_lacks "flaky-tolerated: a tolerated FLAKY is never spelled PASS" "$RAWOUT" "GATE unit PASS"
assert_has "flaky-tolerated: the verdict is passed" "$OUT" "RESULT passed"
assert_has "flaky-tolerated: the anchor records the toleration" "$ERR" "verdict=pass"
assert_stdout_contract "flaky-tolerated: stdout holds only GATE/RESULT records" "$RAWOUT"

# --- two failures are not a flake --------------------------------------------
run_verify --config "$FIXTURES/retry-hard-fail.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "retry-hard-fail: exit code is 20" "20" "$RC"
assert_has "retry-hard-fail: the retry agreed, so the gate stays FAIL" "$OUT" "GATE unit FAIL exit=3,3 duration="
assert_lacks "retry-hard-fail: a gate that failed twice is never FLAKY" "$RAWOUT" "FLAKY"
assert_has "retry-hard-fail: flakyIsPass cannot reach outside FLAKY" "$OUT" "RESULT failed"
# Written for the failing outcome too: two failures are evidence AGAINST
# flakiness, and an advisor mining this needs the denominator.
assert_has "retry-hard-fail: the anchor is written for outcome=fail as well" "$ERR" "[flaky] runs=2 outcome=fail exit=3,3 duration="

# --- exactly one retry, never two --------------------------------------------
# The bound is the whole feature: enough re-runs turn any red green, so a runner
# that retried twice would report this gate — which passes on its third run —
# as FLAKY and green. The attempt counter is what makes that measurable instead
# of inferred from the verdict.
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
: > "$marker"
run_verify --config "$FIXTURES/retry-thrice.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "retry-once: exit code is 20" "20" "$RC"
assert_has "retry-once: two failures stay a FAIL" "$OUT" "GATE unit FAIL exit=1,1 duration="
assert_lacks "retry-once: a third run would have made it FLAKY" "$RAWOUT" "FLAKY"
assert_eq "retry-once: the command ran exactly twice" "2" "$(wc -c < "$marker" | tr -d ' ')"

# --- a TIMEOUT is never retried ----------------------------------------------
started=$(date +%s)
run_verify --config "$FIXTURES/retry-timeout.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
elapsed=$(( $(date +%s) - started ))
assert_eq "retry-timeout: exit code is 20" "20" "$RC"
assert_has "retry-timeout: the gate times out once" "$OUT" "GATE slow TIMEOUT exit=124 duration="
assert_lacks "retry-timeout: a timed-out gate is not run a second time" "$RAWOUT" "exit=124,"
assert_lacks "retry-timeout: no flaky anchor is written for it" "$ERR" "[flaky] runs=2"
assert_le "retry-timeout: the budget is not doubled" "$elapsed" "15"

# --- the lock is a real machine-wide lock ------------------------------------
# Two runs of the same fixture at once. The first holds the resource for 3s; the
# second must WAIT for it, and must report that wait separately from its own
# duration. Folding the two together is the mutation this pair is here to catch.
CMATE_VERIFY_TEST_HOLD=3
export CMATE_VERIFY_TEST_HOLD
bash "$RUNNER" --config "$FIXTURES/mutex.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH" \
  > "$SANDBOX/mutex-a.out" 2> "$SANDBOX/mutex-a.err" &
holder_pid=$!
sleep 1
# While it is held: the lock is a DIRECTORY at <root>/<name>.lock carrying an
# owner record. The path convention and the mkdir primitive are the contract —
# CommandMate's runner and this one are started independently against the same
# machine, so a lock that differs in either is not a lock at all.
assert_file_present "mutex: the lock is created at <root>/<name>.lock" "$LOCK_DIR"
if [ -d "$LOCK_DIR" ]; then ok "mutex: the lock is a directory (mkdir, not flock)"; else notok "mutex: the lock is a directory (mkdir, not flock)"; fi
assert_file_present "mutex: the lock carries an owner record" "$LOCK_DIR/owner"
assert_has "mutex: the owner record names the holding process" "$LOCK_DIR/owner" '"pid":'
assert_has "mutex: the owner record names the host" "$LOCK_DIR/owner" '"host":'
# Without the token an owner whose lock was broken as stale would delete the NEXT
# holder's directory on release, handing the resource to two runs at once.
assert_has "mutex: the owner record carries an acquisition token" "$LOCK_DIR/owner" '"token":'

CMATE_VERIFY_TEST_HOLD=0
run_verify --config "$FIXTURES/mutex.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
wait "$holder_pid" 2>/dev/null
assert_eq "mutex: the waiting run still passes" "0" "$RC"
assert_has "mutex: the waiter reports its wait" "$OUT" "GATE e2e PASS exit=0 duration="
waited=$(sed -n 's/^GATE e2e PASS exit=0 duration=\([0-9]*\)s waited=\([0-9]*\)s$/\2/p' "$RAWOUT")
duration=$(sed -n 's/^GATE e2e PASS exit=0 duration=\([0-9]*\)s waited=\([0-9]*\)s$/\1/p' "$RAWOUT")
if [ -n "$waited" ] && [ "$waited" -ge 1 ]; then
  ok "mutex: the second run really queued (waited=${waited}s)"
else
  notok "mutex: the second run really queued (waited=[$waited] in $(cat "$RAWOUT"))"
fi
# The load-bearing half: the wait is NOT inside the duration. The command sleeps
# 0s here, so a duration that had the ~2s wait folded into it would be >= 2.
if [ -n "$duration" ] && [ "$duration" -le 1 ]; then
  ok "mutex: waited is reported beside duration, never added to it (duration=${duration}s)"
else
  notok "mutex: waited is reported beside duration, never added to it (duration=[$duration], waited=[$waited])"
fi
# `duration=3s` used to be matched literally here, and that is not a fact this
# runner promises: it measures whole seconds with `date +%s` (bash 3.2 ships no
# sub-second date), so a 3s hold that starts just before a second boundary reads
# as 4. Measured while running the suite 20x for Issue #228: red in 1 of 20 runs
# on macOS AND in 1 of 20 on Linux/ARM64, for a reason that has nothing to do
# with what the assertion is for. What it IS for is the `waited=0s` half — a
# mutexed gate that did not queue still has to say so, or "serialized and got the
# lock straight away" and "not serialized at all" stop being tellable apart
# (verification-config.md section 9.3). So the two halves are asserted apart: the
# wait exactly, the duration as a lower bound.
holder_waited=$(sed -n 's/^GATE e2e PASS exit=0 duration=\([0-9]*\)s waited=\([0-9]*\)s$/\2/p' "$SANDBOX/mutex-a.out")
holder_duration=$(sed -n 's/^GATE e2e PASS exit=0 duration=\([0-9]*\)s waited=\([0-9]*\)s$/\1/p' "$SANDBOX/mutex-a.out")
# Issue #1950: this was `assert_eq ... "0" "$holder_waited"`, exactly, and it went
# red under parallel load with `expected [0], got [1]` on a run where nothing was
# wrong. That is the SAME whole-second granularity the comment above already
# documents for `duration=3s`: `date +%s` has no sub-second half (bash 3.2), so a
# wait of zero that straddles a second boundary reads as 1. The duration half was
# loosened for that reason in #228 and the wait half was not, which left one
# literal digit as the only load-fragile assertion in this file.
#
# The fact being asserted is named in that comment and is NOT the digit: a mutexed
# gate that did not queue still has to SAY so, or "serialized and got the lock
# straight away" and "not serialized at all" stop being tellable apart (section
# 9.3). That fact is the FIELD's presence — `waited_field()` in verify-run.sh
# prints nothing whatsoever when the gate declared no mutex, so an empty capture
# here IS "not serialized at all", and it is what this now checks first.
#
# The value is not discarded either. The holder is the run that went FIRST, so its
# wait has to be strictly shorter than the wait of the run that queued behind it.
# Both numbers are measured on the same machine seconds apart, so load moves them
# together: there is no machine speed at which a correct runner fails this, while
# a holder that somehow waited as long as its own queue still fails it.
if [ -n "$holder_waited" ] && [ -n "$waited" ] && [ "$holder_waited" -lt "$waited" ]; then
  ok "mutex: the first run declares a wait of zero rather than nothing (waited=${holder_waited}s, against ${waited}s for the run that queued behind it)"
else
  notok "mutex: the first run declares a wait of zero rather than nothing (holder waited=[$holder_waited], queued run waited=[$waited] in $(cat "$SANDBOX/mutex-a.out"))"
fi
if [ -n "$holder_duration" ] && [ "$holder_duration" -ge 3 ]; then
  ok "mutex: the first run's duration is its own 3s hold, not the waiter's (duration=${holder_duration}s)"
else
  notok "mutex: the first run's duration is its own 3s hold, not the waiter's (duration=[$holder_duration] in $(cat "$SANDBOX/mutex-a.out"))"
fi
assert_has "mutex: the line-anchored marker carries the wait too" "$ERR" "[mutex] name=cmate-verify-selftest waited="
assert_has "mutex: the marker names the lock path" "$ERR" "lock=$LOCK_DIR"
assert_file_absent "mutex: the lock is released when the gate finishes" "$LOCK_DIR"

# --- the default lock root is the path convention, not this suite's override --
# CM_VERIFY_LOCK_ROOT exists so a suite never touches the developer's real locks,
# which means every assertion above is about the OVERRIDE. The convention itself
# — `~/.commandmate/locks/<name>.lock` — is what makes CommandMate's runner and
# this one exclude each other, so it is measured too, with HOME pointed at a
# sandbox instead of the override.
fakehome="$SANDBOX/fakehome"
mkdir -p "$fakehome"
CMATE_VERIFY_TEST_HOLD=3
export CMATE_VERIFY_TEST_HOLD
( unset CM_VERIFY_LOCK_ROOT; HOME="$fakehome" bash "$RUNNER" --config "$FIXTURES/mutex.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH" ) \
  > "$SANDBOX/homelock.out" 2> "$SANDBOX/homelock.err" &
home_pid=$!
sleep 1
assert_file_present "default-lock-root: the lock lands at \$HOME/.commandmate/locks/<name>.lock" \
  "$fakehome/.commandmate/locks/cmate-verify-selftest.lock"
wait "$home_pid" 2>/dev/null
assert_has "default-lock-root: the run still passes" "$SANDBOX/homelock.out" "GATE e2e PASS exit=0 duration="
assert_file_absent "default-lock-root: and is released afterwards" "$fakehome/.commandmate/locks/cmate-verify-selftest.lock"
CMATE_VERIFY_TEST_HOLD=0

# --- the lock never comes free -----------------------------------------------
# A record from another host is never broken: a pid from elsewhere says nothing
# about a process here, and breaking a lock on that guess lets two machines
# sharing a network home run the gate at once.
mkdir -p "$LOCK_DIR"
printf '{"pid":1,"host":"some-other-host.invalid","token":"held-elsewhere","acquiredAt":0}\n' > "$LOCK_DIR/owner"
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/mutex-short.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "mutex-wait: a run that could not judge is not passed" "22" "$RC"
assert_has "mutex-wait: the gate is SKIP with its own reason" "$OUT" "GATE e2e SKIP reason=mutex-wait waited="
assert_lacks "mutex-wait: a lock that never came free is not a TIMEOUT" "$RAWOUT" "GATE e2e TIMEOUT"
assert_lacks "mutex-wait: nor a verdict on the work" "$RAWOUT" "GATE e2e FAIL"
assert_file_absent "mutex-wait: the command is never started" "$marker"
assert_has "mutex-wait: the run continues to the next gate" "$OUT" "GATE after PASS exit=0 duration="
assert_has "mutex-wait: the verdict is not passed" "$OUT" "RESULT skipped"
assert_lacks "mutex-wait: a gate that reached no verdict never reports passed" "$RAWOUT" "RESULT passed"
assert_has "mutex-wait: the reason says it is a resource conflict, not a verdict" "$ERR" "This is a resource conflict, not a verdict on the work"
assert_has "mutex-wait: a foreign holder is named rather than evicted" "$ERR" "some-other-host.invalid"
assert_file_present "mutex-wait: a foreign host's lock is left alone" "$LOCK_DIR"
assert_stdout_contract "mutex-wait: stdout holds only GATE/RESULT records" "$RAWOUT"
rm -rf "$LOCK_DIR"

# --- a dead holder on this host does not wedge the machine -------------------
( : ) & dead_pid=$!
wait "$dead_pid" 2>/dev/null
mkdir -p "$LOCK_DIR"
printf '{"pid":%s,"host":"%s","token":"held-by-a-corpse","acquiredAt":0}\n' \
  "$dead_pid" "$(hostname)" > "$LOCK_DIR/owner"
CMATE_VERIFY_TEST_HOLD=0
run_verify --config "$FIXTURES/mutex.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "stale-lock: a lock left by a dead process does not block the run" "0" "$RC"
assert_has "stale-lock: the gate really ran" "$OUT" "GATE e2e PASS exit=0 duration="
assert_has "stale-lock: breaking a stale lock is reported" "$ERR" "broke a stale lock"
assert_file_absent "stale-lock: the lock is released again afterwards" "$LOCK_DIR"

# --- mutex and retry together -------------------------------------------------
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
run_verify --config "$FIXTURES/mutex-flaky.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "mutex-flaky: exit code is 20" "20" "$RC"
assert_has "mutex-flaky: both runs and the wait are all reported, each in its own field" "$OUT" \
  "GATE unit FLAKY exit=1,0 duration="
# Issue #1950: the needle here was the literal `waited=0s`, which went red under
# load for the same whole-second reason as the mutex case above. It was also
# weaker than its own name: `assert_has` is a substring match, and a substring
# cannot tell "its own field" from a `waited=` glued onto the end of the duration
# list — which is the exact confusion this assertion exists to rule out. Anchoring
# the whole GATE line checks the shape the name promises (a two-valued duration,
# then a separate `waited=` field) at whatever value the clock reports.
if grep -Eq '^GATE unit FLAKY exit=1,0 duration=[0-9]+(\.[0-9]+)?s,[0-9]+(\.[0-9]+)?s waited=[0-9]+(\.[0-9]+)?s$' "$OUT"; then
  ok "mutex-flaky: the wait keeps its own field beside a two-valued duration"
else
  notok "mutex-flaky: the wait keeps its own field beside a two-valued duration (no GATE line of that shape in $OUT: $(grep '^GATE unit' "$OUT" | head -1))"
fi
assert_file_absent "mutex-flaky: the lock is released per attempt, not held across both" "$LOCK_DIR"
unset CMATE_VERIFY_TEST_HOLD

# --- 21. the per-worktree environment is the caller's (Issue #223) ------------
# This runner does not number worktrees and must not invent a number: a number
# that disagreed with CommandMate's would put the gate on a port the product run
# has already claimed. So whatever the caller exported is inherited unchanged,
# and a gate carries its own default for the case where nobody exported anything.
marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
unset CM_WORKTREE_INDEX 2>/dev/null || true
unset CM_WORKTREE_ID 2>/dev/null || true
run_verify --config "$FIXTURES/worktree-env.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "worktree-env: an unset environment still runs the gate" "0" "$RC"
assert_has "worktree-env: the gate's own default applies when nobody exported one" "$marker" "index=0 id=none"

marker=$(new_marker)
CMATE_VERIFY_TEST_MARKER="$marker"
CM_WORKTREE_INDEX=7
CM_WORKTREE_ID=demo-app-feature-x
export CM_WORKTREE_INDEX CM_WORKTREE_ID
run_verify --config "$FIXTURES/worktree-env.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "worktree-env: an exported environment still runs the gate" "0" "$RC"
assert_has "worktree-env: the caller's numbering is passed through untouched" "$marker" "index=7 id=demo-app-feature-x"
unset CM_WORKTREE_INDEX
unset CM_WORKTREE_ID

# --- 22. options.requireEnvClean is accepted and reported ---------------------
# CommandMate #1740 added the key; both parsers here rejected it with exit 2
# until #223, so a repository that used it could not run this runner at all.
# Accepting it is not the same as judging it: the built-in gate compares the
# machine against a snapshot taken when the task was created, and a run started
# from a shell is attached to no task.
run_verify --config "$FIXTURES/require-env-clean.yaml" --cwd "$mx" --base-ref "$BASE_BRANCH"
assert_eq "require-env-clean: the key no longer makes the config unreadable" "0" "$RC"
assert_has "require-env-clean: the built-in is named rather than silently dropped" "$OUT" "GATE env-clean SKIP reason=no-baseline"
assert_has "require-env-clean: the declared gates still run" "$OUT" "GATE ok PASS exit=0 duration="
assert_has "require-env-clean: the reason says what is missing" "$ERR" "needs the baseline snapshot CommandMate records at task creation"
assert_stdout_contract "require-env-clean: stdout holds only GATE/RESULT records" "$RAWOUT"

# --- 23. the run directory outlives the run (Issue #228) ---------------------
# The defect this pins: a gate that finishes before the runner has forked its
# timeout watchdog makes `wait` return at once, so the `kill` that stops that
# watchdog lands in the window where the freshly forked child still carries this
# shell's EXIT trap AND bash's own terminating-signal handler. The child then ran
# `rm -rf "$WORKDIR"` mid-run, and every later gate reported `no output captured`
# with exit 1 — a verdict on nothing, in a runner whose whole job is adjudication.
# It was probabilistic (measured ~1% per gate on Linux/ARM64), which is why the
# case is many fast gates repeated: one green run is not evidence.
#
# Bounded on purpose. 48 gates x 12 runs is what turned the pre-fix runner red in
# 20 of 20 measured repetitions; a smaller case was red in only 15 of 20, and a
# regression test that misses one time in four is how this comes back silently.
wl_runs=12
wl_gates=48
wl_lost=0
wl_markers=0
# The set of exit codes seen, not a count of wrong ones: a failure has to say
# WHICH verdict the runner reached instead, or the next reader is back to
# reproducing a probabilistic CI red by hand.
wl_rcs=""
# out.N of the FIRST run that deviated in any way. A probabilistic case is only
# worth its red if the red names the run that produced it: `FAIL_CONTEXT` is
# otherwise still pointing at the last (healthy) run when the assertions below
# fire, and the sandbox holding every err.N is gone by the time anyone reads CI.
wl_ctx=""
# The runner puts $WORKDIR under $TMPDIR, so pointing it at an empty directory of
# our own makes "was every one of them removed again" answerable by counting,
# without depending on what else on this machine writes to /tmp.
wl_tmp="$SANDBOX/workdir-lifetime-tmp"
mkdir -p "$wl_tmp"
wl_tmpdir_was_set=0
wl_tmpdir_saved=""
if [ -n "${TMPDIR+set}" ]; then wl_tmpdir_was_set=1; wl_tmpdir_saved=$TMPDIR; fi
TMPDIR="$wl_tmp"
export TMPDIR
wl_i=0
while [ "$wl_i" -lt "$wl_runs" ]; do
  wl_i=$((wl_i + 1))
  run_verify --config "$FIXTURES/workdir-lifetime.yaml" --cwd "$repo" --base-ref "$BASE_BRANCH"
  case " $wl_rcs " in *" $RC "*) ;; *) wl_rcs="$wl_rcs $RC";; esac
  # Both halves of the signature: the shell's own complaint about the vanished
  # redirect target, and the empty-log report the runner then prints for a gate
  # that did in fact run.
  wl_run_lost=0
  if grep -aFq "No such file or directory" "$ERR"; then wl_run_lost=$((wl_run_lost + 1)); fi
  if grep -aFq "no output captured" "$ERR"; then wl_run_lost=$((wl_run_lost + 1)); fi
  wl_lost=$((wl_lost + wl_run_lost))
  wl_run_markers=$(grep -ac -e '-ran' "$ERR")
  wl_markers=$((wl_markers + wl_run_markers))
  if [ -z "$wl_ctx" ] \
     && { [ "$wl_run_lost" -ne 0 ] || [ "$wl_run_markers" -ne "$wl_gates" ] || [ "$RC" -ne 20 ]; }; then
    wl_ctx=$OUT
  fi
done
if [ "$wl_tmpdir_was_set" -eq 1 ]; then TMPDIR=$wl_tmpdir_saved; export TMPDIR; else unset TMPDIR; fi
if [ -n "$wl_ctx" ]; then FAIL_CONTEXT=$wl_ctx; FAIL_CONTEXT_SHOWN=0; fi
assert_eq "workdir-lifetime: no run loses its work directory while it is still running" "0" "$wl_lost"
assert_eq "workdir-lifetime: every gate's own output survives into the log tail" \
  "$((wl_runs * wl_gates))" "$wl_markers"
assert_eq "workdir-lifetime: every run still reaches the verdict its gates earned" "20" "${wl_rcs# }"
# The other half of the same contract: whoever is allowed to remove the directory
# must still do it. A guard that never fires would pass the assertions above by
# leaking one directory per run instead.
assert_eq "workdir-lifetime: the work directory is removed when the run really ends" \
  "0" "$(ls -1 "$wl_tmp" 2>/dev/null | wc -l | tr -d ' ')"

# --- summary ------------------------------------------------------------------
total=$((TOTAL_PASS + TOTAL_FAIL))
echo "# tests: $TOTAL_PASS passed, $TOTAL_FAIL failed"
if [ "$total" -lt "$MIN_ASSERTIONS" ]; then
  echo "not ok - suite ran only $total assertions (expected at least $MIN_ASSERTIONS)"
  exit 1
fi
[ "$TOTAL_FAIL" -eq 0 ] || exit 1
exit 0
