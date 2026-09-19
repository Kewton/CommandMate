/**
 * `npm run lint` covers `scripts/` and `bin/` as well as `src/` and `tests/` (Issue #2732).
 *
 * ## Why the `scripts/**` override has to exist
 *
 * `scripts/` held 45 files that ESLint had never once read: CI helpers
 * (`changelog-fragments.mjs`, `run-related-unit-tests.mjs`), the DB migrations and
 * the launcher chain were all outside `npm run lint`, so the CI Lint job and the
 * `lint` verification gate could not fail on them — the scripts implementing the
 * gates were themselves ungated. Pointing the existing rule set at them measured
 * 40 findings, but **32 of the 40 were src-only *policies* misfiring**: 28 i18n
 * literal hits (#1271) on English strings in canary scenario tables that are never
 * rendered, and 4 tmux-gateway hits (#1922) in two measurement harnesses. Only 8
 * were real debt, and one of those (`bin/commandmate.js`'s `require()`) is correct
 * CommonJS rather than debt. So the scope could only widen at exit 0 with an
 * override, and this file pins what that override is allowed to say.
 *
 * ## What this pins, and why ESLint cannot pin it itself
 *
 * Two holes a plain "it lints now" check would not see:
 *
 * 1. **`no-restricted-syntax` carries three selectors, and only the first is the
 *    false positive.** The other two are the tmux dynamic-`import()` / `require()`
 *    ban that stands in for what ESLint 8's `no-restricted-imports` cannot see
 *    (#1922 §4 D4 / DR4-005). Writing `"off"` for `scripts/**` would have taken
 *    them down across the whole directory and every command in CI would stay
 *    green. The override re-declares the rule instead, and the deep-equal below
 *    fails the moment the root grows a selector the copy does not have.
 * 2. **A `warn` is a finding routed around the exit code.** The three staged
 *    entries are Issue #2733's work list; each is promoted back to `error` by
 *    deleting its line. The last test re-measures every rule that has left, so a
 *    line can only be deleted once `scripts/` is genuinely clean of it.
 *
 * The counts above are prose, not assertions: the debt figure moves with #2733.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { ESLint, type Linter } from 'eslint';

const REPO_ROOT = process.cwd();
const ESLINTRC = join(REPO_ROOT, '.eslintrc.json');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const require_ = createRequire(import.meta.url);

/** The glob that selects the scope override. Written exactly once, here. */
const SCRIPTS_GLOB = 'scripts/**';

/**
 * The CommonJS override. Two elements, not one: `bin/` is a shebang entry point
 * and `.cjs` is an extension that *declares* CommonJS, and both are exempt for the
 * same reason, so they share an entry.
 */
const COMMONJS_FILES = ['bin/**', '**/*.cjs'];

/**
 * 段階解消 — real debt parked at `warn` so the scope change could land at exit 0.
 * Issue #2733 deletes each entry once `scripts/` has zero findings for it.
 *
 * **Do not shorten this list.** It stops describing the override the moment a rule
 * is promoted; from then on it is the set the promotion-contract test re-lints, and
 * deleting an entry here stops that measurement instead of proving it.
 */
const STAGED_WARN = [
  '@typescript-eslint/no-unused-vars',
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/no-this-alias',
];

/** The extension set `npm run lint` uses, so the re-measure covers the same files. */
const LINT_GLOBS = ['scripts/**/*.{js,jsx,ts,tsx,mjs,cjs}'];

// --------------------------------------------------------------------------
// Config access
// --------------------------------------------------------------------------

interface EslintOverride {
  files: string[];
  rules?: Record<string, unknown>;
}

