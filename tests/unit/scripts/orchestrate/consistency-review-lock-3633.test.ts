/**
 * scripts/orchestrate/consistency-review.mjs — the reviewer's lock (Issue #3633 C).
 *
 * A review that was killed left its lock directory behind, and the next review
 * waited three hours without a word. The lock now names its owner (pid, host,
 * start time): a gone owner's lock is taken over, a live one is waited for
 * with a `lock held by pid …` line every minute, up to ASK_TIMEOUT_SEC + 600.
 *
 * Everything is under os.tmpdir(); `git` and the CLI are injected.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ASK_TIMEOUT_SEC,
  LOCK_MAX_WAIT_SEC,
  LOCK_OWNER_FILE,
  lockOwnerGone,
  main,
} from '../../../../scripts/orchestrate/consistency-review.mjs';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';

const HEAD = 'c0ffee1' + '0'.repeat(33);
const REPLY = JSON.stringify({ reply: '指摘なし\n\nDONE: 指摘なし' });
const T0 = Date.UTC(2026, 9, 12, 1, 0);

let tmp: string;
let runDir: string;
let lock: string;
let calls: { command: string; args: string[] }[];
let errors: string[];
let ownersDuringAsk: unknown[];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-lock-'));
  runDir = path.join(tmp, 'runs', '2026-10-12');
  lock = path.join(tmp, 'proposals', '2026-10-12', '.lock');
  fs.writeFileSync(path.join(tmp, 'brief.txt'), '機能追加です。\n');
  calls = [];
  errors = [];
  ownersDuringAsk = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (command: string, args: string[]) => {
  calls.push({ command, args });
  if (command === 'git') return { status: 0, stdout: args.includes('--abbrev-ref') ? 'feature/x\n' : `${HEAD}\n`, stderr: '' };
  if (args[0] === 'capture') return { status: 0, stdout: JSON.stringify({ sessionStatus: 'ready' }), stderr: '' };
  if (args[0] === 'ask') {
    ownersDuringAsk.push(JSON.parse(fs.readFileSync(path.join(lock, LOCK_OWNER_FILE), 'utf8')));
    return { status: 0, stdout: REPLY, stderr: '' };
  }
  throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
};

function go() {
  let clock = T0;
  const sleeps: number[] = [];
  const code = main(
    [
      '--run-dir', runDir, '--issues', '3633', '--issue', '3633', '--head', HEAD.slice(0, 7),
      '--brief', path.join(tmp, 'brief.txt'), '--worktree', path.join(tmp, 'wt'), '--lock', lock, '--cli', 'cmd-fake',
    ],
    {
      run,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => new Date(clock),
      cwd: tmp,
      log: () => {},
      error: (line: string) => errors.push(line),
    }
  );
  return { code, sleeps };
}

function holdLock(owner: { pid: number; host: string; startedAt: string }) {
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, LOCK_OWNER_FILE), JSON.stringify(owner));
}

/** A pid that existed and has exited: the review that held the lock was killed. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid as number;
}

describe('the reviewer lock names its owner (#3633 C)', () => {
  it('a lock left by a killed review is taken over: the review runs, and the lock is released', () => {
    const pid = deadPid();
    holdLock({ pid, host: os.hostname(), startedAt: new Date(T0 - 3_600_000).toISOString() });
    const { code, sleeps } = go();
    expect(code).toBe(0);
    expect(sleeps.filter((ms) => ms === 15_000)).toEqual([]);
    expect(errors.join('\n')).toContain(`owner pid ${pid}`);
    expect(errors.join('\n')).toContain('is gone; taking it over');
    expect(ownersDuringAsk).toEqual([expect.objectContaining({ pid: process.pid, host: os.hostname() })]);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(path.dirname(lock))).toEqual([]);
  });

  it('a live owner is waited for, saying so every minute, up to ASK_TIMEOUT_SEC + 600 (negative control)', () => {
    const owner = { pid: process.pid, host: os.hostname(), startedAt: new Date(T0).toISOString() };
    holdLock(owner);
    const { code } = go();
    expect(LOCK_MAX_WAIT_SEC).toBe(ASK_TIMEOUT_SEC + 600);
    expect(code).toBe(1);
    expect(calls.some((c) => c.args[0] === 'ask')).toBe(false);
    const notices = errors.filter((line) => line.includes(`held by pid ${process.pid}`) && line.includes('waiting'));
    // One at the start, then one a minute: about LOCK_MAX_WAIT_SEC / 60 of them, never one per poll.
    expect(notices.length).toBeGreaterThanOrEqual(Math.floor(LOCK_MAX_WAIT_SEC / 60));
    expect(notices.length).toBeLessThanOrEqual(Math.floor(LOCK_MAX_WAIT_SEC / 60) + 2);
    expect(readRecords(runDir, '3633').records.find((r) => r.stage === 'review')?.note).toMatch(
      new RegExp(`still held by pid ${process.pid} .*after ${LOCK_MAX_WAIT_SEC}s`)
    );
    // The holder keeps its lock.
    expect(JSON.parse(fs.readFileSync(path.join(lock, LOCK_OWNER_FILE), 'utf8'))).toEqual(owner);
  });

  it('an owner on another host, or a lock without an owner file, is not judged gone (negative control)', () => {
    expect(lockOwnerGone({ pid: deadPid(), host: `${os.hostname()}-other`, startedAt: '' })).toBe(false);
    expect(lockOwnerGone(null)).toBe(false);
    expect(lockOwnerGone({ pid: process.pid, host: os.hostname(), startedAt: '' })).toBe(false);
    expect(lockOwnerGone({ pid: deadPid(), host: os.hostname(), startedAt: '' })).toBe(true);
  });

  it('the lock it takes holds this process as the owner, and is removed after the review', () => {
    const { code } = go();
    expect(code).toBe(0);
    expect(ownersDuringAsk).toEqual([
      { pid: process.pid, host: os.hostname(), startedAt: new Date(T0).toISOString() },
    ]);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
