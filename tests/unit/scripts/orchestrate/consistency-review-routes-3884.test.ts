/**
 * The review input carries the plan's interrupt order and readers (Issue #3884 G6-6).
 *
 * consistency-review.mjs `--routes` puts the output of plan-check.mjs routes
 * into the brief, and the re-review asks for every reader of each rule the
 * fix changed, not only the previous findings. Without `--routes` the brief
 * says nothing was passed (the run behaves as before). The runbook's calls are
 * fed to the scripts' own parsers.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_ROUTES, buildPrompt, parseArgs } from '../../../../scripts/orchestrate/consistency-review.mjs';
import { parseArgs as parsePlanCheckArgs } from '../../../../scripts/orchestrate/plan-check.mjs';

const REPO = path.resolve(__dirname, '../../../..');
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const input = {
  issue: 3884,
  head: HEAD,
  worktree: '/work/commandmate-issue-3884',
  branch: 'feature/3884-e1',
  brief: '機能追加です。',
};
const ROUTES = '## 割込み順序と読者の一覧（plan-check.mjs routes、item 3884-e1）\n- auto-yes-key: 不変条件「同じキー」\n';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orchestrate-review-routes-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the brief carries the readers', () => {
  it('puts the routes after the Issue brief and asks for each reader and the await order', () => {
    const prompt = buildPrompt({ ...input, routes: ROUTES });
    const brief = prompt.indexOf('機能追加です。');
    const section = prompt.indexOf('■ 割込み順序と読者の一覧');
    expect(section).toBeGreaterThan(brief);
    expect(prompt.indexOf('- auto-yes-key: 不変条件「同じキー」')).toBeGreaterThan(section);
    expect(prompt).toContain('順序（await の前後）が保たれているか');
    expect(prompt).not.toContain(NO_ROUTES);
  });

  it('negative: without routes the brief says none was passed, and nothing else changes', () => {
    const without = buildPrompt(input);
    expect(without).toContain(`■ 割込み順序と読者の一覧（plan の共有状態の表と、契約の経路表・割込み表。#3884）\n${NO_ROUTES}\n`);
    expect(buildPrompt({ ...input, routes: '  \n' })).toBe(without);
    expect(without).not.toContain('{{');
  });

  it('the re-review re-checks every reader of the rules the fix changed', () => {
    const prompt = buildPrompt({ ...input, routes: ROUTES, previous: 'P2: 前回の指摘\nDONE: 指摘 1 件' });
    const judge = prompt.indexOf('(0) 前回の指摘の判定');
    const readers = prompt.indexOf('(0b) 修正した共通規則の全読者の再確認');
    expect(readers).toBeGreaterThan(judge);
    expect(prompt).toContain('前回の指摘の箇所だけを見て「解消」としない');
    expect(prompt).toContain('- auto-yes-key: 不変条件「同じキー」');
  });
});

describe('--routes', () => {
  const required = ['--run-dir', '', '--issues', '3880-3884', '--issue', '3884', '--head', HEAD.slice(0, 7)];

  it('is optional and names a file that exists', () => {
    const brief = path.join(tmp, 'brief.txt');
    fs.writeFileSync(brief, 'x');
    const args = [...required, '--brief', brief];
    args[1] = tmp;
    expect(parseArgs(args)).toHaveProperty('options');
    expect(parseArgs([...args, '--routes', path.join(tmp, 'gone.md')])).toEqual({
      error: `--routes: no such file ${path.join(tmp, 'gone.md')}`,
    });
    const routes = path.join(tmp, 'routes.md');
    fs.writeFileSync(routes, ROUTES);
    expect((parseArgs([...args, '--routes', routes]) as unknown as { options: { routes: string } }).options.routes).toBe(routes);
  });
});

describe('the documented calls parse', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs/orchestrate/plan-check.md'), 'utf8');
  const calls = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => m[1].replace(/\\\n/g, ' '))
    .flatMap((block) => block.split('\n'))
    .filter((line) => line.startsWith('node scripts/orchestrate/plan-check.mjs '));

  it('finds both calls (anti-vacuity)', () => {
    expect(calls.map((line) => line.split(' ')[2])).toEqual(['check', 'routes']);
  });

  it.each([0, 1])('call %i is accepted by plan-check.mjs parseArgs', (index) => {
    const tokens = (calls[index].split(' > ')[0].match(/"[^"]*"|\S+/g) ?? []).slice(2).map((t) => t.replace(/^"|"$/g, ''));
    expect(parsePlanCheckArgs(tokens)).toHaveProperty('options');
  });

  it('the runbook names plan-check in 1-4 and the routes in 2-4 and 5-2b', () => {
    const body = fs.readFileSync(path.join(REPO, '.claude/commands/orchestrate.md'), 'utf8');
    expect(body).toContain('node scripts/orchestrate/plan-check.mjs check --plan <state file>');
    expect(body).toContain('docs/orchestrate/plan-check.md#2-4-経路表と割込み表の書き方');
    expect(body).toContain('状態ファイルがある run は `--routes`');
  });
});