interface EslintRcShape {
  rules: Record<string, unknown>;
  overrides: EslintOverride[];
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

/** Every override whose `files` is exactly `["scripts/**"]`. */
const scriptsOverrides = rc.overrides.filter(
  (o) => o.files.length === 1 && o.files[0] === SCRIPTS_GLOB,
);

/**
 * The CommonJS entry is found by `files.includes("bin/**")`, never by comparing
 * `files` to `["bin/**"]` — it is a two-element array, so an equality search finds
 * nothing and the assertions below would pass vacuously.
 */
const commonjsOverrides = rc.overrides.filter((o) => o.files.includes('bin/**'));

function scriptsRules(): Record<string, unknown> {
  expect(scriptsOverrides, `exactly one overrides entry for ${SCRIPTS_GLOB}`).toHaveLength(1);
  return scriptsOverrides[0].rules ?? {};
}

function entriesWithSeverity(severity: string): string[] {
  return Object.entries(scriptsRules())
    .filter(([, value]) => value === severity)
    .map(([rule]) => rule)
    .sort();
}

/** The root `no-restricted-syntax` entries minus the one i18n selector (#1271). */
function rootSyntaxWithoutI18n(): unknown[] {
  const entry = rc.rules['no-restricted-syntax'] as [string, ...{ message: string }[]];
  const selectors = entry.slice(1) as { message: string }[];
  const i18n = selectors.filter((s) => s.message.startsWith('i18n:'));
  expect(i18n, 'exactly one i18n selector is expected in the root rule').toHaveLength(1);
  return selectors.filter((s) => !s.message.startsWith('i18n:'));
}

// --------------------------------------------------------------------------

describe('lint scope covers scripts/ and bin/ (Issue #2732)', () => {
  it('`npm run lint` runs ESLint over scripts and bin, including .mjs and .cjs', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const lint = pkg.scripts.lint;
    const [targets, ext] = lint.split('--ext');

    for (const dir of ['src', 'tests', 'scripts', 'bin']) {
      expect(targets.trim().split(/\s+/), `${dir} must be a lint target`).toContain(dir);
    }
    // `.mjs` is what 12 of the scripts are written in and `.cjs` is what the two
    // spawned remote fixtures are: without both, widening the directory list lints
    // a third of `scripts/` and nothing else.
    const extensions = (ext ?? '').trim().split(',');
    expect(extensions).toEqual(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
  });

  it('has exactly one `scripts/**` override entry', () => {
    expect(scriptsOverrides).toHaveLength(1);
  });

  it('has exactly one CommonJS override, covering bin/ and every .cjs', () => {
    expect(commonjsOverrides).toHaveLength(1);
    expect(commonjsOverrides[0].files).toEqual(COMMONJS_FILES);
  });

  it('exempts only `no-require-imports` for CommonJS, and nothing else', () => {
    // A second rule slipped in here would be switched off for `**/*.cjs`
    // repository-wide, including anything added to `tests/fixtures/` later.
    expect(commonjsOverrides[0].rules).toEqual({ '@typescript-eslint/no-require-imports': 'off' });
  });

  it('re-declares no-restricted-syntax for scripts/ instead of switching it off', () => {
    const declared = scriptsRules()['no-restricted-syntax'];

    // `"off"` is the failure this test exists for: it reads as "drop the i18n
    // noise" and silently drops the tmux dynamic-access ban with it.
    expect(
      declared,
      'no-restricted-syntax must be re-declared for scripts/, not switched off — ' +
        '"off" would also drop the tmux dynamic-import selectors (#1922 §4 D4)',
    ).not.toBe('off');
    expect(Array.isArray(declared)).toBe(true);

    const entry = declared as unknown[];
    expect(entry[0], 'the copied selectors keep error severity').toBe('error');
    // Deep-equal, so a selector added to the root rule and not copied here fails.
    expect(entry.slice(1)).toEqual(rootSyntaxWithoutI18n());
  });

  it('sets every other rule in the override to `warn`, from the staged list', () => {
    const nonOff = Object.entries(scriptsRules()).filter(
      ([rule, value]) => rule !== 'no-restricted-syntax' && value !== 'off',
    );

    // An `error` here would break the exit-0 promise this Issue was built on.
    for (const [rule, value] of nonOff) {
      expect(value, `${rule} must be "warn" while it is staged debt`).toBe('warn');
    }

    // Subset, not equality — Issue #2733 removes these one at a time.
    const staged = new Set(STAGED_WARN);
    for (const [rule] of nonOff) {
      expect(staged.has(rule), `${rule} is not one of the staged-debt rules`).toBe(true);
    }
  });

  it('switches nothing else off for scripts/', () => {
    // The whole point of the override is that it drops one i18n selector and
    // nothing more. An `"off"` here would be a src rule quietly stopped for 45
    // files that no other check reads.
    expect(entriesWithSeverity('off')).toEqual([]);
  });

  /**
   * The promotion contract. Deleting a `warn` entry hands that rule back to the
   * inherited `error`, which is only safe once `scripts/` is clean of it — so this
   * re-measures, rather than trusts, every rule that has left the list.
   *
   * One ESLint instance carrying every promoted rule and one `lintFiles` call: the
   * walk dominates the cost and repeating it per rule is pure waste.
   *
   * Each rule is raised to `error` **keeping the options the root config gives it**,
   * so this measures what `npm run lint` measures. `no-unused-vars` is the one that
   * matters: its `^_` ignore patterns live in the root `rules`, and re-linting with
   * stock options would report variables the real run allows.
   */
  it('only allows a staged rule to be dropped once scripts/ is clean of it', async () => {
    const stillStaged = new Set(entriesWithSeverity('warn'));
    const promoted = STAGED_WARN.filter((rule) => !stillStaged.has(rule));

    // Nothing promoted: no walk, the way it is while all three are staged.
    if (promoted.length === 0) return;

    const rules = Object.fromEntries(
      promoted.map((rule) => {
        const configured = rc.rules[rule];
        return [rule, Array.isArray(configured) ? ['error', ...configured.slice(1)] : 'error'];
      }),
    );

    const eslint = new ESLint({
      useEslintrc: false,
      cwd: REPO_ROOT,
      baseConfig: {
        root: true,
        parser: require_.resolve('@typescript-eslint/parser'),
        parserOptions: {
          ecmaVersion: 2022,
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
        plugins: ['@typescript-eslint'],
        rules,
      } as unknown as Linter.Config,
    });

    const results = await eslint.lintFiles(LINT_GLOBS);

    // Per rule, so the failure names which rule regressed and where — a flat file
    // list would leave that to be worked out by hand.
    const offenders: Record<string, string[]> = {};
    for (const result of results) {
      const file = result.filePath.slice(REPO_ROOT.length + 1);
      for (const message of result.messages) {
        if (!message.ruleId || !promoted.includes(message.ruleId)) continue;
        const files = (offenders[message.ruleId] ??= []);
        if (!files.includes(file)) files.push(file);
      }
    }

    expect(
      offenders,
      'these rules were removed from the scripts/** override, so they are errors ' +
        'again — fix the files listed or put their "warn" entries back',
    ).toEqual({});
  }, 180_000);
});
