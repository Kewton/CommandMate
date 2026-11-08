/**
 * The ticket rules behind the first-come lock (Issue #4277, design §2 and the two Codex pre-reviews).
 *
 *   R3  a ticket is never numbered twice: a ticket published late is withdrawn; no path reaches the
 *       mkdir without a ticket; an error other than EEXIST is thrown like the claim's own
 *   S1  (review 2, finding 1) a release never moves a lock that is not its own — a second release
 *       of an old handle leaves the next holder's lock in place, and nobody slips in after it
 *   R1  only the head of the queue recovers a dead holder's lock, and a moved lock whose record is not
 *       the dead one is put back; an old-version cleaner (read, pause, rm -rf) still has its window
 *   cross-implementation: the TS waiter and the synchronous copy keep each other's ticket order
 *
 * Every root is under os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireMachineLock, machineLockPath, machineLockQueuePath, machineLockTicketName, parseEtime } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-fifo-4277-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const ownerOf = (name: string) => readJson(path.join(machineLockPath(name, root), 'owner'));
const ticketFile = (name: string, n: number) => path.join(machineLockQueuePath(name, root), machineLockTicketName(n));

describe('R3: a ticket is never numbered twice', () => {
  it('positive control: a waiter that read an empty queue and published late is withdrawn — the earlier waiter goes first', () => {
    const name = 'late';
    let paused = true;
    const late = lockSync.acquireMachineLockSync(name, {
      root,
      timeoutMs: 80,
      pollMs: 5,
      hooks: {
        beforeLink: (n: number) => {
          if (!paused) return;
          paused = false;
          expect(n).toBe(1);
          // While B is stopped before its link: C takes ticket 1 and the lock, A takes ticket 2 and
          // waits, C releases, and a later acquirer collects ticket 1 (it is below the largest).
          const c = lockSync.acquireMachineLockSync(name, { root, timeoutMs: 0 });
          expect(c.acquired).toBe(true);
          fs.writeFileSync(ticketFile(name, 2), JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'A', createdAt: Date.now(), deadline: Date.now() + 60000 }));
          c.release();
          fs.rmSync(ticketFile(name, 1));
        },
      },
    });
    // B's link of "1" succeeded, saw 2 above it, withdrew and queued behind A: the free lock stays A's turn.
    expect(late.acquired).toBe(false);
    expect(late.heldBy).toContain(machineLockTicketName(2));
    expect(fs.existsSync(machineLockPath(name, root))).toBe(false);
    expect(readJson(ticketFile(name, 1)).done).toBe(true);
    expect(readJson(ticketFile(name, 2)).token).toBe('A');
  });

  it('positive control: no path to the mkdir without a ticket — a link that always meets EEXIST times out, the free lock untouched', () => {
    const r = lockSync.acquireMachineLockSync('contended', {
      root,
      timeoutMs: 50,
      pollMs: 5,
      hooks: {
        link: () => {
          const error: NodeJS.ErrnoException = new Error('exists');
          error.code = 'EEXIST';
          throw error;
        },
      },
    });
    expect(r.acquired).toBe(false);
    expect(fs.existsSync(machineLockPath('contended', root))).toBe(false);
  });

  it('the TS waiter keeps the same rule', async () => {
    const r = await acquireMachineLock('contended-ts', {
      root,
      timeoutMs: 50,
      pollIntervalMs: 5,
      __testHooks: {
        link: () => {
          const error: NodeJS.ErrnoException = new Error('exists');
          error.code = 'EEXIST';
          throw error;
        },
      },
    });
    expect(r.acquired).toBe(false);
    expect(fs.existsSync(machineLockPath('contended-ts', root))).toBe(false);
  });

  it('negative control: an error other than EEXIST is thrown, like the claim\'s own', async () => {
    const eacces = () => {
      const error: NodeJS.ErrnoException = new Error('denied');
      error.code = 'EACCES';
      throw error;
    };
    expect(() => lockSync.acquireMachineLockSync('denied', { root, timeoutMs: 50, hooks: { link: eacces } })).toThrow(/denied/);
    await expect(acquireMachineLock('denied-ts', { root, timeoutMs: 50, __testHooks: { link: eacces } })).rejects.toThrow(/denied/);
  });

  it('negative control: a lone waiter on an empty queue takes the lock, and leaves only the largest ticket, used', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await acquireMachineLock('alone', { root, timeoutMs: 0 });
      expect(r.acquired).toBe(true);
      if (r.acquired) r.handle.release();
    }
    const names = fs.readdirSync(machineLockQueuePath('alone', root));
    expect(names).toEqual([machineLockTicketName(3)]);
    expect(readJson(ticketFile('alone', 3)).done).toBe(true);
  });
});

describe('S1 (review 2, finding 1): a release never moves a lock that is not its own', () => {
  it('positive control: an old handle released again leaves the next holder in place, and a third waiter does not slip in', async () => {
    const a = await acquireMachineLock('handoff', { root, timeoutMs: 0 });
    expect(a.acquired).toBe(true);
    if (!a.acquired) return;
    a.handle.release();
    const b = await acquireMachineLock('handoff', { root, timeoutMs: 0 });
    expect(b.acquired).toBe(true);
    const bToken = ownerOf('handoff').token;

    a.handle.release();
    expect(ownerOf('handoff').token).toBe(bToken);
    expect(fs.readdirSync(root).filter((entry) => entry.includes('.gone-'))).toEqual([]);
    expect((await acquireMachineLock('handoff', { root, timeoutMs: 30, pollIntervalMs: 5 })).acquired).toBe(false);
    if (b.acquired) b.handle.release();
  });

  it('the synchronous copy: a second release and a late owner update do nothing', () => {
    const a = lockSync.acquireMachineLockSync('handoff-sync', { root, timeoutMs: 0 });
    a.release();
    const b = lockSync.acquireMachineLockSync('handoff-sync', { root, timeoutMs: 0 });
    const bToken = ownerOf('handoff-sync').token;
    a.release();
    expect(a.setOwnerFields({ phase: 'merge' })).toBe(false);
    expect(ownerOf('handoff-sync')).toMatchObject({ token: bToken });
    expect(ownerOf('handoff-sync').phase).toBeUndefined();
    expect(lockSync.acquireMachineLockSync('handoff-sync', { root, timeoutMs: 0 }).acquired).toBe(false);
    // The holder's own update lands, and keeps the record its own.
    expect(b.setOwnerFields({ phase: 'push' })).toBe(true);
    expect(ownerOf('handoff-sync')).toMatchObject({ token: bToken, pid: process.pid, phase: 'push' });
    b.release();
  });
});

describe('R1: recovering a dead holder\'s lock', () => {
  const dead = (token: string) => ({ pid: 424299, host: os.hostname(), token, acquiredAt: 0 });
  const deadHooks = { pidAlive: (pid: number) => pid !== 424299, groupAlive: () => false };

  function deadLock(name: string, token = 'dead') {
    const lockPath = machineLockPath(name, root);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner'), JSON.stringify(dead(token)));
    return lockPath;
  }

  it('only the head of the queue recovers: a waiter behind a live ticket leaves the dead lock alone', () => {
    deadLock('behind');
    fs.mkdirSync(machineLockQueuePath('behind', root), { recursive: true });
    fs.writeFileSync(ticketFile('behind', 1), JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'head', createdAt: Date.now(), deadline: Date.now() + 60000 }));
    const r = lockSync.acquireMachineLockSync('behind', { root, timeoutMs: 40, pollMs: 5, hooks: deadHooks });
    expect(r.acquired).toBe(false);
    expect(ownerOf('behind').token).toBe('dead');
  });

  it('a moved lock whose record is not the dead one is put back (recoverLock)', () => {
    const lockPath = deadLock('restore', 'live-now');
    expect(lockSync.recoverLock(lockPath, dead('dead'), 'mine')).toBe('restored');
    expect(ownerOf('restore').token).toBe('live-now');
    expect(fs.readdirSync(root).filter((entry) => entry.includes('.gone-'))).toEqual([]);
    // And the very record judged dead is removed.
    expect(lockSync.recoverLock(lockPath, dead('live-now'), 'mine')).toBe('recovered');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('negative control: an old-version cleaner (read the token, pause, rm -rf) still removes the new holder — the window design §2.4 leaves to old runners', () => {
    const lockPath = deadLock('old-cleaner');
    // X, a runner from before #4277, reads the dead token and is paused before its rm -rf.
    const seen = lockSync.readOwner(lockPath).token;
    const b = lockSync.acquireMachineLockSync('old-cleaner', { root, timeoutMs: 1000, pollMs: 5, hooks: deadHooks });
    expect(b.acquired).toBe(true);
    expect(seen).toBe('dead');
    fs.rmSync(lockPath, { recursive: true, force: true }); // X resumes
    expect(fs.existsSync(lockPath)).toBe(false);
    b.release();
  });
});

describe('cross-implementation: the TS runner and the synchronous copy keep one queue', () => {
  it('positive control: the synchronous taker does not jump the TS waiter that queued first when the lock frees', async () => {
    const name = 'cross';
    const holder = await acquireMachineLock(name, { root, timeoutMs: 0 });
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) return;
    const waiter = acquireMachineLock(name, { root, timeoutMs: 5000, pollIntervalMs: 20 });
    // The TS waiter has its ticket (it ran up to its first sleep); the lock frees.
    holder.handle.release();
    // Before #4277 this mkdir won: the lock is free and the TS waiter has not polled yet.
    const jumper = lockSync.acquireMachineLockSync(name, { root, timeoutMs: 0 });
    expect(jumper.acquired).toBe(false);
    expect(jumper.heldBy).toContain('queue ticket');
    const first = await waiter;
    expect(first.acquired).toBe(true);
    if (first.acquired) first.handle.release();
    // Negative control: with nobody queued, the synchronous taker takes it at once.
    const next = lockSync.acquireMachineLockSync(name, { root, timeoutMs: 0 });
    expect(next.acquired).toBe(true);
    next.release();
  });
});

describe('etime', () => {
  it('reads [[dd-]hh:]mm:ss as ps prints it on macOS and Linux', () => {
    expect(parseEtime('   01:05')).toBe(65000);
    expect(parseEtime('02:01:05')).toBe((2 * 3600 + 65) * 1000);
    expect(parseEtime('3-02:01:05')).toBe(((3 * 24 + 2) * 3600 + 65) * 1000);
    expect(parseEtime('')).toBeNull();
    expect(lockSync.parseEtime('3-02:01:05')).toBe(parseEtime('3-02:01:05'));
  });

  it('a live process reads as started before now', () => {
    const start = lockSync.processStartMs(process.pid);
    expect(start === null || start <= Date.now()).toBe(true);
  });
});
