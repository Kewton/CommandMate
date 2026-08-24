import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REAL_SHELL_CONCURRENT_FULL_RUNS,
  REAL_SHELL_GUARD_MARGIN_MIN,
  REAL_SHELL_LOAD_SWEEP,
  REAL_SHELL_MARKERS,
  REAL_SHELL_SIZING_CONCURRENCY,
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  REAL_SHELL_TEST_TIMEOUT_MS,
  assertSubprocessCompleted,
  startsRealSubprocess,
} from '../../helpers/real-shell-budget';

const REPO = process.cwd();
const SETUP = path.join(REPO, 'tests/setup.ts');
const RECORD = path.join(REPO, 'docs/qa/1985-real-shell-budget-concurrency.md');

/**
 * Issue #1950. This file is itself a member of the family it guards — it starts
 * real subprocesses — which is deliberate: the behavioural test below can only
 * pass if the wiring it is checking applied to this very file.
 */
describe('real-shell test budget (Issue #1950)', () => {
  it('gives a test that starts a real subprocess more than the 5000ms default', () => {
    // The whole fix, stated as behaviour rather than as a constant. `sleep 6`
    // is longer than vitest's default per-test budget and shorter than the
    // family budget, so this test passes ONLY while tests/setup.ts is still
    // raising the budget for files that shell out. Delete that wiring, narrow
    // REAL_SHELL_MARKERS so this file stops matching, or drop the budget back
    // under 6s, and this goes red with `Test timed out in 5000ms` — the exact
    // failure #1950 was reported for.
    //
    // No explicit per-test timeout argument here on purpose: supplying one
    // would override the inherited budget and make the assertion vacuous.
    const started = Date.now();
    execFileSync('sleep', ['6'], { timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
  });

  it('keeps the subprocess guard reachable by staying under the test budget', () => {
    // The ordering IS the fix. Before #1950 the family's guards were 15_000
    // while the budget was vitest's 5_000 default, so no guard could ever fire:
    // the wall clock always won and reported a timeout that named nothing.
    expect(REAL_SHELL_SUBPROCESS_TIMEOUT_MS).toBeLessThan(REAL_SHELL_TEST_TIMEOUT_MS);
    // Room for an `it()` that makes more than one guarded call in sequence.
    expect(REAL_SHELL_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      REAL_SHELL_SUBPROCESS_TIMEOUT_MS * 2,
    );
  });

  it('classifies exactly the file set the Issue counted with grep', () => {
    // Two independent implementations of "starts a real subprocess" — the
    // shell pipeline #1950 used to size the family, and the predicate the
    // suite actually runs on — compared against each other. Narrowing the
    // predicate to make a flake go away would show up here as a disagreement
    // rather than as silence.
    const grepped = execFileSync(
      'grep',
      ['-rl', 'execFileSync\\|spawnSync\\|/bin/sh\\|execSync', 'tests/unit', '--include=*.test.ts'],
      { cwd: REPO, encoding: 'utf8', timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS },
    )
      .split('\n')
      .filter(Boolean)
      .sort();

    // A guard that silently matched nothing would pass every assertion below.
    expect(grepped.length).toBeGreaterThan(60);

    const disagreements = grepped.filter(
      (file) => !startsRealSubprocess(readFileSync(path.join(REPO, file), 'utf8')),
    );
    expect(disagreements).toEqual([]);

    // And the predicate must not be a tautology that says yes to everything:
    // a file with no subprocess in it has to come back false.
    expect(startsRealSubprocess('export const answer = 42;\n')).toBe(false);
    expect(REAL_SHELL_MARKERS.test('const x = spawnSync("bash", []);')).toBe(true);
  });

  it('is wired into the setup file every test run loads', () => {
    // vitest.config.ts names tests/setup.ts as the only setupFile, so a budget
    // that lives anywhere else reaches nothing. Pinned by source because the
    // behavioural test above proves the effect but not where it came from.
    const setup = readFileSync(SETUP, 'utf8');
    expect(setup).toContain('startsRealSubprocess');
    expect(setup).toContain('REAL_SHELL_TEST_TIMEOUT_MS');
    expect(setup).toContain('vi.setConfig');

    const config = readFileSync(path.join(REPO, 'vitest.config.ts'), 'utf8');
    expect(config).toContain("setupFiles: ['./tests/setup.ts']");
  });

  /**
   * Issue #1985. The guard's size was defensible and its CONDITION was not
   * written down anywhere, so #1977 read a guard doing its job as a guard that
   * was broken. These pin the derivation rather than the number: the constant
   * may move, but only together with a measurement that justifies it.
   */
  describe('the concurrency the size is valid for (Issue #1985)', () => {
    it('declares a concurrency, and the sweep actually covers it', () => {
      expect(Number.isInteger(REAL_SHELL_CONCURRENT_FULL_RUNS)).toBe(true);
      // At least two: `mutex: cpu.heavy` already permits verify's copy, and a
      // person typing the command is the second. A declaration of 1 would be a
      // claim that nobody may run the suite by hand.
      expect(REAL_SHELL_CONCURRENT_FULL_RUNS).toBeGreaterThanOrEqual(2);
      expect(REAL_SHELL_SIZING_CONCURRENCY).toBe(REAL_SHELL_CONCURRENT_FULL_RUNS + 1);
      expect(REAL_SHELL_LOAD_SWEEP[REAL_SHELL_CONCURRENT_FULL_RUNS]).toBeDefined();
      expect(REAL_SHELL_LOAD_SWEEP[REAL_SHELL_SIZING_CONCURRENCY]).toBeDefined();
    });

    it('holds the declared margin at the concurrency it claims to be sized at', () => {
      // THE assertion of this Issue. Raise the guard without re-measuring and
      // nothing here moves; re-measure a heavier machine without raising the
      // guard and this goes red naming the ratio that fell short.
      const sized = REAL_SHELL_LOAD_SWEEP[REAL_SHELL_SIZING_CONCURRENCY];
      const ratio = REAL_SHELL_SUBPROCESS_TIMEOUT_MS / sized.maxMs;
      expect(ratio).toBeGreaterThanOrEqual(REAL_SHELL_GUARD_MARGIN_MIN);
    });

    it('carries a sweep that reads as a measurement rather than a guess', () => {
      const levels = Object.keys(REAL_SHELL_LOAD_SWEEP)
        .map(Number)
        .sort((a, b) => a - b);
      expect(levels.length).toBeGreaterThanOrEqual(REAL_SHELL_SIZING_CONCURRENCY);
      let previous = { samples: 0, p999Ms: 0, maxMs: 0, peakLoadAvg: 0 };
      for (const level of levels) {
        const row = REAL_SHELL_LOAD_SWEEP[level];
        // Contention costs time, never saves it: every column must climb with
        // the number of suites. A hand-edited row that says otherwise is a
        // typo or an invention, and either way it must not size a guard.
        expect(row.samples).toBeGreaterThan(previous.samples);
        expect(row.p999Ms).toBeGreaterThan(previous.p999Ms);
        expect(row.maxMs).toBeGreaterThan(previous.maxMs);
        expect(row.peakLoadAvg).toBeGreaterThan(previous.peakLoadAvg);
        // p99.9 is a percentile of the same samples the max comes from.
        expect(row.maxMs).toBeGreaterThanOrEqual(row.p999Ms);
        previous = row;
      }
    });

    it('keeps the written record and the constants saying the same thing', () => {
      // The prose is where the reasoning lives and the constants are where the
      // behaviour lives; a repository that lets them disagree has the #1985
      // defect again, one level up. Numbers only, so editing the prose around
      // them stays free.
      const record = readFileSync(RECORD, 'utf8');
      // `NAME = VALUE`, not the bare value: "2" and "3" occur all over a page
      // of prose, so a bare-value check would call any declaration consistent.
      expect(record).toContain(
        `REAL_SHELL_CONCURRENT_FULL_RUNS = ${REAL_SHELL_CONCURRENT_FULL_RUNS}`,
      );
      expect(record).toContain(`REAL_SHELL_SIZING_CONCURRENCY = ${REAL_SHELL_SIZING_CONCURRENCY}`);
      expect(record).toContain(`REAL_SHELL_GUARD_MARGIN_MIN = ${REAL_SHELL_GUARD_MARGIN_MIN}`);
      expect(record).toContain(
        `REAL_SHELL_SUBPROCESS_TIMEOUT_MS = ${REAL_SHELL_SUBPROCESS_TIMEOUT_MS}`,
      );
      expect(record).toContain(`REAL_SHELL_TEST_TIMEOUT_MS = ${REAL_SHELL_TEST_TIMEOUT_MS}`);
      // Every measured row has to be in the record too, so a sweep edited in
      // code alone stops looking sourced.
      for (const level of Object.keys(REAL_SHELL_LOAD_SWEEP).map(Number)) {
        expect(record).toContain(String(REAL_SHELL_LOAD_SWEEP[level].maxMs));
        expect(record).toContain(String(REAL_SHELL_LOAD_SWEEP[level].p999Ms));
      }
    });

    it('names the guard it tripped, on a real subprocess, at the current size', () => {
      // The sibling case below builds the `spawnSync` result by hand. This one
      // starts a real child and lets node's own `timeout` produce ETIMEDOUT, so
      // the reported number is the constant this file is guarding rather than a
      // literal somebody kept in step. 300ms because the guard's SIZE is what
      // the assertions above cover; what this covers is that the message is
      // still wired to the constant.
      const outcome = spawnSync('sleep', ['5'], { timeout: 300 });
      expect((outcome.error as NodeJS.ErrnoException | undefined)?.code).toBe('ETIMEDOUT');
      expect(() => assertSubprocessCompleted(outcome, 'sleep 5')).toThrow(
        new RegExp(`${REAL_SHELL_SUBPROCESS_TIMEOUT_MS}ms guard`),
      );
    });
  });

  describe('assertSubprocessCompleted', () => {
    it('names a tripped guard instead of letting it read as an exit-code diff', () => {
      // The reported shape: node kills the child on `timeout` AND closes its
      // stdio in the same step, so a script that traps SIGPIPE exits 128+13.
      const timedOut = {
        error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        status: 141,
        signal: null,
      };
      expect(() => assertSubprocessCompleted(timedOut, 'monitor.sh')).toThrow(/monitor\.sh/);
      expect(() => assertSubprocessCompleted(timedOut, 'monitor.sh')).toThrow(/did not finish/);
      expect(() => assertSubprocessCompleted(timedOut, 'monitor.sh')).toThrow(/NOT a disagreement/);
    });

    it('says so when the command could not be started at all', () => {
      const missing = {
        error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }),
        status: null,
        signal: null,
      };
      expect(() => assertSubprocessCompleted(missing, 'monitor.sh')).toThrow(/could not be started/);
    });

    it('stays out of the way of a run that finished, however it finished', () => {
      // Including a non-zero exit: a command that ran and failed is a verdict
      // the calling test owns, not a hang.
      expect(() => assertSubprocessCompleted({ status: 0, signal: null }, 'x')).not.toThrow();
      expect(() => assertSubprocessCompleted({ status: 2, signal: null }, 'x')).not.toThrow();
    });
  });
});
