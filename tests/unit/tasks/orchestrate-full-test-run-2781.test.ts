/**
 * ワーカーにテスト全体を実行させる条件は狭い（Issue #2781）
 *
 * ## 何を固定するか
 *
 * 2-4-2 の goal 雛形は「テスト全体（`npm run test:unit`）は実行しない」が既定で、
 * 差し替えの逃げ道が付いている。2026-09-20 の run では、オーケストレーターが
 * **Issue の受入基準に `npm run test:unit` と書いてあったから**という理由でその逃げ道を使い、
 * ワーカーのテスト全体と別 worktree の検証ゲートが同じマシンで重なった。
 *
 * 結果は偽の赤: `Test Files 117 passed / Tests 1532 passed` で失敗テストはゼロなのに exit 1
 * （`EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`）。
 * 排他が片側にしかない（`verify` は `mutex: cpu.heavy` を取り、ワーカーの直接実行は取らない）ことが原因で、
 * 単独再実行では再現しなかった。
 *
 * このテストは、(a) 逃げ道の条件が狭いまま保たれること、(b) その理由（mutex の非対称）が残ること、
 * (c) 3-4 が「全部通っているのに exit 1」の帰属手順を持つこと、
 * (d) issue-create の受入基準テンプレートが注意書きを持つこと、を固定する。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ORCHESTRATE_PATH = '.claude/commands/orchestrate.md';
const ISSUE_CREATE_PATH = '.claude/commands/issue-create.md';
const orchestrate = readFileSync(path.join(REPO_ROOT, ORCHESTRATE_PATH), 'utf-8');
const issueCreate = readFileSync(path.join(REPO_ROOT, ISSUE_CREATE_PATH), 'utf-8');

/** The body of `### <id>. …`, up to the next `### ` heading. */
function section(id: string): string {
  const lines = orchestrate.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${id}.`));
  expect(start, `${ORCHESTRATE_PATH} has no \`### ${id}.\` heading`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  expect(body.trim().length, `section ${id} is empty`).toBeGreaterThan(200);
  return body;
}

describe('[#2781] 2-4-2: the goal template still defaults to "do not run the full suite"', () => {
  const body = section('2-4-2');

  it('keeps the default instruction verbatim', () => {
    expect(body).toContain('テスト全体（`npm run test:unit`）は実行しないこと。全体は検証ゲートか CI が実行する。');
  });

  // The sentence has to be in BOTH places: inside the template's escape-hatch
  // placeholder (which is what the orchestrator copies when writing a goal) and
  // in the standalone condition paragraph below it. Pinning only one lets the
  // other be deleted silently — which is how this guard first passed a mutation.
  it('says inside the template that an acceptance criterion is not a reason to substitute', () => {
    const placeholder = body.slice(body.indexOf('<差し替えてよいのは'), body.indexOf('>', body.indexOf('<差し替えてよいのは')));
    expect(placeholder.length, 'no escape-hatch placeholder in the template').toBeGreaterThan(50);
    expect(placeholder).toMatch(/受入基準に `npm run test:unit` と\s*\n?\s*書いてあることは差し替えの理由にならない/);
  });

  it('repeats it in the standalone condition paragraph', () => {
    expect(body).toContain(
      '**Issue の受入基準に `npm run test:unit` と書いてあることは、差し替えの理由にならない。**'
    );
  });

  it('names the only cases that DO justify substituting', () => {
    expect(body).toMatch(/テストの共通設定・ヘルパーを変える/);
    expect(body).toMatch(/広い範囲の rename/);
    expect(body).toMatch(/対のテストでは破損が見えない/);
  });
});

describe('[#2781] 2-4-2: the reason the condition is narrow is recorded', () => {
  const body = section('2-4-2');

  it('names the asymmetry: verify takes the mutex, the worker does not', () => {
    expect(body).toContain('mutex: cpu.heavy');
    expect(body).toMatch(/ワーカーが goal の指示で直接叩く `npm run test:unit` は mutex を取らない/);
  });

  it('carries the measurement, including that tests all passed', () => {
    expect(body).toMatch(/Test Files 117 passed \/ Tests 1532 passed/);
    expect(body).toMatch(/失敗テストはゼロなのに exit 1/);
    expect(body).toContain('EnvironmentTeardownError');
    expect(body).toMatch(/単独再実行すると exit 0/);
  });

  it('records that the orchestrator substituted BECAUSE of the acceptance criteria', () => {
    expect(body).toMatch(/Issue の受入基準にそう書いてあったから/);
  });
});

describe('[#2781] 3-4: a gate whose tests all passed is not the worker’s fault', () => {
  const body = section('3-4');

  it('lists "zero failed tests but exit 1" under the not-worker-caused verdicts', () => {
    const marker = '**ワーカー起因ではない**';
    const idx = body.indexOf(marker);
    expect(idx, '3-4 has no not-worker-caused bullet').toBeGreaterThan(-1);
    expect(body).toMatch(/失敗したテストが 0 件/);
    expect(body).toContain('EnvironmentTeardownError');
  });

  it('tells the orchestrator to re-run the single gate under lower load before judging', () => {
    expect(body).toMatch(/負荷が下がってから/);
    expect(body).toContain('commandmatedev verify "$WT" --gates');
    expect(body).toMatch(/再現しなければワーカー起因ではない/);
  });

  it('points back at the 2-4-2 explanation rather than restating the mechanism', () => {
    expect(body).toMatch(/2-4-2/);
  });
});

describe('[#2781] issue-create: the acceptance-criteria template warns about the full suite', () => {
  it('tells the author to add "検証ゲートが実行する"', () => {
    expect(issueCreate).toMatch(/`npm run test:unit`（テスト全体）を受入基準に書くときは「検証ゲートが実行する」と添える/);
  });

  it('explains the consequence and points at 2-4-2', () => {
    expect(issueCreate).toMatch(/goal へ写し/);
    expect(issueCreate).toContain('mutex: cpu.heavy');
    expect(issueCreate).toMatch(/2-4-2/);
  });

  it('sits inside the acceptance-criteria section, not somewhere else', () => {
    const start = issueCreate.indexOf('## 受入基準 (Acceptance Criteria)');
    const end = issueCreate.indexOf('## 逸脱時の扱い');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(issueCreate.slice(start, end)).toContain('検証ゲートが実行する');
  });
});
