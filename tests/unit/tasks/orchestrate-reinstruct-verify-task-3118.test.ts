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
    expect(section('3-5')).toMatch(/wait .*--verify/);
  });
});
