/**
 * contract.mjs `routes` — the route × interrupt table of a contract (Issue #3884).
 *
 * Before #3884 an unknown `routes` key was silently ignored, so a half-filled
 * table generated a contract (positive controls below). Omitting the key must
 * leave the goal exactly as it was (negative controls). Every file is under
 * os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import {
  ContractConfigError,
  ROUTE_COLUMNS,
  ROUTE_ROWS,
  buildContract,
  contractYaml,
  normalizeConfig,
  readTemplate,
  GOAL_TEMPLATE,
} from '../../../../scripts/orchestrate/contract.mjs';
import { parseTaskContract } from '@/lib/tasks/contract-parser';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/contract.mjs');

const base = {
  issue: 3884,
  title: '共有状態・経路・重い検証を計画時に検査する',
  scope: ['scripts/orchestrate/**'],
  decisions: ['決定の 1 行'],
  issueBody: '本文',
};

/** Only poller is tested (every row); the other columns are excluded wholesale. */
const table = () => ({
  order: ['記録 → await 送信 → 比較'],
  exclude: {
    columns: Object.fromEntries(
      Object.keys(ROUTE_COLUMNS)
        .filter((c) => c !== 'poller')
        .map((c) => [c, `${c} は読まない`]),
    ),
  },
  cells: Object.keys(ROUTE_ROWS).map((row) => ({ row, column: 'poller', tests: ['tests/unit/polling/p.test.ts'] })),
});

