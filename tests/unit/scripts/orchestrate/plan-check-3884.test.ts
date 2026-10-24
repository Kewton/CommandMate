/**
 * scripts/orchestrate/plan-check.mjs — the plan is checked before any worker
 * starts (Issue #3884 P7 / P8).
 *
 * Every case runs the real CLI on a state file and real contract.mjs configs
 * written under os.tmpdir(), so a violation is what the script reads from the
 * files, not what a hand-made double says. The expected verdicts are written
 * out per fixture (no output compared with itself).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import { HEAVY_GATES, HEAVY_GATE_LIMIT } from '../../../../scripts/orchestrate/plan-check.mjs';
import { ROUTE_COLUMNS, ROUTE_ROWS } from '../../../../scripts/orchestrate/contract.mjs';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/plan-check.mjs');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-plan-check-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ALL_ROWS = Object.keys(ROUTE_ROWS);
const ALL_COLUMNS = Object.keys(ROUTE_COLUMNS);

/** A routes table: `tested` columns get a test in every row, the other columns are excluded with a reason. */
function routes(tested: string[]) {
  return {
    order: ['記録 → await 送信 → 比較'],
    exclude: {
      columns: Object.fromEntries(ALL_COLUMNS.filter((c) => !tested.includes(c)).map((c) => [c, `${c} はこの状態を読まない`])),
    },
    cells: ALL_ROWS.flatMap((row) => tested.map((column) => ({ row, column, tests: [`tests/unit/x/${column}.test.ts`] }))),
  };
}

function config(name: string, extra: Record<string, unknown> = {}): string {
  const file = path.join(tmp, `contract-${name}.yaml`);
  fs.writeFileSync(
    file,
    toYaml({ issue: 3884, key: name, title: 'plan check', scope: ['scripts/orchestrate/**'], ...extra }),
  );
  return path.basename(file);
}

const STATE = {
  state: 'auto-yes-confirmation-key',
  published: ['autoYesConfirmationKey'],
  readers: [
    { route: 'poller', code: 'src/lib/polling/auto-yes-poller.ts tick' },
    { route: 'current-output', code: 'src/app/api/worktrees/[id]/current-output/route.ts' },
  ],
  invariant: '記録・比較・公開は同じキー',
};

/** The normal plan: two writers of one state, in two waves, both with a full routes table. */
function normalPlan() {
  return {
    version: 1,
    waves: [
      { id: '1', items: ['a1', 'b1'] },
      { id: '2', items: ['a2'] },
    ],
    items: [
      { id: 'a1', contract: config('a1', { routes: routes(['poller', 'current-output']) }) },
      { id: 'a2', contract: config('a2', { routes: routes(['poller', 'current-output', 'mobile']) }) },
      { id: 'b1', gates: ['lint', 'typecheck', 'unit-related'] },
    ],
    sharedState: [
      {
        ...STATE,
        readers: STATE.readers.map((reader) => ({ ...reader })),
        writers: [
          { item: 'a1', code: 'auto-yes-decision-state.ts recordDecision' },
          { item: 'a2', code: 'auto-yes-decision-state.ts publish' },
        ],
      },
    ],
  };
}

function run(plan: unknown, ...args: string[]) {
  const file = path.join(tmp, 'plan-1-2.state.yaml');
  fs.writeFileSync(file, toYaml(plan));
  const result = spawnSync(process.execPath, [SCRIPT, 'check', '--plan', file, ...args], { encoding: 'utf8' });
  const lines = result.stderr.split('\n').filter((line) => line.startsWith('plan-check: '));
  return { status: result.status, stdout: result.stdout, lines };
}

const rules = (lines: string[]) => lines.map((line) => line.split(': ')[1]);

