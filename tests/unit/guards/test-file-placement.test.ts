/**
 * Every test file in the repository sits under a directory some gate runs
 * (Issue #1939).
 *
 * ## What happened
 *
 * Thirteen vitest files — 267 tests — lived in `src/**\/__tests__/`. Nothing ran
 * them: `test:unit` is `vitest run tests/unit`, `test:integration` is
 * `vitest run tests/integration`, and playwright's `testDir` is `tests/e2e`.
 * `src` is not in any of those. By the time this was noticed, 19 of the 267 were
 * red, and each had been red since some unrelated change months earlier — the
 * next-intl migration (#1276), the clipboard fallback (#438), the memo→
 * description column rename (v13), the gemini REPL rewrite (#368). None of those
 * changes was wrong; they were simply invisible to a suite that never executed.
 *
 * This is the #1946 shape: a region the verdict does not look at never gets
 * fixed, because nothing ever reports it broken.
 *
 * ## Why a placement rule rather than widening `test:unit`
 *
 * The alternative was `vitest run tests/unit src`. That keeps two homes for unit
 * tests, so "where does a new test go" has two answers and both are right —
 * which is the same duplicate-implementation defect #1882 removed from the
 * static guards, applied to directory layout. CLAUDE.md's file-layout section
 * already names `tests/unit/` and `tests/integration/` as the answer. So the
 * rule enforced here is placement, and the gate command stays a single literal.
 *
 * ## Why a unit test rather than a fifth `scripts/check-*.mjs`
 *
 * The static guards are separate scripts because each is a CI job that must be
 * able to fail in seconds, ahead of the 12-minute unit suite. This rule has no
 * such requirement: a misplaced test file is caught by the suite that would have
 * skipped it, in the one job whose job it is to run tests. Adding a script would
 * mean a new CI job plus a new verify gate for a `git ls-files` filter.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();

/**
 * Directories a gate actually executes, each with the command that executes it.
 * A test file outside all of them is dead weight that still looks like coverage.
 */
const RUN_ROOTS: readonly { dir: string; runBy: string }[] = [
  { dir: 'tests/unit/', runBy: 'npm run test:unit (vitest run tests/unit)' },
  { dir: 'tests/integration/', runBy: 'npm run test:integration (vitest run tests/integration)' },
  { dir: 'tests/e2e/', runBy: 'npm run test:e2e (playwright.config.ts testDir)' },
];

const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Tracked files only. An untracked scratch file is not part of the repository's
 * coverage story, and `git ls-files` is also what keeps `node_modules`, `.next`
 * and `dist` out without a hand-maintained ignore list.
 */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .split('\0')
    .filter(Boolean);
}

describe('test file placement', () => {
  const testFiles = trackedFiles().filter((f) => TEST_FILE.test(f));

  it('finds test files at all (guards against a broken glob)', () => {
    expect(testFiles.length).toBeGreaterThan(500);
  });

  it('places every test file under a directory some gate runs', () => {
    const stranded = testFiles.filter((f) => !RUN_ROOTS.some((r) => f.startsWith(r.dir)));

    expect(
      stranded,
      `These test files are never executed by any gate. Move them under one of ` +
        `${RUN_ROOTS.map((r) => r.dir).join(', ')} — see this file's header for why ` +
        `widening the gate command instead is the wrong fix.\n` +
        stranded.map((f) => `  ${f}`).join('\n')
    ).toEqual([]);
  });

  it('keeps `src/` free of colocated test directories', () => {
    const colocated = trackedFiles().filter((f) => f.startsWith('src/') && f.includes('/__tests__/'));

    expect(colocated, `Colocated tests under src/ are not on any gate:\n${colocated.join('\n')}`).toEqual(
      []
    );
  });
});

describe('the gate commands that make the placement rule true', () => {
  interface PackageJson {
    scripts: Record<string, string>;
  }

  /**
   * The placement rule above is only meaningful while these commands still point
   * at exactly these directories. Widening `test:unit` to `tests/unit src` would
   * leave the rule technically satisfiable and practically dead, so pin the
   * literals here rather than deriving them — a derived expectation would move
   * with the change it is supposed to catch.
   */
  const EXPECTED: readonly [string, string][] = [
    ['test:unit', 'NODE_ENV=test vitest run tests/unit'],
    ['test:integration', 'NODE_ENV=test vitest run tests/integration'],
  ];

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as PackageJson;

  it.each(EXPECTED)('%s runs exactly its own directory', (script, command) => {
    expect(pkg.scripts[script]).toBe(command);
  });
});
