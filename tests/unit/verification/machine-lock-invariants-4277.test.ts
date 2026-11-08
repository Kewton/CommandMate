/**
 * The invariants of the first-come lock, over every path that reads or writes it (Issue #4277).
 *
 * The table is docs/design/merge-queue-fair-lock-4277.md §8.1. Each implementation of the convention
 * — the product runner's TS (`acquireMachineLock`, gate-runner), the synchronous copy
 * (`machine-lock-sync.mjs`, merge-pr's merge lock) and precheck's heavy step (`acquireMachineLockSync`
 * in precheck.mjs) — is held to the same rows:
 *
 *   (a) a waiter that took its ticket first takes the lock first, against a faster waiter that came later
 *   (b) a live holder's ticket or lock is never removed: an old ticket whose pid is alive, a pid that
 *       only looks reused, a ticket or lock of another host, a holder whose process group is alive
 *   (c) a dead holder's ticket is retired and the queue moves on (ESRCH, pid reuse, deadline + grace)
 *   (d) a waiter never waits for itself (its own ticket, its own released lock)
 *
 * Holders and early waiters are real processes (fixtures/lock-actor-4277.mjs). Every lock root is
 * under os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { acquireMachineLock, machineLockPath } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { acquireMachineLockSync as precheckAcquire } from '../../../scripts/orchestrate/precheck.mjs';

const REPO = path.resolve(__dirname, '../../..');
const SYNC_MODULE = path.join(REPO, 'scripts/orchestrate/machine-lock-sync.mjs');
const ACTOR = path.join(__dirname, 'fixtures/lock-actor-4277.mjs');

let root: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-invariants-4277-'));
});

afterEach(() => {
  for (const child of children.splice(0)) {
    for (const target of [child.pid ? -child.pid : 0, child.pid ?? 0]) {
      try {
        if (target) process.kill(target, 'SIGKILL');
      } catch {
        // gone
      }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Outcome of one acquisition, the same shape for every implementation. */
interface Outcome {
  acquired: boolean;
  heldBy: string | null;
  at: number;
  release: () => void;
}

interface Hooks {
  now?: () => number;
  host?: string;
  pidAlive?: (pid: number) => boolean;
  groupAlive?: (pgid: number) => boolean;
  startOf?: (pid: number) => number | null;
}

/** The implementations of the convention. `hooks` is false where the path takes no test seam (precheck). */
const IMPLEMENTATIONS: { id: string; path: string; hooks: boolean; take: (name: string, timeoutMs: number, pollMs: number, hooks?: Hooks) => Promise<Outcome> }[] = [
  {
    id: 'ts',
    path: 'src/lib/verification/machine-lock.ts acquireMachineLock (gate-runner)',
    hooks: true,
    take: async (name, timeoutMs, pollMs, hooks) => {
      const r = await acquireMachineLock(name, { root, timeoutMs, pollIntervalMs: pollMs, ...(hooks ? { __testHooks: hooks } : {}) });
      return { acquired: r.acquired, heldBy: r.acquired ? null : r.heldBy, at: Date.now(), release: () => (r.acquired ? r.handle.release() : undefined) };
    },
  },
  {
    id: 'sync',
    path: 'scripts/orchestrate/machine-lock-sync.mjs acquireMachineLockSync (merge-pr merge lock)',
    hooks: true,
    take: async (name, timeoutMs, pollMs, hooks) => {
      const r = lockSync.acquireMachineLockSync(name, { root, timeoutMs, pollMs, ...(hooks ? { hooks } : {}) });
      return { acquired: r.acquired, heldBy: r.heldBy, at: Date.now(), release: r.release };
    },
  },
  {
    id: 'precheck',
    path: 'scripts/orchestrate/precheck.mjs acquireMachineLockSync (cpu.heavy of a wide step)',
    hooks: false,
    take: async (name, timeoutMs, pollMs) => {
      const r = precheckAcquire(name, { root, timeoutMs, pollMs });
      return { acquired: r.acquired, heldBy: r.heldBy, at: Date.now(), release: r.release };
    },
  },
];

