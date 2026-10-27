/**
 * scripts/orchestrate/consistency-review.mjs — Issue #3936.
 *
 * 1. `ask` exit 11 (an upstream fault on the reviewer's screen, e.g. codex's
 *    `Selected model is at capacity`) is recorded apart from other failures,
 *    with the fault id, so the person can switch `--instance`.
 * 2. A reviewer that is not running is started with one short message before
 *    the wait for `ready` (it never reads `ready` on its own).
 *
 * Everything is under os.tmpdir(); `git` / the CLI are injected.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  main,
  parseUpstreamFault,
  READY_MAX_POLLS,
  START_MESSAGE,
  START_READY_MAX_POLLS,
} from '../../../../scripts/orchestrate/consistency-review.mjs';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';

const HEAD = 'c0ffee1' + '0'.repeat(33);
const REPLY = JSON.stringify({ reply: '指摘なし\n\nDONE: 指摘なし' });
const CAPACITY = '■ Selected model is at capacity. Please try a different model.';

type Result = { status: number; stdout: string; stderr: string };
type Capture = Record<string, unknown>;

const READY: Capture = { isRunning: true, sessionStatus: 'ready', sessionStatusReason: 'input_prompt' };
const RUNNING: Capture = { isRunning: true, sessionStatus: 'running', sessionStatusReason: 'thinking_indicator' };
const STOPPED: Capture = { isRunning: false, sessionStatus: 'idle', sessionStatusReason: 'session_not_running' };

let tmp: string;
let runDir: string;
let calls: { command: string; args: string[] }[];
let captures: Capture[];
let sendResult: Result;
let askResult: Result;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-3936-'));
  runDir = path.join(tmp, 'runs', '2026-10-27');
  fs.writeFileSync(path.join(tmp, 'brief.txt'), '不具合修正です。\n');
  calls = [];
  captures = [];
  sendResult = { status: 0, stdout: 'task-1\n', stderr: '' };
  askResult = { status: 0, stdout: REPLY, stderr: '' };
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (command: string, args: string[]): Result => {
  calls.push({ command, args });
  if (command === 'git') return { status: 0, stdout: args.includes('--abbrev-ref') ? 'feature/x\n' : `${HEAD}\n`, stderr: '' };
  // The queue's last read repeats: a reviewer stays where it ended up.
  if (args[0] === 'capture') {
    const next = captures.length > 1 ? captures.shift()! : captures[0];
    return { status: 0, stdout: JSON.stringify(next), stderr: '' };
  }
  if (args[0] === 'send') return sendResult;
  if (args[0] === 'ask') return askResult;
  throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
};
const go = () =>
  main(
    [
      '--run-dir', runDir, '--issues', '3936', '--issue', '3936', '--head', HEAD.slice(0, 7),
      '--brief', path.join(tmp, 'brief.txt'), '--worktree', path.join(tmp, 'wt'), '--cli', 'cmd-fake',
    ],
    { run, sleep: () => {}, now: () => new Date(Date.UTC(2026, 9, 27)), cwd: tmp, log: () => {}, error: () => {} }
  );
const verbs = () => calls.filter((c) => c.command === 'cmd-fake').map((c) => c.args[0]);
const review = () => readRecords(runDir, '3936').records.find((r) => r.stage === 'review');

/** What ask prints on exit 11 with --json: the prompt payload line, then the fault (ask.ts reportWaitFailure). */
const faultStdout = (id: string, matchedText: string) =>
  `${JSON.stringify({ sessionStatus: 'ready' })}\n${JSON.stringify(
    { worktreeId: 'mycodebranchdesk', instanceId: 'codex', cliToolId: 'codex', upstreamFault: { id, matchedText } },
    null,
    2
  )}\n`;

describe('ask exit 11: upstream fault (#3936)', () => {
  it('records review=fail with "upstream fault" and the id, and exits 1', () => {
    captures = [READY];
    askResult = { status: 11, stdout: faultStdout('model-capacity', CAPACITY), stderr: 'Upstream fault on mycodebranchdesk: id=model-capacity' };
    expect(go()).toBe(1);
    const record = review();
    expect(record).toMatchObject({ result: 'fail', agent: 'codex' });
    expect(record?.note).toContain('upstream fault');
    expect(record?.note).toContain('id=model-capacity');
    expect(record?.note).toContain('switch --instance');
    expect(fs.existsSync(path.join(runDir, 'consistency-review.md'))).toBe(false);
  });

  it('a self-retrying fault (overloaded) is not told to switch the model', () => {
    captures = [READY];
    askResult = { status: 11, stdout: faultStdout('overloaded', '529 Overloaded'), stderr: '' };
    expect(go()).toBe(1);
    expect(review()?.note).toContain('upstream fault id=overloaded');
    expect(review()?.note).toContain('retry later or switch --instance, by the id');
  });

  it('exit 11 without a readable fault still says upstream fault', () => {
    captures = [READY];
    askResult = { status: 11, stdout: '', stderr: '' };
    expect(go()).toBe(1);
    expect(review()?.note).toContain('upstream fault id unknown');
  });

  it('negative control: another failing exit (124) is recorded as before', () => {
    captures = [READY];
    askResult = { status: 124, stdout: '', stderr: 'Timeout' };
    expect(go()).toBe(1);
    expect(review()?.note).toMatch(/ask exit=124 \(see review-3936\.err\)$/);
    expect(review()?.note).not.toContain('upstream fault');
  });

  it('parseUpstreamFault reads the fault object after the payload line, and nothing else', () => {
    expect(parseUpstreamFault(faultStdout('model-capacity', CAPACITY))).toEqual({ id: 'model-capacity', matchedText: CAPACITY });
    expect(parseUpstreamFault(REPLY)).toBeNull();
    expect(parseUpstreamFault('')).toBeNull();
    expect(parseUpstreamFault('not json')).toBeNull();
  });
});

