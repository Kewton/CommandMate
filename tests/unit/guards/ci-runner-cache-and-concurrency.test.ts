/**
 * CI caching is conditioned on the runner, and PR runs supersede each other
 * while push runs never do (Issue #2329).
 *
 * ## What happened
 *
 * The move to self-hosted ARM64 runners (#1863) inverted an assumption baked
 * into `.github/workflows/ci-pr.yml`: that restoring a cache is faster than not
 * having one. Measured on 2026-09-05, `Setup Node.js` went from 0.08m to 0.77m
 * in each of the seven jobs that install dependencies, because the 287 MB npm
 * cache entry restores at ~8 MB/s on those runners (36s) while a cold
 * `npm ci --no-audit` inside the runner image takes 27s. The cache was costing
 * more than the install it accelerates. Separately, the workflow declared no
 * `concurrency`, so 32 of 285 PR runs over W35-W36 were still occupying runners
 * for a commit that had already been superseded.
 *
 * ## Why a test rather than a comment
 *
 * Both fixes live in a GitHub Actions expression, and an expression is the one
 * part of a workflow that looks obviously correct and is never executed until it
 * is executed for real. `cache: ${{ ... && 'npm' || '' }}` reverts to
 * `cache: 'npm'` in any careless edit and nothing local complains; the cost
 * reappears silently on the runners and nowhere else. The `concurrency` group is
 * worse, because the dangerous mistake is invisible: swap the `github.run_id`
 * fallback for anything branch-shaped — `github.ref`, `github.sha`, a literal —
 * and two pushes to develop land in the same group. Today `cancel-in-progress`
 * is false for pushes so nothing is cancelled, but the group would be one flag
 * away from deleting the post-merge run, which is the only place two
 * independently-green PRs are ever tested together.
 *
 * ## Why an evaluator rather than a string comparison
 *
 * Asserting that the file contains a particular string proves only that the file
 * contains that string; it restates the workflow instead of checking it. What
 * matters is what the expressions MEAN, so this file evaluates them — with a
 * small implementation of the subset of the Actions expression language they use
 * — against concrete event payloads, and asserts the resulting behaviour: two
 * pushes never share a group, two pushes of one PR always do, and the npm cache
 * input is empty on a self-hosted runner and `npm` on a hosted one. That is a
 * property an equivalent rewrite of the expression is free to satisfy, and a
 * broken one cannot.
 *
 * `evaluator behaviour` below is the positive control: without it, an evaluator
 * that returned its input unchanged would make every assertion here pass.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';

const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows');
const CI_WORKFLOW = 'ci-pr.yml';

// ---------------------------------------------------------------------------
// A minimal evaluator for the GitHub Actions expression subset used in this
// workflow: string / number / boolean / null literals, dotted context paths,
// `!`, `==`, `!=`, `&&`, `||` and parentheses.
//
// Two details of the real language matter here and are implemented faithfully:
//
//   1. `&&` and `||` return an OPERAND, not a boolean. That is the whole reason
//      `cond && 'npm' || ''` works as a ternary.
//   2. The empty string is falsy, alongside `false`, `0`, `-0`, `NaN` and
//      `null`. That is what makes `false || ''` evaluate to `''` rather than to
//      `false`, and what makes setup-node skip the cache.
//
// Comparison follows the documented rule: same types compare directly, mixed
// types are cast to number. Nothing in this workflow compares mixed types, but
// implementing the documented rule is cheaper than justifying an exception.
// ---------------------------------------------------------------------------

type ExpressionValue = string | number | boolean | null;
type Contexts = Record<string, unknown>;

type Token =
  | { kind: 'value'; value: ExpressionValue }
  | { kind: 'path'; value: string }
  | { kind: 'op'; value: string };

const OPERATORS = ['==', '!=', '&&', '||', '(', ')', '!'] as const;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    // Single-quoted string; '' is an escaped quote.
    if (char === "'") {
      let literal = '';
      i += 1;
      while (i < source.length) {
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            literal += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        literal += source[i];
        i += 1;
      }
      tokens.push({ kind: 'value', value: literal });
      continue;
    }

    const twoChar = source.slice(i, i + 2);
    if (twoChar === '==' || twoChar === '!=' || twoChar === '&&' || twoChar === '||') {
      tokens.push({ kind: 'op', value: twoChar });
      i += 2;
      continue;
    }

    if ((OPERATORS as readonly string[]).includes(char)) {
      tokens.push({ kind: 'op', value: char });
      i += 1;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_.\-*]*/.exec(source.slice(i));
    if (word) {
      const text = word[0];
      i += text.length;
      if (text === 'true') tokens.push({ kind: 'value', value: true });
      else if (text === 'false') tokens.push({ kind: 'value', value: false });
      else if (text === 'null') tokens.push({ kind: 'value', value: null });
      else tokens.push({ kind: 'path', value: text });
      continue;
    }

    const number = /^-?\d+(\.\d+)?/.exec(source.slice(i));
    if (number) {
      i += number[0].length;
      tokens.push({ kind: 'value', value: Number(number[0]) });
      continue;
    }

    throw new Error(`unsupported character ${JSON.stringify(char)} in expression: ${source}`);
  }

  return tokens;
}

