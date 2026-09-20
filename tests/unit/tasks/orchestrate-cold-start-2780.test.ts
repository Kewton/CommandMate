/**
 * `/orchestrate` の exit 99 復旧は「まず画面を見る」で一貫している（Issue #2780）
 *
 * ## 何を固定するか
 *
 * exit 99（`prompt not ready`）の復旧手順は **3 箇所**に書かれている — 1-2b の運用メモ、
 * 3-1 の「冷間起動の失敗」、エラーハンドリングの表。手順書は LLM が実行するので、
 * 1 箇所だけ「約 2 分待ってから再送」のまま残ると、実行者はそちらを読んで 2 分を捨てる。
 * 散文の食い違いは何も落とさないので、これが唯一の検出器になる
 * （`orchestrate-merge-gate-consistency.test.ts` と同じ理由）。
 *
 * ## なぜ「待つ」を消したか
 *
 * 新規 worktree ではフォルダ信頼ダイアログがほぼ必ず出る。ダイアログは待っても消えないので、
 * 「2 分待ってから再送」は 2 分を払ったうえで 2 回目も同じ exit 99 になる（2026-09-20、#2770 で実測）。
 * 待つ価値があるのは「まだ起動中」のときだけで、それは画面を見れば分かる。
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
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  expect(body.trim().length, `section ${id} is empty`).toBeGreaterThan(200);
  return body;
}

/** The `| … |` row of the error-handling table whose first cell contains `needle`. */
function errorRow(needle: string): string {
  const rows = orchestrate.split('\n').filter((line) => line.startsWith('| ') && line.includes(needle));
  expect(rows, `no error-table row containing ${needle}`).toHaveLength(1);
  return rows[0];
}

describe('[#2780] 3-1: capture comes before any wait', () => {
  const body = section('3-1');

  it('tells the orchestrator to look at the screen before waiting', () => {
    expect(body).toMatch(/待つ前に画面を見る/);
    const capture = body.indexOf('commandmatedev capture "$WT" --instance "$AGENT" --pane');
    const wait = body.indexOf('約 2 分待って');
    expect(capture, 'no capture command in the cold-start recovery').toBeGreaterThan(-1);
    expect(wait, 'the 2-minute wait should still exist, for the still-launching case').toBeGreaterThan(-1);
    expect(capture, 'capture must be described before the wait').toBeLessThan(wait);
  });

  it('branches on three screens, and only one of them waits', () => {
    // The table is nested inside a bullet, so its rows are indented.
    const rows = body.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('| '));
    const branch = rows.filter((r) => /再送|待って/.test(r));
    expect(branch.length, 'expected a 3-row branch table').toBeGreaterThanOrEqual(3);
    expect(branch.filter((r) => r.includes('待たずに再送')).length).toBe(2);
    expect(branch.filter((r) => /約 2 分待って/.test(r)).length).toBe(1);
  });

  it('keeps the trailing colon on the tmux target (without it: `can not find pane`)', () => {
    const row = body.split('\n').find((line) => line.includes('send-keys') && line.includes('Enter'));
    expect(row, 'no tmux send-keys row in the branch table').toBeDefined();
    expect(row).toMatch(/-t "=mcbd-<agent>-<worktree-id>:"/);
  });

  it('still says the message was never delivered and the task id is replaced', () => {
    expect(body).toMatch(/メッセージは送られていない/);
    expect(body).toMatch(/task id を差し替える/);
  });
});

describe('[#2780] the three places agree', () => {
  it('1-2b points at 3-1 rather than repeating the procedure', () => {
    const body = section('1-2b');
    expect(body).toMatch(/新規 worktree では信頼ダイアログがほぼ必ず出る/);
    expect(body).toMatch(/待たずにまず画面を見る/);
    expect(body).toMatch(/3-1/);
  });

  it('the error table no longer tells the reader to wait first', () => {
    const row = errorRow('send が exit 99');
    expect(row).toMatch(/待つ前に capture/);
    expect(row).not.toMatch(/約 2 分後に 1 回だけ再送/);
    expect(row).toMatch(/3-1/);
  });

  it('no place still opens the recovery with the bare 2-minute wait', () => {
    // The old wording, verbatim. Its return is the regression.
    expect(orchestrate).not.toContain('約 2 分待ってから 1 回だけ再送する。再送では task が作り直される');
    expect(orchestrate).not.toContain('未送信。約 2 分後に 1 回だけ再送し');
  });
});