function startActor(name: string, { pollMs, holdMs, timeoutMs = 20000, mode, detached = false }: { pollMs: number; holdMs: number; timeoutMs?: number; mode?: string; detached?: boolean }) {
  const events = path.join(root, `events-${children.length}.jsonl`);
  const child = spawn(process.execPath, [ACTOR, SYNC_MODULE, root, name, String(pollMs), String(holdMs), String(timeoutMs), events, ...(mode ? [mode] : [])], {
    stdio: 'ignore',
    detached,
  });
  children.push(child);
  const read = (): { event: string; t: number; pid: number; child?: number }[] =>
    fs.existsSync(events)
      ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
  return { child, read, event: (kind: string) => read().find((e) => e.event === kind) ?? null };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const liveTicketOf = (name: string, pid: number) =>
  lockSync.listQueue(lockSync.queueDirOf(root, name)).some((e: { ticket: { pid?: number; done?: boolean } | null }) => e.ticket?.pid === pid && e.ticket.done !== true);

/** A pid that existed and has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

function writeTicket(name: string, n: number, ticket: Record<string, unknown>): string {
  const dir = lockSync.queueDirOf(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, lockSync.ticketName(n));
  fs.writeFileSync(file, JSON.stringify(ticket));
  return file;
}

function writeLock(name: string, owner: Record<string, unknown>): string {
  const lockPath = machineLockPath(name, root);
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify(owner));
  return lockPath;
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A clock that reads `to` now and keeps running, so a waiter's own deadline still comes. */
const clockAt = (to: number) => {
  const offset = to - Date.now();
  return () => Date.now() + offset;
};

describe.each(IMPLEMENTATIONS)('$id: $path', (impl) => {
  const name = `inv-${impl.id}`;

  it('(a) the waiter that took its ticket first takes the lock first, before a faster waiter that came later', async () => {
    const holder = startActor(name, { pollMs: 50, holdMs: 1500 });
    await waitFor(() => holder.event('acquired') !== null);
    // The earlier waiter polls slowly (150 ms): before #4277 the later 5 ms waiter won the race at the release.
    const early = startActor(name, { pollMs: 150, holdMs: 100 });
    await waitFor(() => liveTicketOf(name, early.child.pid as number));

    const late = await impl.take(name, 10000, 5);
    expect(late.acquired).toBe(true);
    late.release();

    const earlyAcquired = early.event('acquired');
    const earlyReleased = early.event('released');
    expect(earlyAcquired, 'the early waiter took the lock').not.toBeNull();
    expect(earlyAcquired!.t).toBeGreaterThanOrEqual(holder.event('released')!.t);
    // Not before the early waiter was done with it.
    expect(late.at).toBeGreaterThanOrEqual(earlyReleased!.t);
  }, 20000);

  it('(b) does not retire an old ticket whose pid is alive and whose deadline is ahead — not by age', async () => {
    const day = 25 * 3600 * 1000;
    const file = writeTicket(name, 1, { pid: process.pid, host: os.hostname(), token: 'old-but-alive', createdAt: Date.now() - day, deadline: Date.now() + 3600 * 1000 });
    const r = await impl.take(name, 60, 5);
    expect(r.acquired).toBe(false);
    expect(r.heldBy).toContain('queue ticket');
    expect(readJson(file).done).toBeUndefined();
    // The lock itself was free all along: the ticket order, not the mkdir, kept the waiter out.
    expect(fs.existsSync(machineLockPath(name, root))).toBe(false);
  });

  it('(b) does not retire another host\'s ticket within its deadline + 600 s', async () => {
    const file = writeTicket(name, 1, { pid: 999999, host: 'another-host', token: 'remote', createdAt: Date.now() - 1000, deadline: Date.now() - 1000 });
    const r = await impl.take(name, 60, 5);
    expect(r.acquired).toBe(false);
    expect(readJson(file).done).toBeUndefined();
  });

  it('(b) does not break a lock whose holder is alive, nor one held on another host', async () => {
    const lockPath = writeLock(name, { pid: process.pid, host: os.hostname(), token: 'live', acquiredAt: 0 });
    expect((await impl.take(name, 60, 5)).acquired).toBe(false);
    expect(readJson(path.join(lockPath, 'owner')).token).toBe('live');
    fs.rmSync(lockPath, { recursive: true });

    writeLock(name, { pid: deadPid(), host: 'another-host', token: 'remote', acquiredAt: 0 });
    const r = await impl.take(name, 60, 5);
    expect(r.acquired).toBe(false);
    expect(r.heldBy).toContain('another-host');
  });

  it('(c) retires a ticket whose pid is gone and moves the queue on', async () => {
    const file = writeTicket(name, 1, { pid: deadPid(), host: os.hostname(), token: 'dead', createdAt: Date.now(), deadline: Date.now() + 3600 * 1000 });
    const r = await impl.take(name, 1000, 5);
    expect(r.acquired).toBe(true);
    r.release();
    // Retired (done) and then collected, or kept as the largest done ticket.
    if (fs.existsSync(file)) expect(readJson(file).done).toBe(true);
  });

  it('(c) recovers a lock whose recorded holder on this host is gone', async () => {
    writeLock(name, { pid: deadPid(), host: os.hostname(), token: 'stale', acquiredAt: 0 });
    const r = await impl.take(name, 1000, 5);
    expect(r.acquired).toBe(true);
    expect(readJson(path.join(machineLockPath(name, root), 'owner')).pid).toBe(process.pid);
    r.release();
    expect(fs.readdirSync(root).filter((entry) => entry.includes('.gone-'))).toEqual([]);
  });

  it('(d) does not wait for itself: its own ticket and its own released lock never block it', async () => {
    const first = await impl.take(name, 0, 5);
    expect(first.acquired).toBe(true);
    first.release();
    const second = await impl.take(name, 0, 5);
    expect(second.acquired).toBe(true);
    second.release();
    // What a free lock leaves: the largest ticket, used, and no lock.
    const queue = lockSync.listQueue(lockSync.queueDirOf(root, name));
    expect(queue).toHaveLength(1);
    expect(queue[0].ticket.done).toBe(true);
    expect(fs.existsSync(machineLockPath(name, root))).toBe(false);
  });

  describe.runIf(impl.hooks)('with the probes replaced', () => {
    const live = () => true;

    it('(b) a live pid that started before its ticket is not taken for reused, nor one ps cannot read', async () => {
      const createdAt = Date.now() - 60000;
      const file = writeTicket(name, 1, { pid: 424242, host: os.hostname(), token: 't', createdAt, deadline: Date.now() + 3600 * 1000 });
      expect((await impl.take(name, 40, 5, { pidAlive: live, startOf: () => createdAt - 5000 })).acquired).toBe(false);
      expect((await impl.take(name, 40, 5, { pidAlive: live, startOf: () => null })).acquired).toBe(false);
      expect(readJson(file).done).toBeUndefined();
    });

    it('(b) a holder whose pid is gone but whose process group is alive keeps its lock', async () => {
      const lockPath = writeLock(name, { pid: 424243, pgid: 424243, host: os.hostname(), token: 'grouped', acquiredAt: 0 });
      const r = await impl.take(name, 40, 5, { pidAlive: () => false, groupAlive: () => true });
      expect(r.acquired).toBe(false);
      expect(readJson(path.join(lockPath, 'owner')).token).toBe('grouped');
      // The group empty too: recovered.
      expect((await impl.take(name, 1000, 5, { pidAlive: () => false, groupAlive: () => false })).acquired).toBe(true);
    });

    it('(c) retires a ticket whose live pid was reused (the process started after the ticket)', async () => {
      const createdAt = Date.now() - 60000;
      const file = writeTicket(name, 1, { pid: 424244, host: os.hostname(), token: 'reused', createdAt, deadline: Date.now() + 3600 * 1000 });
      const r = await impl.take(name, 1000, 5, { pidAlive: (pid) => pid !== 0, startOf: () => createdAt + 30000 });
      expect(r.acquired).toBe(true);
      r.release();
      if (fs.existsSync(file)) expect(readJson(file).done).toBe(true);
    });

    it('(c) retires a ticket past its deadline + grace: 60 s on this host, 600 s from another', async () => {
      const deadline = Date.now() - 1000;
      const local = writeTicket(name, 1, { pid: process.pid, host: os.hostname(), token: 'late', createdAt: deadline - 1000, deadline });
      // 59 s after the deadline: kept. 61 s: retired.
      expect((await impl.take(name, 30, 5, { now: clockAt(deadline + 59000) })).acquired).toBe(false);
      expect(readJson(local).done).toBeUndefined();
      const ok = await impl.take(name, 30, 5, { now: clockAt(deadline + 61000) });
      expect(ok.acquired).toBe(true);
      ok.release();

      const remote = writeTicket(name, 100, { pid: 1, host: 'another-host', token: 'remote-late', createdAt: deadline - 1000, deadline });
      expect((await impl.take(name, 30, 5, { now: clockAt(deadline + 599000) })).acquired).toBe(false);
      expect(readJson(remote).done).toBeUndefined();
      const ok2 = await impl.take(name, 30, 5, { now: clockAt(deadline + 601000) });
      expect(ok2.acquired).toBe(true);
      ok2.release();
    });
  });
});

describe('the paths that do not follow the tickets yet (verify-run.sh, an old runner)', () => {
  it('a bare mkdir taker (the convention before #4277) and a ticket holder still never hold the lock together', async () => {
    const name = 'inv-mixed';
    const lockPath = machineLockPath(name, root);
    // The old runner's claim: mkdir, then owner. While it holds, the new waiter waits.
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'old-runner', acquiredAt: Date.now() }));
    expect((await acquireMachineLock(name, { root, timeoutMs: 40, pollIntervalMs: 5 })).acquired).toBe(false);
    expect(lockSync.acquireMachineLockSync(name, { root, timeoutMs: 0 }).acquired).toBe(false);
    // And while the new one holds, the old claim fails with EEXIST.
    fs.rmSync(lockPath, { recursive: true });
    const held = await acquireMachineLock(name, { root, timeoutMs: 0 });
    expect(held.acquired).toBe(true);
    expect(() => fs.mkdirSync(lockPath)).toThrow(/EEXIST/);
    if (held.acquired) held.handle.release();
  });
});

describe('(d) the wait of 2026-11-08: pgrep -f finds the waiter itself', () => {
  const pgrep = spawnSync('sh', ['-c', 'command -v pgrep'], { encoding: 'utf8' });

  it.runIf(pgrep.status === 0)('negative control: a process-list wait sees "busy" with nothing running, the lock sees it free', () => {
    const marker = `merge-pr-selfmatch-${process.pid}-${Date.now()}`;
    // The waiter's own command line holds the pattern. pgrep leaves out itself (and, on macOS, its
    // ancestors), but the waiter's own forked subshell — a background job of the wait — still matches.
    const waiter = spawnSync('sh', ['-c', `( sleep 1; : ) & pgrep -f "${marker}" >/dev/null && echo busy || echo free; kill $! 2>/dev/null; wait`], {
      encoding: 'utf8',
    });
    expect(waiter.stdout.trim()).toBe('busy');
    // The lock is asked who holds it, not who mentions it: nobody does, and it is taken at once.
    const lock = lockSync.acquireMachineLockSync(`merge.${marker}`, { root, timeoutMs: 0 });
    expect(lock.acquired).toBe(true);
    expect(lock.waitedMs).toBeLessThan(1000);
    lock.release();
  });
});
