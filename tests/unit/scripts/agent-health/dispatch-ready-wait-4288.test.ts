/**
 * Issue #4288 (3): the wait for claude-3 to come back to its prompt after `/clear`
 * is bounded by real time from the `/clear` (not by the sum of the sleeps), and one
 * `ls` may not outlive the deadline. Virtual clock; nothing is sent; everything
 * lives under os.tmpdir() and is removed after each test.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, READY_POLL_MS, READY_TIMEOUT_MS, type Exec } from '../../../../scripts/agent-health/dispatch-main';

let root: string;
let lines: string[];
let clock: number;
let clearAt: number | null;
let lsCalls: Array<{ at: number; timeoutMs: number | undefined }>;
let sent: string[][];
let sleeps: Array<{ at: number; ms: number }>;

const READY = { isRunning: true, isProcessing: false, isWaitingForResponse: false };
const BUSY = { isRunning: true, isProcessing: true, isWaitingForResponse: false, sessionStatusReason: 'thinking_indicator' };
const START = Date.parse('2026-10-01T00:30:00Z');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dispatch-ready-'));
  lines = [];
  clock = START;
  clearAt = null;
  lsCalls = [];
  sent = [];
  sleeps = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const lsJson = (status: Record<string, unknown>) =>
  JSON.stringify([
    {
      id: 'mycodebranchdesk',
      agentInstances: [{ id: 'claude-3', cliTool: 'claude' }],
      sessionStatusByInstance: { 'claude-3': status },
    },
  ]);

/** ls #1 (the state check before /clear) is ready; after that `after(n)` decides; each ls takes `lsMs` of virtual time (capped by its timeout). */
function world(opts: { lsMs: number; after: (n: number) => Record<string, unknown> }): Exec {
  let lsCount = 0;
  return (command, args, options) => {
    if (command === 'gh' && args[0] === 'issue' && args[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 1, title: 't', author: { login: 'Kewton' }, labels: [{ name: 'agent-health' }], createdAt: 'a' }]),
      };
    }
    if (command === 'gh' && args[0] === 'label') {
      return { status: 0, stdout: JSON.stringify(['agent-health', 'metrics', 'security', 'catalog-drift', 'auto-dispatched', 'bug'].map((name) => ({ name }))) };
    }
    if (command === 'gh') return { status: 0, stdout: '' };
    if (command === 'commandmate' && args[0] === 'ls') {
      lsCount++;
      if (lsCount === 1) return { status: 0, stdout: lsJson(READY) };
      lsCalls.push({ at: clock, timeoutMs: options?.timeoutMs });
      clock += Math.min(opts.lsMs, options?.timeoutMs ?? Number.POSITIVE_INFINITY);
      return { status: 0, stdout: lsJson(opts.after(lsCount)) };
    }
    if (command === 'commandmate' && args[0] === 'send') {
      sent.push([...args]);
      if (args[2] === '/clear') clearAt = clock;
      return { status: 0, stdout: '' };
    }
    return { status: null, stdout: '' };
  };
}

interface RunOptions {
  virtual?: boolean;
  /** Replaces the default virtual sleep (which adds `ms` to the clock). */
  sleep?: (ms: number) => Promise<void>;
  /** The record's wall clock; default is the virtual clock. The deadline must not follow it. */
  wall?: () => number;
  /** Inject a monotonic clock (the virtual clock). Default: only `now` is injected. */
  monotonic?: boolean;
}

async function run(exec: Exec, opts: RunOptions = {}): Promise<number> {
  const virtual = opts.virtual ?? true;
  return main(['--state-dir', path.join(root, 'state')], {
    exec,
    sleep:
      opts.sleep ??
      (async (ms) => {
        sleeps.push({ at: clock, ms });
        if (virtual) clock += ms;
      }),
    now: () => new Date(opts.wall ? opts.wall() : clock),
    ...(opts.monotonic ? { monotonic: () => clock } : {}),
    env: {} as NodeJS.ProcessEnv,
    homedir: path.join(root, 'home'),
    repoRoot: path.join(root, 'repo'),
    reservationDir: path.join(root, 'reservation'),
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
  });
}

