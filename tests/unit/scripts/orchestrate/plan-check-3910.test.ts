/**
 * scripts/orchestrate/plan-check.mjs — `routes` stops on the same checks as
 * `check`, and state names are matched after NFKC / whitespace folding / case
 * folding (Issue #3910). Plans are written under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import { stateKey } from '../../../../scripts/orchestrate/plan-check.mjs';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/orchestrate/plan-check.mjs');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-plan-check-3910-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function cli(command: 'check' | 'routes', plan: unknown) {
  const file = path.join(tmp, 'plan.state.yaml');
  fs.writeFileSync(file, toYaml(plan));
  const args = command === 'routes' ? ['routes', '--plan', file, '--item', 'x'] : ['check', '--plan', file];
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

const goodPlan = () => ({ version: 1, waves: [{ id: '1', items: ['x', 'y'] }], items: [{ id: 'x' }, { id: 'y' }] });
const badPlan = () => ({ version: 1, waves: [{ id: '1', items: ['x'] }], items: [{ id: 'x' }, { id: 'y' }] });

describe('routes stops on the violations check reports (#3910 item 1)', () => {
  it('exits 1 with the violation on a plan check refuses, and prints no list', () => {
    expect(cli('check', badPlan()).status).toBe(1);
    const routes = cli('routes', badPlan());
    expect(routes.status).toBe(1);
    expect(routes.stdout).toBe('');
    expect(routes.stderr).toContain('plan-check: plan: y: in no wave');
  });

  it('negative control: a correct plan still prints the list and exits 0', () => {
    const routes = cli('routes', goodPlan());
    expect(routes.status).toBe(0);
    expect(routes.stdout).toContain('## 割込み順序と読者の一覧（plan-check.mjs routes、item x）');
    expect(routes.stdout).toContain('- なし');
  });
});

describe('state names are matched after normalisation (#3910 item 2)', () => {
  const record = (state: string) => ({ state, invariant: 'i', writers: [{ item: 'x', code: 'c' }], readers: [{ route: 'poller', code: 'c' }] });
  const planWith = (a: string, b: string) => ({ ...goodPlan(), sharedState: [record(a), record(b)] });
  const duplicate = (a: string, b: string) => cli('check', planWith(a, b)).stderr.includes('is already sharedState[0]');

  it.each([
    ['case', 'Auto-Yes-Key', 'auto-yes-key'],
    ['inner whitespace', 'auto yes  key', 'auto yes key'],
    ['tab and newline', 'auto\tyes key', 'auto yes\nkey'],
    ['full width (NFKC)', 'ＡＵＴＯ key', 'auto key'],
    ['surrounding whitespace', ' auto-yes-key ', 'auto-yes-key'],
  ])('%s: the same state', (_label, a, b) => {
    expect(stateKey(a)).toBe(stateKey(b));
    expect(duplicate(a, b)).toBe(true);
  });

  it.each([
    ['a hyphen is not a space', 'auto-yes-key', 'auto yes key'],
    ['a different word', 'auto-yes-key', 'auto-yes-keys'],
    ['no space vs a space', 'autoyes', 'auto yes'],
  ])('%s: different states', (_label, a, b) => {
    expect(stateKey(a)).not.toBe(stateKey(b));
    expect(duplicate(a, b)).toBe(false);
  });
});
