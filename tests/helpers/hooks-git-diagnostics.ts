/**
 * Issue #2089 — where `hooks-git.sh` keeps its once-per-worker warning markers,
 * and how a test asserts on the lines those markers gate.
 *
 * ## The defect this exists to remove
 *
 * `mh_report_once()` in `.claude/skills/orchestrate-monitor/scripts/hooks-git.sh`
 * prints a WARN/ERROR line at most once per `<worktree-id>.<cause>` key, and it
 * remembers which keys it has already printed as *files*:
 *
 *     MONITOR_HOOKS_STATE_DIR=${MONITOR_HOOKS_STATE_DIR:-${STATE_DIR:-${TMPDIR:-/tmp}/cm-monitor-hooks-$$}}
 *     ...
 *     [ -f "$MONITOR_HOOKS_STATE_DIR/warned-$mh__key" ] && return 0
 *
 * A file, not a shell variable, because monitor.sh calls the counters through
 * `$(...)`; the marker has to survive the subshell. That part is sound. What is
 * not sound is the *fallback* identity, and it burns a caller that sources the
 * hooks without monitor.sh — which is every test in
 * `tests/unit/skills/orchestrate-monitor`:
 *
 *   1. `$$` is the sourcing shell's pid, and pids are recycled (macOS wraps at
 *      ~100k). Two unrelated `bash -c` runs weeks apart can be handed the same
 *      pid and therefore the same directory.
 *   2. Nothing removes those directories. monitor.sh deletes its own STATE_DIR
 *      from an EXIT trap, but a bare `. hooks-git.sh` has no such owner. Measured
 *      on the development machine on 2026-08-27: 4102 `cm-monitor-hooks-*`
 *      directories holding 4163 markers, every key a test fixture id
 *      (`myrepo-feature-x.status`, `nope-nope.no-checkout`, ...).
 *   3. The keys are hard-coded fixture values, so the markers a past run left
 *      behind are exactly the keys the next run wants to print.
 *
 * Together: a fresh run that draws a recycled pid finds a `warned-…` marker it
 * never wrote, and `mh_report_once` returns silently. The diagnostic — the one
 * line that distinguishes "git could not answer" from "the worker did nothing",
 * which #1614 and #1728 exist to keep un-loseable — simply does not appear. The
 * test then reports `expected '' to contain '…'`, which reads like wording drift
 * and is not.
 *
 * That is also why the failure looked load-dependent: parallel runs consume pids
 * faster, so they wrap into the recycled range sooner. The rate rises with every
 * run because the directory count only ever grows. Nothing about it is a timeout.
 *
 * ## The fix, and its granularity
 *
 * Every suite that sources `hooks-git.sh` hands it a state directory of its own,
 * so the marker store is created and destroyed with the test that uses it and
 * `$TMPDIR` is never consulted. The unit is the **test**, not the call: the
 * marker's whole purpose is to survive repeated calls within one run, so
 * `monitor.sh --max-polls 4` must still print its warning exactly once. Isolating
 * per call would assert the opposite of the behaviour under test; isolating per
 * file would leave the tests interfering with each other, which they already
 * were — pin `MONITOR_HOOKS_STATE_DIR` to one empty directory and
 * `prints the git failure a single time across a multi-poll run` goes red,
 * because an earlier test in the same file wrote its key first.
 *
 * @module tests/helpers/hooks-git-diagnostics
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';

import { removeTempDir } from './temp-dir';

/** The env var `hooks-git.sh` reads before falling back to the pid-keyed path. */
export const HOOKS_STATE_DIR_ENV = 'MONITOR_HOOKS_STATE_DIR';

/**
 * Give this suite a per-test `MONITOR_HOOKS_STATE_DIR`.
 *
 * Registers its own `beforeEach`/`afterEach`. The directory is also published on
 * `process.env` so that a spawn site which merely spreads `...process.env` is
 * covered too; call sites should still pass the returned path explicitly, since
 * that is the copy a test cannot accidentally lose to an inherited value.
 *
 * @param prefix - Directory name prefix, so a stray sandbox names its suite
 * @returns A getter for the current test's state directory
 */
