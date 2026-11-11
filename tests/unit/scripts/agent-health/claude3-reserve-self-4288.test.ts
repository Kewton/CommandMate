/**
 * Issue #4288 (4): `reserve --self` — claude-3 reserves itself. commandmate goes
 * through an injected `exec` stub (`whoami --json`, `ls --json`); the reservation
 * lives under os.tmpdir() and is removed after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Exec, type ReserveDeps } from '../../../../scripts/agent-health/claude3-reserve-main';
import { main as dispatchMain } from '../../../../scripts/agent-health/dispatch-main';
import { acquireReservation, readReservation, type ReservationGeneration } from '@/lib/agent-health/claude3-reservation';

let root: string;
let out: string[];
let err: string[];
let calls: Array<[string, string[]]>;
let lsState: Record<string, unknown>;
let whoami: { status: number | null; stdout: string };

const BUSY = { isRunning: true, isProcessing: true, isWaitingForResponse: false, sessionStatusReason: 'thinking_indicator' };
const WHO_CLAUDE3 = { status: 0, stdout: JSON.stringify({ worktreeId: 'mycodebranchdesk', instanceId: 'claude-3', cliToolId: 'claude' }) };
const NOW = Date.parse('2026-11-10T00:00:00Z');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-claude3-self-'));
  out = [];
  err = [];
  calls = [];
  lsState = BUSY;
  whoami = WHO_CLAUDE3;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const resDir = () => path.join(root, 'reservation');
const exec: Exec = (command, args) => {
  calls.push([command, [...args]]);
  if (command === 'commandmate' && args[0] === 'whoami') return whoami;
  if (command === 'commandmate' && args[0] === 'ls') {
    return {
      status: 0,
      stdout: JSON.stringify([
        { id: 'mycodebranchdesk', agentInstances: [{ id: 'claude-3', cliTool: 'claude' }], sessionStatusByInstance: { 'claude-3': lsState } },
      ]),
    };
  }
  if (command === 'commandmate' && args[0] === 'send') return { status: 0, stdout: '' };
  return { status: null, stdout: '' };
};

function run(argv: string[], extra: Partial<ReserveDeps> = {}): Promise<number> {
  out = [];
  err = [];
  return main(argv, {
    exec,
    now: () => new Date(NOW),
    pid: 500,
    isAlive: () => false,
    reservationDir: resDir(),
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...extra,
  });
}
const current = (): ReservationGeneration => {
  const read = readReservation(resDir());
  if (!read.ok) throw new Error(read.message);
  return read.current;
};
const sends = () => calls.filter(([c, a]) => c === 'commandmate' && a[0] === 'send');

describe('reserve --self (#4288)', () => {
  it('claude-3 (busy) reserves itself: holder leader, token on stdout, no state check', async () => {
    expect(await run(['reserve', '--self', '--label', 'x'])).toBe(0);
    expect(out[0]).toMatch(/^leader-/);
    expect(current()).toMatchObject({ state: 'held', holder: 'leader', token: out[0], label: 'x' });
    expect(calls.some(([, a]) => a[0] === 'ls')).toBe(false);
  });

  it('then dispatch sends nothing and records skipped-busy naming the leader', async () => {
    expect(await run(['reserve', '--self', '--label', 'x'])).toBe(0);
    const dcalls: Array<[string, string[]]> = [];
    const lines: string[] = [];
    const dexec: Exec = (command, args) => {
      dcalls.push([command, [...args]]);
      if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return {
          status: 0,
          stdout: JSON.stringify([{ number: 1, title: 't', author: { login: 'Kewton' }, labels: [{ name: 'agent-health' }], createdAt: 'a' }]),
        };
      }
      if (command === 'gh' && args[0] === 'label') {
        return { status: 0, stdout: JSON.stringify(['agent-health', 'metrics', 'security', 'catalog-drift', 'auto-dispatched', 'bug'].map((name) => ({ name }))) };
      }
      return exec(command, args);
    };
    const code = await dispatchMain(['--state-dir', path.join(root, 'state')], {
      exec: dexec,
      sleep: async () => {},
      now: () => new Date('2026-11-10T00:30:00Z'),
      env: {} as NodeJS.ProcessEnv,
      homedir: path.join(root, 'home'),
      repoRoot: path.join(root, 'repo'),
      reservationDir: resDir(),
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(sends()).toEqual([]);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'state', 'dispatch', '2026-11-10.json'), 'utf8'));
    expect(record).toMatchObject({ status: 'skipped-busy', reason: expect.stringContaining('開発リーダー自身が予約中') });
  });

  it('without --self, reserve still exits 4 while claude-3 is busy (and never calls whoami)', async () => {
    expect(await run(['reserve', '--label', 'x'])).toBe(4);
    expect(fs.existsSync(resDir())).toBe(false);
    expect(calls.some(([, a]) => a[0] === 'whoami')).toBe(false);
  });

  it.each([
    ['PM (claude)', { status: 0, stdout: JSON.stringify({ worktreeId: 'mycodebranchdesk', instanceId: 'claude', cliToolId: 'claude' }) }],
    ['claude-3 slot running another tool (codex)', { status: 0, stdout: JSON.stringify({ worktreeId: 'mycodebranchdesk', instanceId: 'claude-3', cliToolId: 'codex' }) }],
    ['claude-3 without a cliToolId', { status: 0, stdout: JSON.stringify({ worktreeId: 'mycodebranchdesk', instanceId: 'claude-3' }) }],
    ['another worktree', { status: 0, stdout: JSON.stringify({ worktreeId: 'other', instanceId: 'claude-3', cliToolId: 'claude' }) }],
    ['outside a session (exit 3)', { status: 3, stdout: '' }],
    ['unreadable JSON', { status: 0, stdout: 'not json' }],
  ])('exits 2 and creates nothing when the caller is %s', async (_name, who) => {
    whoami = who;
    expect(await run(['reserve', '--self', '--label', 'x'])).toBe(2);
    expect(fs.existsSync(resDir())).toBe(false);
  });

  it('exits 3 when a dispatch run already holds it', async () => {
    const held = acquireReservation({ dir: resDir(), now: () => new Date(NOW), pid: 7, isAlive: () => true }, { holder: 'dispatch', label: 'd', date: '2026-11-10' });
    expect(held.ok).toBe(true);
    expect(await run(['reserve', '--self', '--label', 'x'])).toBe(3);
    expect(current()).toMatchObject({ holder: 'dispatch' });
  });

  it('exits 3 and keeps the generation when PM already holds it', async () => {
    const held = acquireReservation({ dir: resDir(), now: () => new Date(NOW), pid: 7, isAlive: () => true }, { holder: 'pm', label: 'p' });
    expect(held.ok).toBe(true);
    const before = current();
    expect(await run(['reserve', '--self', '--label', 'x'])).toBe(3);
    expect(current()).toMatchObject({ holder: 'pm', token: before.token, generation: before.generation });
  });

  it('send --token <leader token> exits 3 and sends nothing (claude-3 does not send to itself)', async () => {
    expect(await run(['reserve', '--self', '--label', 'x'])).toBe(0);
    const token = out[0];
    expect(await run(['send', '--token', token, 'hi'])).toBe(3);
    expect(sends()).toEqual([]);
  });

  it('release --token works for the leader token', async () => {
    expect(await run(['reserve', '--self', '--label', 'x'])).toBe(0);
    expect(await run(['release', '--token', out[0]])).toBe(0);
    expect(current().state).toBe('released');
  });
});
