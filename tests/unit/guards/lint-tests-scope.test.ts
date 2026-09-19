/**
 * `npm run lint` covers `tests/` as well as `src/` (Issue #2719).
 *
 * ## Why the `tests/**` override has to exist
 *
 * Widening the lint scope drags the whole `src` rule set onto 1,800+ test files,
 * and two of those rules are src-only *policies* rather than code-quality checks:
 * the i18n literal detector (#1271) and the tmux-gateway ban (#1922) both describe
 * how the product must be written, and a test that hard-codes a label or drives
 * tmux directly is doing its job — 328 of the 522 findings measured on develop were
 * that kind of false positive. The override turns those three off permanently. It
 * also downgraded six genuine-debt rules to `warn` so the scope change could land
 * at exit 0 (194 real findings) instead of holding every PR hostage to a cleanup
 * Issue; Issue #2721 cleared the last 76 of those findings and deleted all six
 * entries, so the override is now three `off` rules and nothing else.
 *
 * ## What this file pins, and why ESLint cannot pin it itself
 *
 * ESLint has no way to assert "exactly these three are off and the rest are warn":
 * an extra `"off"` slipped into the override would silently stop checking something
 * in `tests/` and every command in CI would still be green. So the classification
 * is pinned here, structurally, the same way
 * `tests/unit/guards/tmux-import-allowlist.test.ts` pins the tmux allowlist.
 *
 * The staged `warn` list is a **subset** check, not an exact match: the follow-up
 * Issues promote these back to `error` one at a time, and each promotion is a
 * deletion from the override. What keeps that honest is the last test in this file
 * — a rule may only leave the list once `tests/` actually has zero findings for it.
 * All six have now left, so that test re-measures all six on every run and
 * `STAGED_WARN` must keep its six entries for it to have anything to measure.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { ESLint, type Linter } from 'eslint';
import { parse } from 'yaml';

const REPO_ROOT = process.cwd();
const ESLINTRC = join(REPO_ROOT, '.eslintrc.json');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const CI_WORKFLOW = join(REPO_ROOT, '.github/workflows/ci-pr.yml');
const require_ = createRequire(import.meta.url);

/** The glob that selects the override. Written exactly once, here. */
const TESTS_GLOB = 'tests/**';

/**
 * 恒久除外 — src-only policies. Applying them to test code is a category error,
 * so these never come back and are not part of any cleanup metric.
 */
const PERMANENT_OFF = [
  'no-restricted-syntax',
  'no-restricted-imports',
  '@next/next/no-assign-module-variable',
];

/**
 * 段階解消 — real debt that was temporarily `warn`. A follow-up Issue deleted each
 * entry (restoring the inherited `error`) once the corresponding findings were
 * gone; Issue #2721 deleted the last of them.
 *
 * **Do not shorten this list.** It is no longer a description of the override —
 * it is the set the promotion-contract test below re-lints. An entry removed here
 * stops being measured, which is the opposite of what promoting it was for.
 */
const STAGED_WARN = [
  '@typescript-eslint/no-unused-vars',
  '@typescript-eslint/no-explicit-any',
  'react-hooks/rules-of-hooks',
  '@typescript-eslint/no-require-imports',
  '@typescript-eslint/no-this-alias',
  'prefer-const',
];

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

/** Every override whose `files` is exactly `["tests/**"]`. */
const testsOverrides = rc.overrides.filter(
  (o) => o.files.length === 1 && o.files[0] === TESTS_GLOB,
);

function testsRules(): Record<string, unknown> {
  expect(testsOverrides, `exactly one overrides entry for ${TESTS_GLOB}`).toHaveLength(1);
  return testsOverrides[0].rules ?? {};
}

function entriesWithSeverity(severity: string): string[] {
  return Object.entries(testsRules())
    .filter(([, value]) => value === severity)
    .map(([rule]) => rule)
    .sort();
}

// --------------------------------------------------------------------------