describe('a reviewer that is not running is started first (#3936)', () => {
  it('sends the starting message once, then reads ready 3 times, then asks', () => {
    captures = [STOPPED, READY];
    expect(go()).toBe(0);
    expect(verbs()).toEqual(['capture', 'send', 'capture', 'capture', 'capture', 'ask']);
    const send = calls.find((c) => c.args[0] === 'send')!;
    expect(send.args).toEqual(['send', 'mycodebranchdesk', START_MESSAGE, '--instance', 'codex']);
    expect(fs.readFileSync(path.join(runDir, 'review-3936.start.out'), 'utf8')).toBe('task-1\n');
    expect(review()).toMatchObject({ result: 'ok' });
  });

  it('the starting message asks for no work', () => {
    expect(START_MESSAGE).toContain('作業の依頼ではありません');
    expect(START_MESSAGE).toContain('「OK」とだけ返してください');
  });

  it('recognises the stopped session by sessionStatusReason alone too', () => {
    captures = [{ sessionStatus: 'idle', sessionStatusReason: 'session_not_running' }, READY];
    expect(go()).toBe(0);
    expect(verbs().filter((v) => v === 'send')).toHaveLength(1);
  });

  it('a failed start sends no brief: review=fail with the exit code, exit 1', () => {
    captures = [STOPPED];
    sendResult = { status: 99, stdout: '', stderr: 'prompt not ready' };
    expect(go()).toBe(1);
    expect(verbs()).toEqual(['capture', 'send']);
    expect(review()?.result).toBe('fail');
    expect(review()?.note).toContain('starting it failed (send exit=99');
    expect(fs.readFileSync(path.join(runDir, 'review-3936.start.err'), 'utf8')).toBe('prompt not ready');
  });

  it('a started reviewer that never reads ready stops after the shorter bound, sent once', () => {
    captures = [STOPPED];
    expect(go()).toBe(1);
    expect(verbs().filter((v) => v === 'send')).toHaveLength(1);
    expect(verbs().filter((v) => v === 'capture')).toHaveLength(1 + START_READY_MAX_POLLS);
    expect(verbs()).not.toContain('ask');
    expect(review()?.note).toContain(`within ${START_READY_MAX_POLLS} polls after starting it; not sent`);
  });

  // Review of eaeab6d (P2): before the pane exists a launch already in progress
  // reads isRunning:false / session_not_running too; `startingSince` tells it apart.
  it('a reviewer that is already starting (startingSince) is waited for, not sent the starting message', () => {
    captures = [{ ...STOPPED, startingSince: 1_787_500_000_000 }, RUNNING, READY];
    expect(go()).toBe(0);
    expect(verbs()).not.toContain('send');
    expect(verbs()).toEqual(['capture', 'capture', 'capture', 'capture', 'capture', 'ask']);
    expect(fs.existsSync(path.join(runDir, 'review-3936.start.out'))).toBe(false);
  });

  it('negative control: startingSince null is a stopped reviewer, started once', () => {
    captures = [{ ...STOPPED, startingSince: null }, READY];
    expect(go()).toBe(0);
    expect(verbs().filter((v) => v === 'send')).toHaveLength(1);
  });

  it.each([
    ['running', [RUNNING, READY]],
    ['ready', [READY]],
  ])('negative control: a reviewer first read as %s is not started', (_label, queue) => {
    captures = queue as Capture[];
    expect(go()).toBe(0);
    expect(verbs()).not.toContain('send');
    expect(verbs()[verbs().length - 1]).toBe('ask');
  });

  it('negative control: a running reviewer that never reads ready keeps the long bound and is never started', () => {
    captures = [RUNNING];
    expect(go()).toBe(1);
    expect(verbs().filter((v) => v === 'capture')).toHaveLength(READY_MAX_POLLS);
    expect(verbs()).not.toContain('send');
    expect(review()?.note).toContain(`within ${READY_MAX_POLLS} polls; not sent`);
  });
});