/** GitHub's falsy set. Note the empty string. */
function isTruthy(value: ExpressionValue): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  return value;
}

function toNumber(value: ExpressionValue): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (value.trim() === '') return 0;
  return Number(value);
}

function looseEquals(left: ExpressionValue, right: ExpressionValue): boolean {
  if (typeof left === typeof right && left !== null && right !== null) return left === right;
  if (left === null && right === null) return true;
  const [a, b] = [toNumber(left), toNumber(right)];
  return !Number.isNaN(a) && !Number.isNaN(b) && a === b;
}

function lookup(path: string, contexts: Contexts): ExpressionValue {
  let current: unknown = contexts;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) return null;
  if (current === null || ['string', 'number', 'boolean'].includes(typeof current)) {
    return current as ExpressionValue;
  }
  throw new Error(`context path ${path} resolved to a non-scalar`);
}

function evaluateTokens(tokens: Token[], contexts: Contexts): ExpressionValue {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const eat = (value: string): boolean => {
    const token = peek();
    if (token && token.kind === 'op' && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };

  function primary(): ExpressionValue {
    if (eat('!')) return !isTruthy(primary());
    if (eat('(')) {
      const inner = or();
      if (!eat(')')) throw new Error('unbalanced parentheses');
      return inner;
    }
    const token = peek();
    if (!token) throw new Error('unexpected end of expression');
    position += 1;
    if (token.kind === 'value') return token.value;
    if (token.kind === 'path') return lookup(token.value, contexts);
    throw new Error(`unexpected operator ${token.value}`);
  }

  function equality(): ExpressionValue {
    let left = primary();
    for (;;) {
      if (eat('==')) left = looseEquals(left, primary());
      else if (eat('!=')) left = !looseEquals(left, primary());
      else return left;
    }
  }

  // `&&` yields the left operand when it is falsy, otherwise the right one.
  function and(): ExpressionValue {
    let left = equality();
    while (eat('&&')) {
      const right = equality();
      left = isTruthy(left) ? right : left;
    }
    return left;
  }

  // `||` yields the left operand when it is truthy, otherwise the right one.
  function or(): ExpressionValue {
    let left = and();
    while (eat('||')) {
      const right = and();
      left = isTruthy(left) ? left : right;
    }
    return left;
  }

  const result = or();
  if (position !== tokens.length) throw new Error('trailing tokens in expression');
  return result;
}

/** Evaluate one `${{ ... }}` body. */
function evaluateExpression(source: string, contexts: Contexts): ExpressionValue {
  return evaluateTokens(tokenize(source), contexts);
}

/** How GitHub renders a value when it is substituted into surrounding text. */
function toDisplayString(value: ExpressionValue): string {
  if (value === null) return '';
  return String(value);
}

/**
 * Evaluate a whole scalar, which may be plain text, one `${{ }}`, or a mix.
 * A scalar that is exactly one expression keeps the expression's own type — that
 * is what lets `cancel-in-progress` end up a real boolean.
 */
function evaluateScalar(source: string, contexts: Contexts): ExpressionValue {
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(source.trim());
  if (whole) return evaluateExpression(whole[1], contexts);
  return source.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, body: string) =>
    toDisplayString(evaluateExpression(body, contexts))
  );
}