describe('lint scope covers tests/ (Issue #2719)', () => {
  it('`npm run lint` runs ESLint over src and tests', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.lint).toContain('eslint src tests');
  });

  it('has exactly one `tests/**` override entry', () => {
    expect(testsOverrides).toHaveLength(1);
  });

  it('turns off exactly the three src-only policies', () => {
    expect(entriesWithSeverity('off')).toEqual([...PERMANENT_OFF].sort());
  });

  /**
   * Since Issue #2721 the staging is finished, so this also pins the count at
   * zero: `warn` is no longer an available answer for a rule that fires in
   * `tests/`.
   */
  it('sets every other rule in the override to `warn`, from the staged list', () => {
    const rules = testsRules();
    const nonOff = Object.entries(rules).filter(([, value]) => value !== 'off');

    // Severity first: an `error` here would break the exit-0 promise of #2719,
    // and anything other than a bare string would escape the classification.
    for (const [rule, value] of nonOff) {
      expect(value, `${rule} must be "warn" while it is staged debt`).toBe('warn');
    }

    // Subset, not equality — the list only ever shrinks.
    const staged = new Set(STAGED_WARN);
    for (const [rule] of nonOff) {
      expect(staged.has(rule), `${rule} is not one of the staged-debt rules`).toBe(true);
    }

    // Issue #2721: the staged debt is paid off. A new `warn` here would be a
    // finding routed around `npm run lint`'s exit code rather than fixed, and
    // nothing else in CI would notice.
    expect(
      entriesWithSeverity('warn'),
      'the tests/** override may not downgrade anything to "warn" any more — ' +
        'fix the finding, or disable the line with a reason',
    ).toEqual([]);
  });

  it('does not let the CI Lint job swallow its own result', () => {
    const workflow = parse(readFileSync(CI_WORKFLOW, 'utf-8')) as {
      jobs: Record<string, { steps?: { name?: string; 'continue-on-error'?: unknown }[] } & Record<string, unknown>>;
    };
    const lintJob = workflow.jobs.lint;
    expect(lintJob, 'ci-pr.yml must still have a `lint` job').toBeTruthy();
    expect(Object.keys(lintJob)).not.toContain('continue-on-error');
    for (const step of lintJob.steps ?? []) {
      expect(
        Object.keys(step),
        `step "${step.name ?? '(unnamed)'}" must not opt out of its own result`,
      ).not.toContain('continue-on-error');
    }
  });

  /**
   * The promotion contract. Deleting a `warn` entry hands that rule back to the
   * inherited `error`, which is only safe once `tests/` is clean of it — so this
   * re-measures, rather than trusting, every rule that has left the list. Since
   * Issue #2721 that is all six, permanently.
   *
   * One ESLint instance carrying every promoted rule, not one per rule: the walk
   * over `tests/` dominates the cost and repeating it is pure waste. Measured on
   * develop with all six promoted — 6 instances 44.0s, 1 instance 8.3s.
   *
   * Each rule is raised to `error` **keeping the options the root config gives
   * it**, so this measures what `npm run lint` measures. `no-unused-vars` is the
   * one that matters: its `^_` ignore patterns live in the root `rules`, and
   * re-linting with stock options would report variables the real run allows.
   */
  it('only allows a staged rule to be dropped once tests/ is clean of it', async () => {
    const stillStaged = new Set(entriesWithSeverity('warn'));
    const promoted = STAGED_WARN.filter((rule) => !stillStaged.has(rule));

    // Nothing promoted: no walk, the way it was while all six were staged.
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
        plugins: ['@typescript-eslint', 'react-hooks'],
        rules,
      } as unknown as Linter.Config,
    });

    const results = await eslint.lintFiles(['tests/**/*.ts', 'tests/**/*.tsx']);

    // Per rule, so the failure names which rule regressed and where — a flat
    // file list would leave that to be worked out by hand.
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
      'these rules were removed from the tests/** override, so they are errors ' +
        'again — fix the files listed or put their "warn" entries back',
    ).toEqual({});
  }, 180_000);
});
