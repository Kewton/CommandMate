import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  percentile,
  readRealShellMarkers,
  repoRelativeTestPath,
} from '../../../scripts/measure-real-shell-budget.mjs';

const REPO = process.cwd();
const BUDGET_SOURCE = path.join(REPO, 'tests/helpers/real-shell-budget.ts');

/**
 * Issue #1985.
 *
 * `tests/helpers/real-shell-budget.ts` carries a guard sized from a percentile,
 * and this script is the only way to check that the percentile is real. A bug
 * in it does not surface as a failing test — it surfaces as a guard sized from
 * a distribution that was never the family's, which is the class of defect
 * #1985 is about, one level down.
 */
describe('measure-real-shell-budget (Issue #1985)', () => {
  describe('readRealShellMarkers', () => {
    it('reads the live declaration instead of holding a second copy of it', () => {
      // The point of reading rather than restating: narrow REAL_SHELL_MARKERS
      // in the helper and the measurement narrows with it, so the set that gets
      // the budget and the set that gets measured cannot disagree.
      const markers = readRealShellMarkers(readFileSync(BUDGET_SOURCE, 'utf8'));
      expect(markers.test('const result = spawnSync("bash", []);')).toBe(true);
      expect(markers.test('execFileSync("grep", []);')).toBe(true);
      expect(markers.test('export const answer = 42;\n')).toBe(false);
    });

    it('stops rather than guessing when the declaration is gone', () => {
      // A fallback pattern here would keep printing a plausible table for the
      // wrong population, which is worse than no table at all.
      expect(() => readRealShellMarkers('export const other = /x/;\n')).toThrow(
        /REAL_SHELL_MARKERS/,
      );
    });
  });

  describe('percentile', () => {
    it('is nearest-rank, so every value it reports is one that was observed', () => {
      const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(percentile(sorted, 50)).toBe(5);
      expect(percentile(sorted, 90)).toBe(9);
      expect(percentile(sorted, 100)).toBe(10);
      // Interpolation would answer 9.91 here; the guard is sized from durations
      // that actually happened, so the answer has to be one of them.
      expect(percentile(sorted, 99.9)).toBe(10);
    });

    it('clamps instead of reading off the end of the array', () => {
      expect(percentile([7], 99.9)).toBe(7);
      expect(percentile([1, 2], 0)).toBe(1);
      expect(percentile([], 99.9)).toBeNull();
    });
  });

  describe('repoRelativeTestPath', () => {
    it('maps a report from another checkout onto this one', () => {
      // Load generators are separate checkouts, so their reports name absolute
      // paths that do not exist here. Classification still has to find the
      // source, or every foreign sample silently lands in "non-family".
      expect(repoRelativeTestPath('/somewhere/else/tests/unit/a.test.ts')).toBe(
        'tests/unit/a.test.ts',
      );
      expect(repoRelativeTestPath('tests/unit/a.test.ts')).toBe('tests/unit/a.test.ts');
      expect(repoRelativeTestPath('/no/test/dir/here.ts')).toBeNull();
    });
  });
});
