/**
 * scripts/orchestrate/consistency-review.mjs — Issue #3957.
 *
 * An answer `ask --json` marks `"overlapped": true` (another message shared
 * the reviewer's turn, #3955) may be the other message's answer. It is kept in
 * `review-<N>.md` to read, but is not a verdict: `review=fail`, no row in
 * `consistency-review.md`, exit 1. Without the key (or with it false) the
 * answer is a verdict as before.
 *
 * Everything is under os.tmpdir(); `git` / the CLI are injected.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../../../scripts/orchestrate/consistency-review.mjs';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';

const HEAD = 'c0ffee1' + '0'.repeat(33);
const ANSWER = '指摘なし\n\nDONE: 指摘なし';
const READY = { isRunning: true, sessionStatus: 'ready', sessionStatusReason: 'input_prompt' };

type Result = { status: number; stdout: string; stderr: string };

/** What `ask --json` prints (ask.ts printAskReply): `overlapped` only when it is true. */
function askJson(extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    { worktreeId: 'mycodebranchdesk', instanceId: 'codex', cliToolId: 'codex', source: 'history', reply: ANSWER, ...extra },
    null,
    2
  )}\n`;
}

let tmp: string;
let runDir: string;
let askResult: Result;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-3957-'));
  runDir = path.join(tmp, 'runs', '2026-10-28');
  fs.writeFileSync(path.join(tmp, 'brief.txt'), '不具合修正です。\n');
  askResult = { status: 0, stdout: askJson(), stderr: '' };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (command: string, args: string[]): Result => {
  if (command === 'git') return { status: 0, stdout: args.includes('--abbrev-ref') ? 'feature/x\n' : `${HEAD}\n`, stderr: '' };
  if (args[0] === 'capture') return { status: 0, stdout: JSON.stringify(READY), stderr: '' };
  if (args[0] === 'ask') return askResult;
  throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
};
const go = () =>
  main(
    [
      '--run-dir', runDir, '--issues', '3957', '--issue', '3957', '--head', HEAD.slice(0, 7),
      '--brief', path.join(tmp, 'brief.txt'), '--worktree', path.join(tmp, 'wt'), '--cli', 'cmd-fake',
    ],
    { run, sleep: () => {}, now: () => new Date(Date.UTC(2026, 9, 28)), cwd: tmp, log: () => {}, error: () => {} }
  );
const review = () => readRecords(runDir, '3957').records.find((r) => r.stage === 'review');
const table = () => path.join(runDir, 'consistency-review.md');

describe('an overlapped answer is not a verdict (#3957)', () => {
  it('records review=fail with the resend instruction, keeps the .md, adds no row, exits 1', () => {
    askResult = { status: 0, stdout: askJson({ overlapped: true }), stderr: 'overlapped: codex was already in a turn …' };
    expect(go()).toBe(1);
    const record = review();
    expect(record).toMatchObject({ result: 'fail', agent: 'codex' });
    expect(record?.note).toContain('overlapped: 別の依頼への返答かもしれない（そのレビューは裁定に使わない）');
    expect(record?.note).toContain('同じ --instance に重ねず、1 本ずつ送り直す');
    expect(fs.readFileSync(path.join(runDir, 'review-3957.md'), 'utf8')).toBe(`${ANSWER}\n`);
    expect(fs.existsSync(table())).toBe(false);
  });

  it('negative control: no overlapped key is a verdict as before', () => {
    expect(go()).toBe(0);
    expect(review()).toMatchObject({ result: 'ok', note: 'review-3957: DONE: 指摘なし' });
    expect(fs.readFileSync(table(), 'utf8')).toContain('DONE: 指摘なし');
  });

  it('negative control: overlapped false is a verdict as before', () => {
    askResult = { status: 0, stdout: askJson({ overlapped: false }), stderr: '' };
    expect(go()).toBe(0);
    expect(review()?.result).toBe('ok');
    expect(fs.existsSync(table())).toBe(true);
  });
});
