/**
 * Issue #4243: scripts/agent-health/claude3-reserve-main.ts (PM's side of the
 * Claude 3 reservation). commandmate goes through an injected `exec` stub
 * (nothing is really sent); the reservation and the repository live under
 * os.tmpdir() and are removed after each test. Pairs with design §6.2, §6.3, §6.7.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Exec, type ReserveDeps } from '../../../../scripts/agent-health/claude3-reserve-main';
import {
  acquireReservation,
  beginSend,
  endSend,
  readReservation,
  releaseReservation,
  type ReservationGeneration,
} from '@/lib/agent-health/claude3-reservation';

let root: string;
let out: string[];
let err: string[];
let calls: Array<[string, string[]]>;
let clock: number;
let lsState: Record<string, unknown> | null;

const READY = { isRunning: true, isProcessing: false, isWaitingForResponse: false };
const BUSY = { isRunning: true, isProcessing: true, isWaitingForResponse: false, sessionStatusReason: 'thinking_indicator' };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-claude3-reserve-'));
  out = [];
  err = [];
  calls = [];
  clock = Date.parse('2026-11-08T00:00:00Z');
  lsState = READY;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const resDir = () => path.join(root, 'reservation');
const exec: Exec = (command, args) => {
  calls.push([command, [...args]]);
  if (command === 'commandmate' && args[0] === 'ls') {
    return {
      status: 0,
      stdout: JSON.stringify([
        {
          id: 'mycodebranchdesk',
          agentInstances: [{ id: 'claude-3', cliTool: 'claude' }],
          sessionStatusByInstance: lsState ? { 'claude-3': lsState } : {},
        },
      ]),
    };
  }
  if (command === 'commandmate' && args[0] === 'send') return { status: 0, stdout: 'sent\n' };
  return { status: null, stdout: '' };
};

function run(argv: string[], extra: Partial<ReserveDeps> = {}): Promise<number> {
  out = [];
  err = [];
  return main(argv, {
    exec,
    now: () => new Date(clock),
    pid: 500,
    isAlive: () => false,
    reservationDir: resDir(),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...extra,
  });
}

const current = (): ReservationGeneration => {
  const read = readReservation(resDir());
  if (!read.ok) throw new Error(read.message);
  return read.current;
};
const sends = () => calls.filter(([c, a]) => c === 'commandmate' && a[0] === 'send').map(([, a]) => a);
const resEnv = () => ({ dir: resDir(), now: () => new Date(clock), pid: 9, isAlive: () => false });

async function reserve(label = '#4243'): Promise<string> {
  expect(await run(['reserve', '--label', label])).toBe(0);
  return out[0];
}

describe('claude3-reserve: PM operations', () => {
  it('reserve prints a token and holds claude-3 for PM (review after 8h)', async () => {
    const token = await reserve();
    expect(token).toMatch(/^pm-/);
    expect(current()).toMatchObject({ state: 'held', holder: 'pm', token, label: '#4243', reviewAfter: '2026-11-08T08:00:00.000Z' });
  });

  it('reserve exits 4 when claude-3 is busy and writes nothing', async () => {
    lsState = BUSY;
    expect(await run(['reserve', '--label', 'x'])).toBe(4);
    expect(fs.existsSync(resDir())).toBe(false);
  });

  // 6.3 negative
  it('send with the right token runs commandmate send once to claude-3', async () => {
    const token = await reserve();
    expect(await run(['send', '--token', token, 'ブリーフ本文'])).toBe(0);
    expect(sends()).toEqual([['send', 'mycodebranchdesk', 'ブリーフ本文', '--instance', 'claude-3']]);
    expect(current().sending).toBeNull();
  });

  it('send records the child pid while it runs', async () => {
    const token = await reserve();
    let during: ReservationGeneration | null = null;
    const code = await run(['send', '--token', token, 'x'], {
      spawnExec: async (_c, _a, onChild) => {
        onChild?.(31337);
        during = current();
        return { status: 0, stdout: '' };
      },
    });
    expect(code).toBe(0);
    expect(during).toMatchObject({ sending: { parentPid: 500, childPid: 31337 } });
  });

  // 6.3 positive
  it('an old token cannot send, renew or release after someone else reserved', async () => {
    const a = await reserve('a');
    expect(await run(['release', '--token', a])).toBe(0);
    const b = await reserve('b');
    calls = [];
    expect(await run(['send', '--token', a, 'x'])).toBe(3);
    expect(await run(['renew', '--token', a])).toBe(3);
    expect(await run(['release', '--token', a])).toBe(3);
    expect(sends()).toEqual([]);
    expect(current().token).toBe(b);
  });

  it('renew moves only reviewAfter; release frees it', async () => {
    const t = await reserve();
    clock += 3_600_000;
    expect(await run(['renew', '--token', t, '--hours', '2'])).toBe(0);
    expect(current()).toMatchObject({ token: t, reviewAfter: '2026-11-08T03:00:00.000Z' });
    expect(await run(['release', '--token', t])).toBe(0);
    expect(current().state).toBe('released');
  });

  it('takeover --reason restart gives a new token; the old one then fails', async () => {
    const a = await reserve();
    expect(await run(['takeover', '--from', a, '--reason', 'restart'])).toBe(0);
    const b = out[0];
    expect(b).not.toBe(a);
    expect(current()).toMatchObject({ token: b, previousToken: a });
    expect(await run(['send', '--token', a, 'x'])).toBe(3);
  });

  it('release --force --from frees the generation a person looked at', async () => {
    const t = await reserve();
    expect(await run(['release', '--force', '--from', t])).toBe(0);
    expect(current()).toMatchObject({ state: 'released', previousToken: t });
  });

  it('status reads only: no generation or tmp file is written, and the directory is printed', async () => {
    expect(await run(['status'])).toBe(0);
    expect(fs.existsSync(resDir())).toBe(false);
    expect(out[0]).toBe(`dir=${resDir()}`);
    await reserve();
    const files = fs.readdirSync(resDir());
    expect(await run(['status', '--json'])).toBe(0);
    expect(JSON.parse(out[0])).toMatchObject({ dir: resDir(), current: { holder: 'pm' } });
    expect(fs.readdirSync(resDir())).toEqual(files);
  });
});

describe('claude3-reserve: the dispatch run’s reservation (R1)', () => {
  const holdDispatch = (): string => {
    const r = acquireReservation(resEnv(), { holder: 'dispatch', label: '#1', date: '2026-11-08' });
    if (!r.ok) throw new Error(r.message);
    return r.generation.token as string;
  };
  const report = () => path.join(root, 'repo', 'workspace', 'agent-health', '2026-11-08', 'release-readiness.html');

  it('positive: while dispatch holds it after the request, PM cannot reserve or send', async () => {
    const d = holdDispatch();
    expect(await run(['reserve', '--label', 'x'])).toBe(3);
    expect(await run(['send', '--token', 'pm-guess', 'x'])).toBe(3);
    expect(sends()).toEqual([]);
    expect(current().token).toBe(d);
  });

  it('negative: after the run’s release --token, PM can reserve', async () => {
    const d = holdDispatch();
    expect(await run(['release', '--token', d])).toBe(0);
    expect(await run(['reserve', '--label', 'x'])).toBe(0);
  });

  it('positive: dispatch-finished without the finished mark is refused (3)', async () => {
    const d = holdDispatch();
    expect(await run(['takeover', '--from', d, '--reason', 'dispatch-finished'])).toBe(3);
    expect(current().holder).toBe('dispatch');
  });

  it('positive (P1-2): a release report updated in the middle of the run is not evidence', async () => {
    const d = holdDispatch();
    fs.mkdirSync(path.dirname(report()), { recursive: true });
    fs.writeFileSync(report(), 'manual, mid-run');
    const later = new Date(clock + 3_600_000);
    fs.utimesSync(report(), later, later);
    expect(await run(['takeover', '--from', d, '--reason', 'dispatch-finished'])).toBe(3);
    expect(current()).toMatchObject({ holder: 'dispatch', token: d });
  });

  it('negative (P1-2): the run left its finished mark but the release failed — PM takes it over', async () => {
    const d = holdDispatch();
    // The run's own send is in progress (parent alive), so finish leaves the mark and the release is refused.
    const live = { ...resEnv(), pid: 77, isAlive: (p: number) => p === 77 };
    expect(beginSend(live, d).ok).toBe(true);
    expect(await run(['finish', '--token', d], { isAlive: (p) => p === 77 })).toBe(3);
    expect(current()).toMatchObject({ holder: 'dispatch', token: d });
    expect(endSend(live, d).ok).toBe(true);
    expect(await run(['takeover', '--from', d, '--reason', 'dispatch-finished'])).toBe(0);
    expect(current()).toMatchObject({ holder: 'pm', previousToken: d });
  });

  it('finish --token leaves the mark and releases; a PM token cannot finish', async () => {
    const d = holdDispatch();
    expect(await run(['finish', '--token', d])).toBe(0);
    expect(current().state).toBe('released');
    const p = await reserve();
    expect(await run(['finish', '--token', p])).toBe(3);
    expect(current()).toMatchObject({ holder: 'pm', token: p });
  });

  it('positive (P2-2): PM’s send with the dispatch token does not send', async () => {
    const d = holdDispatch();
    expect(await run(['send', '--token', d, 'ブリーフ'])).toBe(3);
    expect(sends()).toEqual([]);
    expect(current()).toMatchObject({ holder: 'dispatch', token: d, sending: null });
  });

  it('dispatch-finished exits 4 while claude-3 is still busy', async () => {
    const d = holdDispatch();
    lsState = BUSY;
    expect(await run(['takeover', '--from', d, '--reason', 'dispatch-finished'])).toBe(4);
    expect(releaseReservation(resEnv(), d).ok).toBe(true);
  });
});

describe('claude3-reserve: location and arguments (R6)', () => {
  it('a generation whose target is not claude-3 makes reserve and send exit 2 without sending', async () => {
    fs.mkdirSync(resDir(), { recursive: true });
    fs.writeFileSync(
      path.join(resDir(), 'gen-1.json'),
      JSON.stringify({
        schemaVersion: 1, generation: 1, target: { worktreeId: 'other', instanceId: 'claude-3', cliTool: 'claude' },
        state: 'held', holder: 'pm', token: 't', label: null, date: null, heldSince: null, reviewAfter: null, sending: null, previousToken: null,
      })
    );
    expect(await run(['reserve', '--label', 'x'])).toBe(2);
    expect(await run(['send', '--token', 't', 'x'])).toBe(2);
    expect(sends()).toEqual([]);
  });

  it('a new main() sees the reservation the previous one wrote', async () => {
    const t = await reserve();
    expect(await run(['status', '--json'])).toBe(0);
    expect(JSON.parse(out[0]).current.token).toBe(t);
  });

  it('there is no argument to move the reservation or the destination (exit 2)', async () => {
    expect(await run(['status', '--reservation-dir', path.join(root, 'x')])).toBe(2);
    expect(await run(['reserve', '--label', 'x', '--instance', 'claude'])).toBe(2);
    expect(await run(['send', '--token', 't'])).toBe(2);
    expect(await run(['reserve', '--label', 'x', '--hours', '25'])).toBe(2);
    expect(calls).toEqual([]);
  });

  it('with an injected reservationDir nothing is created under the real home directory', async () => {
    const real = path.join(os.homedir(), '.commandmate', 'agent-health', 'claude3.reservation');
    const existed = fs.existsSync(real);
    await reserve();
    expect(fs.existsSync(real)).toBe(existed);
  });
});