const problems = (raw: Record<string, unknown>): string[] => {
  try {
    normalizeConfig(raw);
  } catch (error) {
    if (error instanceof ContractConfigError) return (error as ContractConfigError & { problems: string[] }).problems;
    throw error;
  }
  return [];
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-routes-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('negative control: no routes key, the goal of today', () => {
  it('has no routes section and no gap where the placeholder was', () => {
    const goal = buildContract(normalizeConfig(base)).goal;
    expect(goal).not.toContain('経路表');
    expect(goal).toContain('## Issue 本文\n本文\n\n## 実装の進め方\n');
    expect(goal).not.toMatch(/\n\n\n/);
  });

  it('the {{ROUTES}} line is in the template once and leaves nothing behind', () => {
    // fill() drops a line that is only an empty placeholder, so the line goes whole.
    const template = readTemplate(GOAL_TEMPLATE);
    expect(template.split('\n').filter((line) => line === '{{ROUTES}}')).toHaveLength(1);
    const goal = buildContract(normalizeConfig(base)).goal;
    expect(goal.split('\n').some((line) => line.includes('{{'))).toBe(false);
  });

  it('adds no key to the contract (the parser sees the same shape)', () => {
    const contract = buildContract(normalizeConfig({ ...base, routes: table() }));
    expect(Object.keys(contract)).toEqual(['version', 'title', 'goal', 'scope', 'verify', 'success']);
  });
});

describe('a full table goes into the goal', () => {
  it('lists the order, the tested cells and the excluded cells, after the Issue body', () => {
    const goal = buildContract(normalizeConfig({ ...base, routes: table() })).goal;
    const section = goal.indexOf('## 経路表と割込み表（行＝割込み、列＝経路。この契約で守る）');
    expect(section).toBeGreaterThan(goal.indexOf('## Issue 本文'));
    expect(section).toBeLessThan(goal.indexOf('## 実装の進め方'));
    expect(goal).toContain('- 記録 → await 送信 → 比較');
    expect(goal).toContain('- 無効化 × poller: tests/unit/polling/p.test.ts');
    expect(goal).toContain('- 旧形式 × poller: tests/unit/polling/p.test.ts');
    expect(goal).toContain('- 列 スマホ／タイル（全行）: mobile は読まない');
    expect(goal).toContain('除外したセルや表に無い経路に変更が及ぶと分かったら');
  });

  it('is a contract the real parser accepts', () => {
    const contract = parseTaskContract(contractYaml(normalizeConfig({ ...base, routes: table() })), 'generated');
    expect(contract.goal).toContain('## 経路表と割込み表');
  });

  it('the CLI writes it from a YAML config', () => {
    const file = path.join(tmp, 'contract-3884.yaml');
    fs.writeFileSync(file, toYaml({ ...base, routes: table() }));
    const result = spawnSync(process.execPath, [SCRIPT, 'generate', '--config', file, '--stdout'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('無効化 × poller');
  });
});

describe('positive: a table that is only present does not pass', () => {
  it('an empty table names every uncovered cell', () => {
    const found = problems({ ...base, routes: {} });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^routes: 60 cell\(s\) have neither a test nor a reason: disable × poller, /);
  });

  it('a cell left out is named', () => {
    const t = table();
    t.cells = t.cells.filter((c) => c.row !== 'missing');
    expect(problems({ ...base, routes: t })).toEqual(['routes: 1 cell(s) have neither a test nor a reason: missing × poller']);
  });

  it('a table that excludes everything is refused', () => {
    const t = table();
    t.exclude.columns.poller = 'poller も読まない';
    t.cells = [];
    expect(problems({ ...base, routes: t })).toEqual(['routes: every cell is excluded — tie at least one cell to a test']);
  });

  it('an exclusion without a reason, a cell with both or neither, and a non-test are refused', () => {
    const t = table();
    t.exclude.columns.push = ' ';
    const cells: Array<Record<string, unknown>> = [...t.cells];
    cells[0] = { row: 'disable', column: 'poller', tests: ['tests/unit/a.test.ts'], excluded: '両方' };
    cells[1] = { row: 'manual-answer', column: 'poller' };
    cells[2] = { row: 'interval-change', column: 'poller', tests: ['TBD'] };
    expect(problems({ ...base, routes: { ...t, cells } })).toEqual([
      'routes.exclude.columns.push: the reason must be a non-empty string',
      'routes.cells[0]: disable × poller needs exactly one of tests / excluded',
      'routes.cells[1]: manual-answer × poller needs exactly one of tests / excluded',
      'routes.cells[2]: interval-change × poller tests must be test files under tests/ (got TBD)',
      'routes: 6 cell(s) have neither a test nor a reason: disable × push, manual-answer × push, interval-change × push, generation-change × push, missing × push, legacy × push',
    ]);
  });

  it('an unknown row / column, a duplicate, and a cell in an excluded column are refused', () => {
    const t = table();
    const cells: Array<Record<string, unknown>> = [
      ...t.cells,
      { row: 'nope', column: 'poller', tests: ['tests/unit/a.test.ts'] },
      { row: 'disable', column: 'nope', tests: ['tests/unit/a.test.ts'] },
      { row: 'disable', column: 'poller', tests: ['tests/unit/a.test.ts'] },
      { row: 'disable', column: 'push', tests: ['tests/unit/a.test.ts'] },
    ];
    const found = problems({ ...base, routes: { ...t, cells } });
    expect(found[0]).toMatch(/^routes\.cells\[6\]: unknown row "nope"/);
    expect(found[1]).toMatch(/^routes\.cells\[7\]: unknown column "nope"/);
    expect(found.slice(2)).toEqual([
      'routes.cells[8]: disable × poller is listed twice',
      'routes.cells[9]: disable × push is in column push, already excluded',
    ]);
  });

  it('extraColumns adds a route that then has to be covered', () => {
    const t = { ...table(), extraColumns: ['tile'] };
    expect(problems({ ...base, routes: t })[0]).toBe(
      'routes: 6 cell(s) have neither a test nor a reason: disable × tile, manual-answer × tile, interval-change × tile, generation-change × tile, missing × tile, legacy × tile',
    );
    expect(problems({ ...base, routes: { ...t, extraColumns: ['poller'] } })).toEqual(['routes.extraColumns[0]: "poller" is already a column']);
  });
});