// ---------------------------------------------------------------------------
// The workflow under test
// ---------------------------------------------------------------------------

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'runs-on'?: unknown;
  steps?: WorkflowStep[];
}

interface Workflow {
  concurrency?: { group?: string; 'cancel-in-progress'?: unknown };
  jobs?: Record<string, WorkflowJob>;
}

function readWorkflow(file: string): Workflow {
  return parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf-8')) as Workflow;
}

const ciWorkflow = readWorkflow(CI_WORKFLOW);

/**
 * Every `actions/setup-node` step of a job that can land on a self-hosted
 * runner. `runs-on` here is itself an expression (fork PRs fall back to
 * `ubuntu-latest`), so the test for "can be self-hosted" is whether the literal
 * appears in it at all — a job pinned to `ubuntu-latest`, such as
 * catalog-drift.yml's, is genuinely outside this rule and keeps its cache.
 */
function selfHostedSetupNodeSteps(): Array<{ jobId: string; step: WorkflowStep }> {
  return Object.entries(ciWorkflow.jobs ?? {}).flatMap(([jobId, job]) => {
    if (!JSON.stringify(job['runs-on'] ?? '').includes('self-hosted')) return [];
    return (job.steps ?? [])
      .filter((step) => (step.uses ?? '').startsWith('actions/setup-node'))
      .map((step) => ({ jobId, step }));
  });
}

const SELF_HOSTED = { runner: { environment: 'self-hosted', os: 'Linux', arch: 'ARM64' } };
const GITHUB_HOSTED = { runner: { environment: 'github-hosted', os: 'Linux', arch: 'X64' } };

const pullRequestRun = (prNumber: number, runId: number): Contexts => ({
  github: {
    event_name: 'pull_request',
    run_id: runId,
    ref: `refs/pull/${prNumber}/merge`,
    event: { pull_request: { number: prNumber } },
  },
});

const pushRun = (branch: string, runId: number): Contexts => ({
  github: {
    event_name: 'push',
    run_id: runId,
    ref: `refs/heads/${branch}`,
    event: {},
  },
});

describe('evaluator behaviour (positive control for everything below)', () => {
  it.each([
    ["true && 'npm' || ''", 'npm'],
    ["false && 'npm' || ''", ''],
    ["'' || 'fallback'", 'fallback'],
    ["'set' || 'fallback'", 'set'],
    ['null || 7', 7],
    ['0 || 7', 7],
    ["'a' == 'a'", true],
    ["'a' == 'b'", false],
    ["!('a' == 'b')", true],
    ['missing.context.path', null],
  ])('evaluates %s', (source, expected) => {
    expect(evaluateExpression(source as string, { existing: { value: 1 } })).toEqual(expected);
  });

  it('reads a dotted context path', () => {
    expect(evaluateExpression('github.event.pull_request.number', pullRequestRun(2329, 1))).toBe(
      2329
    );
  });

  it('interpolates several expressions into one scalar', () => {
    expect(evaluateScalar("a-${{ 'b' }}-${{ 1 }}", {})).toBe('a-b-1');
  });
});

