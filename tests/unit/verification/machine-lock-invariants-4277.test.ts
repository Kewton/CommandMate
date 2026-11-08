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
 * The standalone runner's bash (`verify-run.sh`, the `.claude` and `.agents` copies are byte-identical)
 * follows the same convention since the 5-2b review of #4277 (P1) and has its row too: its lock
 * functions are cut out of the script and run in a bash of their own (BASH_DRIVER below).
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
const VERIFY_RUN = path.join(REPO, '.claude/skills/cmate-verify/scripts/verify-run.sh');

/**
 * verify-run.sh's lock section, alone: `bash -c BASH_DRIVER bash <verify-run.sh> <root> <name> <budget-s> <events> [self-pid]`.
 * Appends {event, heldBy} lines to <events> (acquired / not-acquired / released), holds the lock
 * until `<events>.release` exists, then releases it. `self-pid` is the pid whose tickets the driver
 * treats as its own (LOCK_SELF_PID): the test process writes tickets on the driver's behalf.
 */
const BASH_DRIVER = `
script=$1 root=$2 name=$3 budget=$4 events=$5 selfpid=$6
export CM_VERIFY_LOCK_ROOT="$root"
eval "$(sed -n '/^# --- machine-wide gate lock/,/^# --- gate execution/p' "$script")"
if [ -n "$selfpid" ]; then LOCK_SELF_PID=$selfpid; fi
emit() { printf '{"event":"%s","pid":%s,"heldBy":"%s"}\\n' "$1" "$$" "$LOCK_HELD_BY" >> "$events"; }
if lock_acquire "$name" "$budget"; then
  emit acquired
  while [ ! -e "$events.release" ]; do sleep 0.02; done
  lock_release "$LOCK_PATH" "$LOCK_TOKEN"
  emit released
else
  emit not-acquired
fi
`;