describe('dispatch: the ready wait after /clear is bounded by real time (#4288)', () => {
  it('stops within 90s (+ one ls timeout) of /clear when each ls takes 10s and claude-3 stays busy', async () => {
    const code = await run(world({ lsMs: 10_000, after: () => BUSY }));
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('/clear の後 90 秒で Claude 3 が入力待ちに戻らなかった');
    expect(clearAt).not.toBeNull();
    // the last ls may start before the deadline and runs for at most its (clamped, >= 1s) timeout
    expect(clock - (clearAt as number)).toBeLessThanOrEqual(READY_TIMEOUT_MS + 1_000);
    expect(sent.map((a) => a[2])).toEqual(['/clear']);
  });

  it('passes every ls a timeout no larger than the time left to the deadline (floor 1s)', async () => {
    await run(world({ lsMs: 10_000, after: () => BUSY }));
    expect(lsCalls.length).toBeGreaterThan(1);
    for (const call of lsCalls) {
      expect(call.timeoutMs).toBeDefined();
      const left = (clearAt as number) + READY_TIMEOUT_MS - call.at;
      expect(call.timeoutMs as number).toBeLessThanOrEqual(Math.max(1_000, left));
    }
  });

  it('with a frozen clock still stops by the count cap, with the same exit and message', async () => {
    const code = await run(world({ lsMs: 0, after: () => BUSY }), { virtual: false });
    expect(code).toBe(2);
    // READY_TIMEOUT_MS / READY_POLL_MS polls, not one more (pins `<` against `<=`)
    expect(lsCalls.length).toBe(READY_TIMEOUT_MS / READY_POLL_MS);
    expect(lines.join('\n')).toContain('/clear の後 90 秒で Claude 3 が入力待ちに戻らなかった');
  });

  it('sends the request after /clear when claude-3 is ready on the second ls', async () => {
    const code = await run(world({ lsMs: 0, after: (n) => (n >= 3 ? READY : BUSY) }));
    expect(code).toBe(0);
    expect(sent.map((a) => a[2])).toEqual(['/clear', expect.stringContaining('dispatch-terms')]);
    expect(lsCalls.length).toBe(2);
  });

  it('never sleeps for zero or a negative time, and never past the deadline (ls 10s and ls 3s)', async () => {
    for (const lsMs of [10_000, 3_000, 7_000]) {
      sleeps = [];
      lsCalls = [];
      clock = START;
      await run(world({ lsMs, after: () => BUSY }));
      expect(sleeps.length).toBeGreaterThan(1);
      for (const s of sleeps) {
        expect(s.ms).toBeGreaterThan(0);
        expect(s.ms).toBeLessThanOrEqual(5_000);
        expect(s.at + s.ms).toBeLessThanOrEqual((clearAt as number) + READY_TIMEOUT_MS);
      }
      expect(clock - (clearAt as number)).toBeLessThanOrEqual(READY_TIMEOUT_MS + 1_000);
    }
  });

  it('with a monotonic clock, a wall clock that jumps back an hour does not stretch the wait (positive control)', async () => {
    const code = await run(world({ lsMs: 300_000, after: () => BUSY }), {
      monotonic: true,
      wall: () => (clearAt === null ? clock : clock - 3_600_000),
    });
    expect(code).toBe(2);
    expect(lsCalls.length).toBeGreaterThan(0);
    for (const call of lsCalls) {
      expect(call.timeoutMs as number).toBeLessThanOrEqual(READY_TIMEOUT_MS);
    }
    expect(clock - (clearAt as number)).toBeLessThanOrEqual(READY_TIMEOUT_MS + 1_000);
    expect(sent.map((a) => a[2])).toEqual(['/clear']);
  });

  it('a wall clock that jumps forward does not cut the wait short either (negative control)', async () => {
    const code = await run(world({ lsMs: 0, after: (n) => (n >= 4 ? READY : BUSY) }), {
      monotonic: true,
      wall: () => (clearAt === null ? clock : clock + 3_600_000),
    });
    expect(code).toBe(0);
    expect(sent.map((a) => a[2])).toEqual(['/clear', expect.stringContaining('dispatch-terms')]);
  });

  it('a sleep that returns after the deadline stops the wait: no ls, no request even though claude-3 is ready (positive control)', async () => {
    let late = false;
    const code = await run(world({ lsMs: 0, after: () => READY }), {
      monotonic: true,
      sleep: async (ms) => {
        // the first sleep after /clear returns 200 s late (a suspended process)
        clock += clearAt !== null && !late ? ((late = true), 200_000) : ms;
      },
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('/clear の後 90 秒で Claude 3 が入力待ちに戻らなかった');
    expect(lsCalls).toEqual([]);
    expect(sent.map((a) => a[2])).toEqual(['/clear']);
  });
});
