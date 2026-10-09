/**
 * `/orchestrate` の再指示後の裁定は `wait` → `verify --task` である（Issue #3118）
 *
 * `wait --verify` は進行中の task にしか紐づかないので、終了済みの task を再指示した後は
 * scope が SKIP・env-clean が ERROR になる。手順書が LLM に実行されるので文面で固定する。
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ORCHESTRATE_PATH = '.claude/commands/orchestrate.md';
const orchestrate = readFileSync(path.join(REPO_ROOT, ORCHESTRATE_PATH), 'utf-8');

// Since #3481 (2 本目) the run-time-optional procedures live in docs/orchestrate/; the body section points there.
/** The `## <heading>` section of docs/orchestrate/<file>, up to the next `## ` heading. */
function docSection(file: string, heading: string): string {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/orchestrate', file), 'utf-8');
  const start = doc.indexOf(`\n## ${heading}\n`);
  expect(start, `docs/orchestrate/${file} has no \`## ${heading}\``).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf('\n## ', start + 1);
  return doc.slice(start, end === -1 ? undefined : end);
}

/** The body of `### <id>. …`, up to the next `### ` heading. */
function section(id: string): string {
  const lines = orchestrate.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`### ${id}.`));
  expect(start, `${ORCHESTRATE_PATH} has no \`### ${id}.\` heading`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('orchestrate re-instruct verification (Issue #3118)', () => {
  it('3-4 has both a plain wait and `verify "$WT" --task`', () => {
    const body = section('3-4');
    expect(body).toContain('verify "$WT" --task');
    const waitLines = body.split('\n').filter((l) => l.includes('commandmatedev wait "$WT"'));
    expect(waitLines.length).toBeGreaterThan(0);
    expect(waitLines.some((l) => !l.includes('--verify'))).toBe(true);
  });

  it('4-3 no longer defers to `wait --verify` and mentions --task', () => {
    const body = section('4-3');
    expect(body).not.toContain('次の `wait --verify` で裁定される');
    expect(body).toContain('--task');
  });

  it('the error table has a row for the detached-task symptoms', () => {
    const row = orchestrate
      .split('\n')
      .find((l) => l.startsWith('|') && (l.includes('was not attached') || l.includes('no baseline snapshot')));
    expect(row).toBeDefined();
    expect(row).toContain('--task');
  });

  it('3-5 (switch to a new contract) keeps `wait ... --verify`', () => {
    expect(`${section('3-5')}\n${docSection('switching.md', '3-5 Antigravity から Claude への切り替え')}`).toMatch(/wait .*--verify/);
  });
});

describe('orchestrate 3-4 verify commands are bound to the task (Issue #3123)', () => {
  it('has no `verify "$WT"` line without --task, history or show', () => {
    const lines = section('3-4')
      .split('\n')
      .filter((l) => l.includes('commandmatedev verify "$WT"'))
      .filter((l) => !l.includes('--task') && !l.includes('history') && !l.includes('show'));
    expect(lines).toEqual([]);
  });

  it('reads the first run with `verify show`', () => {
    expect(section('3-4')).toContain('verify show');
  });

  it('the post-re-instruct verify line has no --gates', () => {
    const lines = section('3-4')
      .split('\n')
      .filter((l) => l.includes('verify "$WT" --task "$TASK_ID" --json'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !l.includes('--gates'))).toBe(true);
  });

  it('3-3 keeps the `--gates token-discipline` fallback', () => {
    expect(`${section('3-3')}\n${docSection('workers.md', '3-3 完了検出が壊れたときの退避')}`).toContain('--gates token-discipline');
  });
});