/** Read a driver's events file. */
function bashEvents(events: string): { event: string; pid: number; heldBy: string; t?: number }[] {
  return fs.existsSync(events)
    ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

/** Block (synchronously) until `predicate` holds or `timeoutMs` passes. */
function waitSync(predicate: () => boolean, timeoutMs = 10000): boolean {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return true;
}

let bashSerial = 0;

/**
 * Start verify-run.sh's lock_acquire in its own bash. The returned `release` asks the holder to
 * release and waits for it, synchronously (an Outcome's release is synchronous).
 */
function startBash(name: string, budgetSec: number, { script = VERIFY_RUN, selfPid }: { script?: string; selfPid?: number } = {}) {
  const events = path.join(root, `bash-events-${++bashSerial}.jsonl`);
  const child = spawn('bash', ['-c', BASH_DRIVER, 'bash', script, root, name, String(budgetSec), events, selfPid ? String(selfPid) : ''], {
    stdio: 'ignore',
  });
  children.push(child);
  const first = () => bashEvents(events).find((e) => e.event === 'acquired' || e.event === 'not-acquired') ?? null;
  const release = () => {
    if (first()?.event !== 'acquired') return;
    fs.writeFileSync(`${events}.release`, '');
    waitSync(() => bashEvents(events).some((e) => e.event === 'released'));
  };
  return { child, events, first, release };
}

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
  /** The pid the owner record names while this outcome holds. */
  pid: number;
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
      return { acquired: r.acquired, heldBy: r.acquired ? null : r.heldBy, at: Date.now(), pid: process.pid, release: () => (r.acquired ? r.handle.release() : undefined) };
    },
  },
  {
    id: 'sync',
    path: 'scripts/orchestrate/machine-lock-sync.mjs acquireMachineLockSync (merge-pr merge lock)',
    hooks: true,
    take: async (name, timeoutMs, pollMs, hooks) => {
      const r = lockSync.acquireMachineLockSync(name, { root, timeoutMs, pollMs, ...(hooks ? { hooks } : {}) });
      return { acquired: r.acquired, heldBy: r.heldBy, at: Date.now(), pid: process.pid, release: r.release };
    },
  },
  {
    id: 'precheck',
    path: 'scripts/orchestrate/precheck.mjs acquireMachineLockSync (cpu.heavy of a wide step)',
    hooks: false,
    take: async (name, timeoutMs, pollMs) => {
      const r = precheckAcquire(name, { root, timeoutMs, pollMs });
      return { acquired: r.acquired, heldBy: r.heldBy, at: Date.now(), pid: process.pid, release: r.release };
    },
  },
  {
    id: 'bash',
    path: 'verify-run.sh lock_acquire / lock_release (standalone runner; .claude and .agents are byte-identical)',
    hooks: false,
    // The budget is whole seconds (the gate's timeoutSec) and the poll is fixed at 250 ms.
    take: async (name, timeoutMs) => {
      const b = startBash(name, Math.ceil(timeoutMs / 1000), { selfPid: process.pid });
      await waitFor(() => b.first() !== null, timeoutMs + 10000);
      const e = b.first()!;
      return { acquired: e.event === 'acquired', heldBy: e.event === 'acquired' ? null : e.heldBy || null, at: Date.now(), pid: e.pid, release: b.release };
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
    expect(readJson(path.join(machineLockPath(name, root), 'owner')).pid).toBe(r.pid);
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

describe('the paths that do not follow the tickets (an old runner: a server not rebuilt, the skills package before its port)', () => {
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

/**
 * The 5-2b review of #4277, P1: a TS (or synchronous JS) waiter recovering a dead holder's lock moves
 * it aside and then reads it. With verify-run.sh still taking the lock by a bare mkdir, the window
 * let two runs hold at once — bash B broke the dead lock and took it just before the move (so the
 * move took B's lock away), and bash C took the empty path just after it. Both third parties are put
 * into exactly those two windows through the recovery seam.
 */
const RECOVERERS: { id: string; recover: (name: string, onRecover: (stage: 'before-move' | 'moved') => void) => Promise<{ acquired: boolean; token: string | null; release: () => void }> }[] = [
  {
    id: 'ts',
    recover: async (name, onRecover) => {
      const r = await acquireMachineLock(name, { root, timeoutMs: 3000, pollIntervalMs: 20, __testHooks: { onRecover } });
      const owner = r.acquired ? readJson(path.join(r.handle.path, 'owner')) : null;
      return { acquired: r.acquired, token: owner?.token ?? null, release: () => (r.acquired ? r.handle.release() : undefined) };
    },
  },
  {
    id: 'sync',
    recover: async (name, onRecover) => {
      const r = lockSync.acquireMachineLockSync(name, { root, timeoutMs: 3000, pollMs: 20, hooks: { onRecover } });
      const owner = r.acquired ? readJson(path.join(r.path, 'owner')) : null;
      return { acquired: r.acquired, token: owner?.token ?? null, release: r.release };
    },
  },
];

describe.each(RECOVERERS)('$id and verify-run.sh together: the recovery window (P1)', (rec) => {
  /** Run one bash third party inside the recovery window and wait (synchronously) for its first answer. */
  const thirdParty = (name: string, script: string) => {
    const b = startBash(name, 0, { script });
    waitSync(() => b.first() !== null);
    return b;
  };

  async function scenario(script: string) {
    const name = `inv-window-${rec.id}`;
    writeLock(name, { pid: deadPid(), host: os.hostname(), token: 'dead-holder', acquiredAt: 0 });
    const parties: ReturnType<typeof startBash>[] = [];
    const recovered = await rec.recover(name, (stage) => {
      // B before the move, C right after it (while the lock path is empty).
      if (parties.length < 2) parties.push(thirdParty(name, script));
      void stage;
    });
    const [b, c] = parties.map((p) => p.first());
    const holders = [recovered.acquired ? 'recoverer' : null, b?.event === 'acquired' ? 'bash-b' : null, c?.event === 'acquired' ? 'bash-c' : null].filter(Boolean);
    const lockOwner = fs.existsSync(path.join(machineLockPath(name, root), 'owner')) ? readJson(path.join(machineLockPath(name, root), 'owner')).token : null;
    const restoreFailed = fs.readdirSync(root).filter((entry) => entry.includes('.gone-'));
    for (const p of parties) p.release();
    recovered.release();
    return { holders, recovered, lockOwner, restoreFailed, parties };
  }

  it('positive: a bash claim put before and after the move never makes two holders — the recoverer, first in line, gets it', async () => {
    const { holders, recovered, lockOwner, restoreFailed, parties } = await scenario(VERIFY_RUN);
    expect(parties).toHaveLength(2);
    expect(holders).toEqual(['recoverer']);
    expect(lockOwner).toBe(recovered.token);
    expect(restoreFailed).toEqual([]);
    // The bash parties were kept out by the queue, not by luck: they name the ticket ahead of them.
    for (const p of parties) expect(p.first()?.heldBy ?? '').toMatch(/queue ticket|pid /);
  }, 20000);

  it('negative: a bare mkdir holder without a ticket (an old runner) still keeps bash and the recoverer out, and is not broken while alive', async () => {
    const name = `inv-bare-${rec.id}`;
    const lockPath = writeLock(name, { pid: process.pid, host: os.hostname(), token: 'bare-holder', acquiredAt: Date.now() });
    const b = startBash(name, 0);
    await waitFor(() => b.first() !== null);
    expect(b.first()?.event).toBe('not-acquired');
    expect(b.first()?.heldBy).toContain(`pid ${process.pid}`);
    expect(readJson(path.join(lockPath, 'owner')).token).toBe('bare-holder');
    // And while bash holds, a bare mkdir fails with EEXIST.
    fs.rmSync(lockPath, { recursive: true });
    const held = startBash(name, 1);
    await waitFor(() => held.first() !== null);
    expect(held.first()?.event).toBe('acquired');
    expect(() => fs.mkdirSync(lockPath)).toThrow(/EEXIST/);
    held.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 20000);
});

describe('verify-run.sh: a holder whose pid is gone but whose process group is alive keeps its lock', () => {
  it('reads pgid like the other implementations (real processes)', async () => {
    const name = 'inv-bash-group';
    const group = spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    children.push(group);
    const lockPath = writeLock(name, { pid: deadPid(), pgid: group.pid, host: os.hostname(), token: 'grouped', acquiredAt: 0 });
    const b = startBash(name, 0);
    await waitFor(() => b.first() !== null);
    expect(b.first()?.event).toBe('not-acquired');
    expect(readJson(path.join(lockPath, 'owner')).token).toBe('grouped');
    // The group empty too: recovered.
    process.kill(-(group.pid as number), 'SIGKILL');
    await waitFor(() => spawnSync('sh', ['-c', `kill -0 -- -${group.pid} 2>/dev/null`]).status !== 0);
    const again = startBash(name, 1);
    await waitFor(() => again.first() !== null);
    expect(again.first()?.event).toBe('acquired');
    again.release();
  }, 20000);
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
