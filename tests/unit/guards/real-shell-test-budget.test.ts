import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REAL_SHELL_MARKERS,
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  REAL_SHELL_TEST_TIMEOUT_MS,
  assertSubprocessCompleted,
  startsRealSubprocess,
} from '../../helpers/real-shell-budget';

const REPO = process.cwd();
const SETUP = path.join(REPO, 'tests/setup.ts');

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