describe(`${CI_WORKFLOW}: npm cache is conditioned on the runner (Issue #2329)`, () => {
  const steps = selfHostedSetupNodeSteps();

  // Anti-vacuity: if the parse, the filter or the job list ever comes back
  // empty, every assertion below passes over nothing.
  it('finds the seven setup-node steps it is guarding', () => {
    expect(steps.map(({ jobId }) => jobId).sort()).toEqual([
      'build',
      'lint',
      'security-audit',
      'test-e2e',
      'test-integration',
      'test-unit',
      'type-check',
    ]);
  });

  it.each(steps.map(({ jobId, step }) => [jobId, step] as const))(
    '%s: asks for no npm cache on a self-hosted runner',
    (jobId, step) => {
      const cache = step.with?.cache;
      expect(typeof cache, `${jobId} declares no cache input at all`).toBe('string');

      // setup-node restores only `if (cache && ...)`, so any falsy value means
      // "skip", and its post step saves nothing without the state that branch
      // sets. Restoring the 287 MB entry at ~8 MB/s costs 36s here; the cold
      // `npm ci` it is meant to accelerate costs 27s.
      expect(
        isTruthy(evaluateScalar(cache as string, SELF_HOSTED)),
        `${jobId} would still restore the npm cache on a self-hosted runner`
      ).toBe(false);
    }
  );

  it.each(steps.map(({ jobId, step }) => [jobId, step] as const))(
    '%s: still caches npm on a GitHub-hosted runner (fork PRs)',
    (jobId, step) => {
      expect(
        evaluateScalar(step.with?.cache as string, GITHUB_HOSTED),
        `${jobId} dropped the cache on the hosted runners too, where it restores at 130-180 MB/s`
      ).toBe('npm');
    }
  );
});

describe(`${CI_WORKFLOW}: concurrency (Issue #2329)`, () => {
  const concurrency = ciWorkflow.concurrency;

  const groupFor = (contexts: Contexts): string =>
    String(evaluateScalar(concurrency?.group as string, contexts));
  const cancelsFor = (contexts: Contexts): ExpressionValue =>
    evaluateScalar(String(concurrency?.['cancel-in-progress']), contexts);

  it('is declared at workflow level', () => {
    expect(typeof concurrency?.group).toBe('string');
    expect(concurrency?.['cancel-in-progress']).toBeDefined();
  });

  it('puts two runs of the same pull request in one group, so the older is superseded', () => {
    expect(groupFor(pullRequestRun(2329, 111))).toBe(groupFor(pullRequestRun(2329, 222)));
    expect(cancelsFor(pullRequestRun(2329, 222))).toBe(true);
  });

  it('keeps different pull requests apart', () => {
    expect(groupFor(pullRequestRun(2329, 111))).not.toBe(groupFor(pullRequestRun(2330, 222)));
  });

  it('never lets two pushes to the same branch share a group', () => {
    // The dangerous rewrite is a branch-shaped fallback (`github.ref`,
    // `github.sha`, a literal). The post-merge run on develop is the only place
    // two independently-green PRs are tested together; grouping those runs is
    // one flag away from cancelling that signal.
    expect(groupFor(pushRun('develop', 111))).not.toBe(groupFor(pushRun('develop', 222)));
    expect(groupFor(pushRun('main', 111))).not.toBe(groupFor(pushRun('main', 222)));
  });

  it('never cancels a push run', () => {
    expect(cancelsFor(pushRun('develop', 222))).toBe(false);
    expect(cancelsFor(pushRun('main', 222))).toBe(false);
  });

  it('never lets a push run and a pull request run collide', () => {
    expect(groupFor(pushRun('develop', 2329))).not.toBe(groupFor(pullRequestRun(2329, 111)));
  });
});

describe('workflows that cannot reach a self-hosted runner keep their cache', () => {
  /**
   * Not a loophole: on GitHub-hosted images the npm cache restores at
   * 130-180 MB/s and is a clear win. Asserting it explicitly keeps the rule
   * above readable as "condition on the runner", not "caching is bad".
   */
  it('catalog-drift.yml still caches npm on ubuntu-latest', () => {
    const drift = readWorkflow('catalog-drift.yml');
    const cached = Object.values(drift.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter((step) => (step.uses ?? '').startsWith('actions/setup-node'))
      .map((step) => step.with?.cache);

    expect(cached).toEqual(['npm']);
  });
});