describe('negative control: a plan that keeps the rules passes', () => {
  it('exits 0 with ok and the item count', () => {
    const { status, stdout, lines } = run(normalPlan());
    expect(lines).toEqual([]);
    expect(status).toBe(0);
    expect(stdout).toBe('plan-check: ok (3 items)\n');
  });

  it('a run without a state file is skipped with exit 0 (the runbook behaves as before)', () => {
    const missing = path.join(tmp, 'plan-none.state.yaml');
    const result = spawnSync(process.execPath, [SCRIPT, 'check', '--plan', missing], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`plan-check: skipped — no state file ${missing}\n`);
  });

  it('a plan without sharedState needs no routes table', () => {
    const plan = { version: 1, waves: [{ items: ['x', 'y'] }], items: [{ id: 'x' }, { id: 'y', contract: config('y') }] };
    expect(run(plan).status).toBe(0);
  });
});

describe('positive: shared writers in one wave', () => {
  it('two writers of the same state in wave 1 are refused', () => {
    const plan = normalPlan();
    plan.waves = [{ id: '1', items: ['a1', 'a2', 'b1'] }];
    const { status, lines } = run(plan);
    expect(status).toBe(1);
    expect(lines).toEqual([
      'plan-check: shared-writer: auto-yes-confirmation-key: a1 and a2 write it in the same wave 1 — put the writers in order (one wave each)',
    ]);
  });

  it('one item listed twice as a writer is still one writer', () => {
    const plan = normalPlan();
    plan.sharedState[0].writers.push({ item: 'a1', code: 'another function' });
    expect(run(plan).status).toBe(0);
  });
});

describe('positive: the routes table is missing or does not cover a reader', () => {
  it('a writer whose contract has no routes table is refused', () => {
    const plan = normalPlan();
    plan.items[0] = { id: 'a1', contract: config('a1') };
    const { status, lines } = run(plan);
    expect(status).toBe(1);
    expect(lines).toEqual(['plan-check: routes-missing: a1 writes auto-yes-confirmation-key but its contract has no routes table']);
  });

  it('a writer with no contract config at all is refused', () => {
    const plan = normalPlan();
    plan.items[0] = { id: 'a1', gates: ['lint'] } as never;
    expect(rules(run(plan).lines)).toEqual(['routes-missing']);
  });

  it('a table that exists but excludes a reader route (one route missing) is refused', () => {
    const plan = normalPlan();
    plan.items[0] = { id: 'a1', contract: config('a1', { routes: routes(['poller']) }) };
    const { status, lines } = run(plan);
    expect(status).toBe(1);
    expect(lines).toEqual([
      'plan-check: routes-reader: a1: reader route "current-output" of auto-yes-confirmation-key has no cell tied to a test (excluded or untested)',
    ]);
  });

  it('a PC-only change: the state has a mobile reader the table excludes', () => {
    const plan = normalPlan();
    plan.sharedState[0].readers.push({ route: 'mobile', code: 'src/components/mobile/MobilePromptSheet.tsx' });
    // a2 tests mobile; a1 only tests poller / current-output.
    expect(run(plan).lines).toEqual([
      'plan-check: routes-reader: a1: reader route "mobile" of auto-yes-confirmation-key has no cell tied to a test (excluded or untested)',
    ]);
  });

  it('a reader route that is not a column of the table is refused', () => {
    const plan = normalPlan();
    plan.sharedState[0].readers.push({ route: 'tile', code: 'src/components/x.tsx' });
    expect(rules(run(plan).lines)).toEqual(['routes-reader', 'routes-reader']);
  });

  it('an incomplete table fails as a contract that does not generate', () => {
    const plan = normalPlan();
    const partial = routes(['poller', 'current-output']);
    partial.cells = partial.cells.filter((cell) => !(cell.row === 'legacy' && cell.column === 'poller'));
    plan.items[0] = { id: 'a1', contract: config('a1', { routes: partial }) };
    const { status, lines } = run(plan);
    expect(status).toBe(1);
    expect(rules(lines)).toEqual(['routes-contract']);
    expect(lines[0]).toContain('1 cell(s) have neither a test nor a reason: legacy × poller');
  });
});

