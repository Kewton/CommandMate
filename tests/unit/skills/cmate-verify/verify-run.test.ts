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

describe('cmate-verify fixture suite', () => {
  it(
    'runs green with every case reporting',
    () => {
      const result = spawnSync('bash', [SUITE], { encoding: 'utf8' });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      const summary = output.match(/^# tests: (\d+) passed, (\d+) failed$/m);
      expect(summary, `no summary line in suite output:\n${output}`).not.toBeNull();

      const passed = Number(summary![1]);
      const failed = Number(summary![2]);

      expect(output.split('\n').filter((l) => l.startsWith('not ok')).join('\n')).toBe('');
      expect(failed).toBe(0);
      // Floor mirrors MIN_ASSERTIONS in run-tests.sh: a truncated run must not
      // pass just because it never reached the failing case.
      expect(passed).toBeGreaterThanOrEqual(100);
      expect(result.status).toBe(0);
    },
    TIMEOUT_MS,
  );
});