export function useIsolatedHooksStateDir(prefix: string): () => string {
  let dir = '';
  let previous: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${prefix}-hooks-state-`));
    previous = process.env[HOOKS_STATE_DIR_ENV];
    process.env[HOOKS_STATE_DIR_ENV] = dir;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[HOOKS_STATE_DIR_ENV];
    } else {
      process.env[HOOKS_STATE_DIR_ENV] = previous;
    }
    removeTempDir(dir);
    dir = '';
  });

  return () => dir;
}

/**
 * Opening words of the failure raised when stderr carried nothing at all.
 *
 * Exported so a test can assert that the *message* still distinguishes the two
 * outcomes — the distinction is the deliverable, not a nicety.
 */
export const NO_DIAGNOSTIC_PREFIX = 'hooks-git.sh printed NO diagnostic at all';

/** Non-empty lines of a captured stderr. */
function stderrLines(stderr: string): string[] {
  return stderr.split('\n').filter((line) => line.trim() !== '');
}

/**
 * Fail with "nothing was printed" when stderr is empty, and say why that is a
 * different verdict from "the wording changed".
 *
 * Issue #2089 request 3: `expected '' to contain '…'` forced a human to
 * re-adjudicate every occurrence, because the message is identical whether the
 * diagnostic was suppressed or merely reworded. Only one of those is ever
 * attributable to the diff under test.
 */
function failIfSilent(stderr: string, context: string, wanted: string): void {
  if (stderrLines(stderr).length > 0) return;
  expect.fail(
    [
      `${context}: ${NO_DIAGNOSTIC_PREFIX} — stderr is empty (0 lines).`,
      `Wanted: ${wanted}.`,
      '',
      'This is "the diagnostic never happened", NOT "the diagnostic said something',
      'else" — there is no text to compare wording against, so this failure is not',
      'a message drift and a diff that only renamed a warning cannot have caused it.',
      '',
      `Known cause (Issue #2089): a stale marker under ${HOOKS_STATE_DIR_ENV}.`,
      'mh_report_once() returns silently when $MONITOR_HOOKS_STATE_DIR/warned-<key>',
      'already exists, and the pid-keyed fallback ($TMPDIR/cm-monitor-hooks-$$) is',
      'shared with every past run that drew the same pid. Check that this suite',
      'still calls useIsolatedHooksStateDir() and still passes the result into the',
      'spawn env.',
    ].join('\n'),
  );
}

/**
 * Assert that `stderr` carries a diagnostic containing `expected`.
 *
 * Empty stderr fails as "no diagnostic at all"; non-empty stderr falls through
 * to `toContain`, whose diff is the right report when a line WAS printed.
 */
export function expectDiagnostic(stderr: string, expected: string, context: string): void {
  failIfSilent(stderr, context, `a diagnostic line containing ${JSON.stringify(expected)}`);
  // The lines are quoted into the message rather than left to vitest's diff,
  // which truncates the received value — and the whole point of this branch is
  // that a reader can see the report exists and read how its wording drifted.
  expect(
    stderr,
    [
      `${context}: a diagnostic WAS printed, but not one containing ${JSON.stringify(expected)}.`,
      'This is a wording difference, not a suppressed report. What was printed:',
      ...stderrLines(stderr).map((line) => `  | ${line}`),
    ].join('\n'),
  ).toContain(expected);
}

/**
 * Assert how many stderr lines match, and return them.
 *
 * The counted form has the same ambiguity as `toContain`: `expected [] to have a
 * length of 1 but got +0` is what a suppressed diagnostic looks like *and* what a
 * renamed one looks like. Both cases are separated here — an empty stderr says so
 * in words, and a non-empty one that matched nothing prints what it did carry.
 */
export function expectDiagnosticLines(
  stderr: string,
  matches: (line: string) => boolean,
  expectedCount: number,
  context: string,
): string[] {
  const lines = stderrLines(stderr);
  const matched = lines.filter(matches);

  if (matched.length === 0 && expectedCount > 0) {
    failIfSilent(stderr, context, `${expectedCount} matching diagnostic line(s)`);
    expect.fail(
      [
        `${context}: stderr carried ${lines.length} line(s), none of which matched.`,
        `Wanted ${expectedCount} matching line(s). What was printed:`,
        ...lines.map((line) => `  | ${line}`),
      ].join('\n'),
    );
  }

  expect(matched, `${context}: matching diagnostic lines`).toHaveLength(expectedCount);
  return matched;
}
