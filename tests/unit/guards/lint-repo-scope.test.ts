/**
 * `npm run lint` is `eslint .` — the repository is lint-visible by default (Issue #2736).
 *
 * ## Why the directory enumeration had to go
 *
 * The same hole opened three times, because the lint target was a hand-maintained
 * list of directories: `eslint src` missed all 1,849 files under `tests/` until
 * #2719, `eslint src tests` missed `scripts/` (45) and `bin/` (1) until #2732, and
 * `eslint src tests scripts bin` still missed the repository root, `public/` and
 * `website/`. The defect was never the individual omission — it was the scheme,
 * which relies on someone remembering to widen a list. Inverting it to `eslint .`
 * plus an explicit exclusion list makes a new file lint-visible by default, and
 * makes every exclusion a reviewable line in `.eslintrc.json`.
 *
 * ## What this file pins, and why ESLint cannot pin it itself
 *
 * Two ways the inversion can rot silently:
 *
 * 1. **`ignorePatterns` becoming a hiding place.** ESLint 8 does not read
 *    `.gitignore`, so the list is written by hand and nothing stops a directory of
 *    real source from being added to it "to get CI green". Every entry is therefore
 *    re-measured here against git: it must be `.gitignore`'d *and* hold zero tracked
 *    files. Build output only.
 * 2. **ESLint 8 ignores dot-directories by default.** That default is invisible in
 *    the config, so a future `.foo/tool.ts` would go unchecked with nothing to read
 *    about it. Checking `ignorePatterns` alone cannot see this, so the last test
 *    pins the *result*: the set of tracked, lintable files that `isPathIgnored()`
 *    rejects must equal the known list exactly.
 *
 * File counts are deliberately absent — this Issue and #2732 both add guards, so
 * any absolute number is stale on arrival. Coverage is asserted as a set, not a size.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { ESLint } from 'eslint';

const REPO_ROOT = process.cwd();
const ESLINTRC = join(REPO_ROOT, '.eslintrc.json');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');

/** The extension set `npm run lint` passes to `--ext`, in order. */
const LINT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

/**
 * The directory names the old enumeration listed. Their reappearance as lint
 * targets is the regression this Issue exists to prevent, so they are named here
 * rather than inferred.
 */
const ENUMERATED_DIRS = ['src', 'tests', 'scripts', 'bin'];

/**
 * Tracked files that ESLint does not lint, pinned exactly.
 *
 * All ten are the `demo-video` skill's TypeScript, and they are unchecked because
 * of ESLint 8's dot-directory default rather than anything in `ignorePatterns`.
 * `.agents/` is a mirror of `.claude/`, so both copies have to be fixed together —
 * that is a separate Epic. Adding a path here is claiming a file may go unlinted;
 * removing one is the fix.
 */
const KNOWN_UNLINTED = [
  '.agents/skills/demo-video/scripts/record-scenes.ts',
  '.agents/skills/demo-video/scripts/render-overlays.ts',
  '.agents/skills/demo-video/scripts/stills.ts',
  '.agents/skills/demo-video/scripts/storyboard.ts',
  '.agents/skills/demo-video/scripts/terminal-scene.ts',
  '.claude/skills/demo-video/scripts/record-scenes.ts',
  '.claude/skills/demo-video/scripts/render-overlays.ts',
  '.claude/skills/demo-video/scripts/stills.ts',
  '.claude/skills/demo-video/scripts/storyboard.ts',
  '.claude/skills/demo-video/scripts/terminal-scene.ts',
];

// --------------------------------------------------------------------------
// Config access
// --------------------------------------------------------------------------

interface EslintRcShape {
  ignorePatterns: string[];
}

/**
 * ESLint parses `.eslintrc.json` through `strip-json-comments`, so the file may
 * carry `//` section labels that `JSON.parse` alone would throw on. Only
 * whole-line comments are written there, which is all this strips.
 */
