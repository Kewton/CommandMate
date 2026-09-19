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
 * that kind of false positive. The override turns those three off permanently, and
 * downgrades six genuine-debt rules to `warn` so the scope change lands at exit 0
 * (194 real findings) instead of holding every PR hostage to a cleanup Issue.
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
 * 段階解消 — real debt, temporarily `warn`. A follow-up Issue deletes each entry
 * (restoring the inherited `error`) once the corresponding findings are gone.
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
   * re-measures, rather than trusting, every rule that has left the list. While
   * all six are still staged the loop body never runs and nothing is linted.
   */
  it('only allows a staged rule to be dropped once tests/ is clean of it', async () => {
    const stillStaged = new Set(entriesWithSeverity('warn'));
    const promoted = STAGED_WARN.filter((rule) => !stillStaged.has(rule));

    for (const rule of promoted) {
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
          rules: { [rule]: 'error' },
        } as unknown as Linter.Config,
      });

      const results = await eslint.lintFiles(['tests/**/*.ts', 'tests/**/*.tsx']);
      const offenders = results
        .filter((r) => r.messages.some((m) => m.ruleId === rule))
        .map((r) => r.filePath.slice(REPO_ROOT.length + 1));

      expect(
        offenders,
        `${rule} was removed from the tests/** override, so it is an error again — ` +
          `fix these files or put the "warn" entry back`,
      ).toEqual([]);
    }
  }, 180_000);
});
