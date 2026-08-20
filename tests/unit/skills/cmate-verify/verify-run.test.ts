import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Thin wrapper around the skill's own fixture suite (Issue #1540).
 *
 * The assertions live in bash because the skill is distributed to repositories
 * that have no vitest — `bash scripts/tests/run-tests.sh` must stand alone there.
 * This file exists so the same suite also gates `npm run test:unit` / CI, and so
 * a suite that silently stops running cases cannot report "0 failed" as green.
 */
const SUITE = path.join(
  process.cwd(),
  '.claude/skills/cmate-verify/scripts/tests/run-tests.sh',
);

// Includes a 1s gate timeout plus sandbox git repos; generous so a slow CI runner
// does not turn this into a flake.
const TIMEOUT_MS = 180_000;

// Floor mirrors MIN_ASSERTIONS in run-tests.sh: a truncated run must not pass
// just because it never reached the failing case. Raised with the mutex / FLAKY /
// requireEnvClean cases ported from skills #223 / #224 (Issue #1861): leaving it
// at 200 would let the whole new section stop running without turning this red.
const MIN_ASSERTIONS = 300;

/**
 * Issue #1607: this wrapper used to assert on `output.split(...).filter(l =>
 * l.startsWith('not ok')).join('\n')`, so the only thing a CI reader ever saw was
 * three `not ok - parsing: ...` lines. Everything that explained them — the
 * runner's exit code, the failing gate's stderr, the `# context:` dump the suite
 * now emits — was thrown away by the wrapper before vitest ever printed it, and
 * the sandbox holding those files is deleted by the suite's EXIT trap.
 *
 * So the message carries the suite output whole. Vitest prints the second
 * argument of `expect()` verbatim when the assertion fails.
 */
function suiteFailureMessage(output: string): string {
  return [
    'The cmate-verify fixture suite did not report clean.',
    'Its full output follows unabridged — `# context:` blocks carry the verify-run',
    "exit code and stderr for each failing run (they are the only copy: the suite's",
    'sandbox is deleted on exit).',
    '--- suite output start ---',
    output,
    '--- suite output end ---',
  ].join('\n');
}

describe('cmate-verify fixture suite', () => {
  it(
    'runs green with every case reporting',
    () => {
      const result = spawnSync('bash', [SUITE], { encoding: 'utf8' });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const detail = suiteFailureMessage(output);

      const summary = output.match(/^# tests: (\d+) passed, (\d+) failed$/m);
      expect(summary, detail).not.toBeNull();

      const passed = Number(summary![1]);
      const failed = Number(summary![2]);

      expect(output.split('\n').filter((l) => l.startsWith('not ok')).join('\n'), detail).toBe('');
      expect(failed, detail).toBe(0);
      expect(passed, detail).toBeGreaterThanOrEqual(MIN_ASSERTIONS);
      expect(result.status, detail).toBe(0);
    },
    TIMEOUT_MS,
  );

  it('reports a failure with the whole suite output, not just the not ok lines', () => {
    // The shape the suite emits for a failing run: a `not ok` line naming out.N,
    // followed by the captured stdout+stderr as TAP comments.
    const sample = [
      '# cmate-verify fixture suite',
      'ok - all-pass: exit code is 0',
      'not ok - parsing: exit code is 0 (expected [0], got [20]) [context: /tmp/sb/out.12]',
      '# context: /tmp/sb/out.12 (verify-run stdout, plus its exit code and stderr when it failed)',
      '#   GATE unquoted FAIL exit=127 duration=0s',
      '#   --- verify-run exit=20 (stderr captured in /tmp/sb/err.12) ---',
      '#   --- gate unquoted (FAIL exit=127): no output captured ---',
      '# end context: /tmp/sb/out.12',
      '# tests: 157 passed, 1 failed',
    ].join('\n');

    const message = suiteFailureMessage(sample);

    // Everything the old `not ok`-only reduction would have discarded.
    expect(message).toContain('GATE unquoted FAIL exit=127 duration=0s');
    expect(message).toContain('--- verify-run exit=20 (stderr captured in /tmp/sb/err.12) ---');
    expect(message).toContain('no output captured');
    expect(message).toContain('# tests: 157 passed, 1 failed');
    expect(message).toContain('ok - all-pass: exit code is 0');
    // ...and the `not ok` line itself is still there, so nothing was traded away.
    expect(message).toContain('not ok - parsing: exit code is 0');
  });
});