function readEslintRc(): EslintRcShape {
  const raw = readFileSync(ESLINTRC, 'utf-8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as EslintRcShape;
}

const rc = readEslintRc();
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as {
  scripts: Record<string, string>;
};

/** `git ls-files <pathspec>`, as a line count. */
function trackedFileCount(pathspec: string): number {
  const out = execFileSync('git', ['ls-files', '--', pathspec], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return out.split('\n').filter(Boolean).length;
}

// --------------------------------------------------------------------------

describe('lint scope is the whole repository (Issue #2736)', () => {
  it('`npm run lint` is `eslint .`, not a list of directories', () => {
    const lint = pkg.scripts.lint;

    expect(
      lint.trim().startsWith('eslint .'),
      '`lint` must start with `eslint .` — a directory list re-opens the hole ' +
        'that #2719, #2732 and #2736 each had to close',
    ).toBe(true);

    const targets = lint.split('--ext')[0].trim().split(/\s+/);
    for (const dir of ENUMERATED_DIRS) {
      expect(
        targets,
        `\`${dir}\` must not be an explicit lint target — \`eslint .\` already covers it, ` +
          'and enumerating one directory is how the list starts growing back',
      ).not.toContain(dir);
    }
  });

  it('passes every lintable extension to --ext', () => {
    const ext = pkg.scripts.lint.split('--ext')[1];
    expect(ext, '`lint` must still pass --ext').toBeDefined();
    expect(ext.trim().split(',')).toEqual(LINT_EXTENSIONS);
  });

  /**
   * The load-bearing assertion. `ignorePatterns` is the only way to remove a file
   * from `npm run lint` without anything else noticing, so an entry has to earn its
   * place twice over: git must already ignore it, and it must hold nothing tracked.
   */
  it('excludes only build output — every ignorePatterns entry is gitignored and untracked', () => {
    expect(rc.ignorePatterns, '.eslintrc.json must declare ignorePatterns').toBeInstanceOf(Array);
    expect(rc.ignorePatterns.length).toBeGreaterThan(0);

    for (const pattern of rc.ignorePatterns) {
      const checkIgnore = spawnSync('git', ['check-ignore', '-q', '--', pattern], {
        cwd: REPO_ROOT,
      });
      expect(
        checkIgnore.status,
        `\`${pattern}\` は .gitignore されていない。lint の除外にしてよいのは` +
          'ビルド成果物だけである',
      ).toBe(0);

      expect(
        trackedFileCount(pattern),
        `\`${pattern}\` は git 管理下のファイルを含む。lint の除外にしてよいのは` +
          'ビルド成果物だけである',
      ).toBe(0);
    }
  });

  it('does not restate ESLint’s own node_modules default', () => {
    for (const pattern of rc.ignorePatterns) {
      expect(
        pattern.includes('node_modules'),
        `\`${pattern}\` duplicates ESLint's built-in node_modules ignore`,
      ).toBe(false);
    }
  });

  /**
   * Positive control for the two tests above: they only prove the list is honest,
   * not that ESLint reads it at all. `isPathIgnored` does not require the file to
   * exist, so this holds in a clean checkout where `dist/` has never been built.
   */
  it('actually applies ignorePatterns', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    expect(await eslint.isPathIgnored('dist/x.js')).toBe(true);
  });

  /**
   * Exhaustiveness, measured rather than described. Reading `ignorePatterns` would
   * miss the dot-directory default entirely, so this asks ESLint itself which
   * tracked files it would skip and compares the answer to the known list.
   */
  it('lints every tracked file except the known ten', async () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', '--', ...LINT_EXTENSIONS.map((e) => `*${e}`)],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    )
      .split('\n')
      .filter(Boolean);

    expect(tracked.length, 'git ls-files returned nothing — is cwd the repo root?').toBeGreaterThan(
      0,
    );

    const eslint = new ESLint({ cwd: REPO_ROOT });
    const unlinted: string[] = [];
    for (const file of tracked) {
      if (await eslint.isPathIgnored(file)) unlinted.push(file);
    }
    unlinted.sort();

    const known = new Set(KNOWN_UNLINTED);
    for (const path of unlinted) {
      expect(
        known.has(path),
        `\`${path}\` が lint されていない。\`ignorePatterns\` にも無いなら、` +
          'ドットディレクトリ既定無視に落ちている',
      ).toBe(true);
    }

    // Exact match, both directions: a path that starts being linted has to leave
    // KNOWN_UNLINTED, or the list stops describing anything.
    expect(unlinted).toEqual([...KNOWN_UNLINTED].sort());
  }, 120_000);
});
