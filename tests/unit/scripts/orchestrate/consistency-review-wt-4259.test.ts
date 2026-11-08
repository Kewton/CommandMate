/**
 * consistency-review.mjs — Issue #4259: --wt must not be the reviewed worktree;
 * a starting send refused with prompt-not-ready is retried once.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPromptNotReady, main } from '../../../../scripts/orchestrate/consistency-review.mjs';

const HEAD = 'c0ffee1' + '0'.repeat(33);
// Real output of workspace/orchestration/runs/2026-11-07/review-4218.start.err
const REAL_ERR =
  'Note: the message was not sent (sendOutcome=not_sent); it is safe to send it again.\nError: Server error: Failed to send message to Codex: Codex prompt not ready: timed out waiting for the input prompt before sending [send state: not-sent (prompt-not-ready): the message was not typed. CommandMate does not resend it; send it again once the input prompt is back (`commandmate prompt <worktree-id> --json` shows the screen and lastSend).]\n';
type R = { status: number; stdout: string; stderr: string };
let tmp: string;
let runDir: string;
let calls: string[][];
let captures: object[];
let sends: R[];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-4259-'));
  runDir = path.join(tmp, 'runs', 'd');
  fs.writeFileSync(path.join(tmp, 'brief.txt'), 'x\n');
  calls = [];
  captures = [];
  sends = [];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const run = (command: string, args: string[]): R => {
  if (command === 'git') return { status: 0, stdout: args.includes('--abbrev-ref') ? 'b\n' : `${HEAD}\n`, stderr: '' };
  calls.push(args);
  if (args[0] === 'capture') {
    const next = captures.length > 1 ? captures.shift()! : captures[0];
    return { status: 0, stdout: JSON.stringify(next), stderr: '' };
  }
  if (args[0] === 'send') return sends.length > 1 ? sends.shift()! : sends[0];
  if (args[0] === 'ask') return { status: 0, stdout: JSON.stringify({ reply: 'DONE: 指摘なし' }), stderr: '' };
  throw new Error('unexpected');
};
const go = (extra: string[]) => {
  const errors: string[] = [];
  const code = main(
    ['--run-dir', runDir, '--issues', '4259', '--issue', '4259', '--head', HEAD.slice(0, 7), '--brief', path.join(tmp, 'brief.txt'), '--cli', 'cmd-fake', ...extra],
    { run, sleep: () => {}, now: () => new Date(Date.UTC(2026, 10, 8)), cwd: tmp, log: () => {}, error: (l: string) => errors.push(l) }
  );
  return { code, errors };
};
const STOPPED = { isRunning: false, sessionStatus: 'idle', sessionStatusReason: 'session_not_running' };
const READY = { isRunning: true, sessionStatus: 'ready' };

describe('--wt is the reviewed worktree (#4259)', () => {
  it.each([
    [['--wt', 'commandmate-issue-4259']],
    [['--wt', 'wt-x', '--worktree', path.join('/x', 'wt-x')]],
  ])('exits 2 and sends nothing: %j', (extra) => {
    captures = [READY];
    sends = [{ status: 0, stdout: '', stderr: '' }];
    const { code, errors } = go(extra);
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(errors.join('\n')).toContain('codex-2');
  });
  it('negative control: the default --wt still reviews', () => {
    captures = [READY];
    expect(go([]).code).toBe(0);
  });
});

describe('start refused with prompt-not-ready is sent again once (#4259)', () => {
  it('recognises the real start.err, not other failures', () => {
    expect(isPromptNotReady({ status: 99, stdout: '', stderr: REAL_ERR })).toBe(true);
    expect(isPromptNotReady({ status: 99, stdout: '', stderr: 'prompt not ready' })).toBe(false);
    expect(isPromptNotReady({ status: 1, stdout: '', stderr: REAL_ERR })).toBe(false);
  });
  it('waits for ready and resends once, then reviews', () => {
    captures = [STOPPED, READY];
    sends = [{ status: 99, stdout: '', stderr: REAL_ERR }, { status: 0, stdout: 't\n', stderr: '' }];
    expect(go([]).code).toBe(0);
    expect(calls.filter((c) => c[0] === 'send')).toHaveLength(2);
  });
  it('a second refusal stops with start-failed (exit 1), no more sends', () => {
    captures = [STOPPED, READY];
    sends = [{ status: 99, stdout: '', stderr: REAL_ERR }];
    expect(go([]).code).toBe(1);
    expect(calls.filter((c) => c[0] === 'send')).toHaveLength(2);
    expect(calls.map((c) => c[0])).not.toContain('ask');
  });
});