describe('positive: too many heavy gates in one wave', () => {
  it(`counts ${HEAVY_GATES.join(' / ')} and allows ${HEAVY_GATE_LIMIT} per wave by default`, () => {
    const plan = normalPlan();
    plan.items[2] = { id: 'b1', gates: ['lint', 'unit'] };
    plan.items[0] = { id: 'a1', contract: config('a1', { routes: routes(['poller', 'current-output']), gates: ['lint', 'build'] }) };
    const { status, lines } = run(plan);
    expect(status).toBe(1);
    expect(lines).toEqual([
      'plan-check: heavy-gates: wave 1: 2 items with a heavy gate (unit / integration / build / e2e): a1, b1 — at most 1; move one to unit-related or a later wave',
    ]);
  });

  it('one heavy item per wave passes, and unit-related is not heavy', () => {
    const plan = normalPlan();
    plan.items[2] = { id: 'b1', gates: ['lint', 'unit'] };
    expect(run(plan).status).toBe(0);
  });

  it('heavyGateLimit raises the limit', () => {
    const plan: Record<string, unknown> = { ...normalPlan(), heavyGateLimit: 2 };
    const items = plan.items as Array<Record<string, unknown>>;
    items[2] = { id: 'b1', gates: ['unit'] };
    items[0] = { id: 'a1', contract: config('a1', { routes: routes(['poller', 'current-output']), gates: ['integration'] }) };
    expect(run(plan).status).toBe(0);
  });
});

describe('the plan shape', () => {
  it('reports an unknown item, an item in two waves and an item in no wave', () => {
    const plan = normalPlan();
    plan.waves = [{ id: '1', items: ['a1', 'zz'] }, { id: '2', items: ['a1'] }];
    const { status, lines } = run(plan);
    expect(status).toBe(1);
    expect(lines).toEqual([
      'plan-check: plan: wave 1: unknown item "zz"',
      'plan-check: plan: wave 2: "a1" is already in wave 1',
      'plan-check: plan: a2: in no wave',
      'plan-check: plan: b1: in no wave',
    ]);
  });

  it('a state without an invariant is refused', () => {
    const plan = normalPlan();
    (plan.sharedState[0] as Record<string, unknown>).invariant = '';
    expect(run(plan).lines).toEqual(['plan-check: plan: auto-yes-confirmation-key: invariant (what must not break) is required']);
  });

  it('--json prints the violations on one line', () => {
    const plan = normalPlan();
    plan.waves = [{ id: '1', items: ['a1', 'a2', 'b1'] }];
    const { stdout } = run(plan, '--json');
    const out = JSON.parse(stdout);
    expect(out.skipped).toBe(false);
    expect(out.violations.map((v: { rule: string }) => v.rule)).toEqual(['shared-writer']);
  });

  it('exits 2 on a usage error', () => {
    expect(spawnSync(process.execPath, [SCRIPT, 'check'], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(process.execPath, [SCRIPT, 'nope', '--plan', 'x'], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('routes: the review input for one item', () => {
  it('lists the state the item writes, its readers and invariant, and the routes table', () => {
    const file = path.join(tmp, 'plan-1-2.state.yaml');
    fs.writeFileSync(file, toYaml(normalPlan()));
    const result = spawnSync(process.execPath, [SCRIPT, 'routes', '--plan', file, '--item', 'a1'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const out = result.stdout;
    expect(out).toContain('## 割込み順序と読者の一覧（plan-check.mjs routes、item a1）');
    expect(out).toContain('- auto-yes-confirmation-key: 不変条件「記録・比較・公開は同じキー」');
    expect(out).toContain('  - 書き手: a2 — auto-yes-decision-state.ts publish');
    expect(out).toContain('  - 公開値: autoYesConfirmationKey');
    expect(out).toContain('  - 読む経路: poller — src/lib/polling/auto-yes-poller.ts tick');
    expect(out).toContain('- 記録 → await 送信 → 比較');
    expect(out).toContain('- 無効化 × current-output: tests/unit/x/current-output.test.ts');
    expect(out).toContain('- 列 push（全行）: push はこの状態を読まない');
  });

  it('an item that writes no shared state says so', () => {
    const file = path.join(tmp, 'plan-1-2.state.yaml');
    fs.writeFileSync(file, toYaml(normalPlan()));
    const result = spawnSync(process.execPath, [SCRIPT, 'routes', '--plan', file, '--item', 'b1'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('- なし（plan の sharedState に、この item を書き手とする状態は無い）');
    expect(result.stdout).toContain('- 契約に routes が無い');
  });
});
