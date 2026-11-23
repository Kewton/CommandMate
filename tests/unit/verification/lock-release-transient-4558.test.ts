/**
 * Issue #4558: a release whose read of the owner fails once (EIO …) must not count as done.
 *
 * Before the fix both JS implementations marked the release done before the read: the read failed,
 * the call answered 'deferred' (sync) or returned (TS), and every later call did nothing ('none'). The
 * holder is the live process itself, so no head ever recovers the lock and the next heavy gate waits
 * out its budget. The fault is injected at the observation point `release-owner` through the test
 * seam, in a root under os.tmpdir().
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { acquireMachineLock, machineLockPath } from '@/lib/verification/machine-lock';
import * as lockSync from '../../../scripts/orchestrate/machine-lock-sync.mjs';
import { cleanRoots, freshRoot, ownerToken, writeOwner } from './lock-holder-identity-4558-harness';

/** A fault at `release-owner` for its first `times` reads, then none. */
const failingReads = (times: number) => {
  let n = 0;
  return {
    reads: () => n,
    fault: (point: string): string | null => {
      if (point !== 'release-owner') return null;
      n += 1;
      return n <= times ? 'EIO' : null;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
  cleanRoots();
});

describe('#4558 sync: a release whose owner read fails once', () => {
  it('positive: one EIO on the read — the lock is released (not deferred, not left for nobody)', () => {
    const root = freshRoot('4558-sync');
    const f = failingReads(1);
    const lock = lockSync.acquireMachineLockSync('x', { root, timeoutMs: 0, hooks: { fault: f.fault } });
    expect(lock.acquired).toBe(true);
    const first = lock.release();
    const second = lock.release();
    expect([first, second, fs.existsSync(lock.path)]).toEqual(['released', 'none', false]);
  });

  it('positive: an owner unreadable for longer than one call — deferred, and the next call releases it', () => {
    const root = freshRoot('4558-sync-long');
    const f = failingReads(3);
    const lock = lockSync.acquireMachineLockSync('x', { root, timeoutMs: 0, hooks: { fault: f.fault } });
    expect(lock.acquired).toBe(true);
    expect(lock.release()).toBe('deferred');
    expect(fs.existsSync(lock.path)).toBe(true);
    expect([lock.release(), fs.existsSync(lock.path)]).toEqual(['released', false]);
  });

  it('negative control: no fault — released on the first read, then none (the order is unchanged)', () => {
    const root = freshRoot('4558-sync-ok');
    const f = failingReads(0);
    const lock = lockSync.acquireMachineLockSync('x', { root, timeoutMs: 0, hooks: { fault: f.fault } });
    expect([lock.release(), lock.release(), f.reads(), fs.existsSync(lock.path)]).toEqual(['released', 'none', 1, false]);
  });

  it('I3: a record that is no longer ours after a deferred release is never removed by the retry', () => {
    const root = freshRoot('4558-sync-other');
    const f = failingReads(3);
    const lock = lockSync.acquireMachineLockSync('x', { root, timeoutMs: 0, hooks: { fault: f.fault } });
    expect(lock.release()).toBe('deferred');
    fs.rmSync(lock.path, { recursive: true });
    writeOwner(lock.path, { pid: process.pid, host: 'h', token: 'someone-else', acquiredAt: 0, v: 1 });
    expect([lock.release(), ownerToken(lock.path)]).toEqual(['kept', 'someone-else']);
  });
});

describe('#4558 TS: a release whose owner read fails once', () => {
  it('positive: one EIO on the read — the lock is released', async () => {
    const root = freshRoot('4558-ts');
    const f = failingReads(1);
    const r = await acquireMachineLock('x', { root, timeoutMs: 0, __testHooks: { fault: f.fault } });
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    r.handle.release();
    expect(fs.existsSync(machineLockPath('x', root))).toBe(false);
  });

  it('positive: an owner unreadable for longer than one call is read again later and released (gate-runner calls once)', async () => {
    const root = freshRoot('4558-ts-long');
    const f = failingReads(4);
    const r = await acquireMachineLock('x', { root, timeoutMs: 0, __testHooks: { fault: f.fault } });
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    r.handle.release();
    expect(fs.existsSync(r.handle.path)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(r.handle.path)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('negative control: no fault — released at once, nothing left scheduled', async () => {
    const root = freshRoot('4558-ts-ok');
    const f = failingReads(0);
    const r = await acquireMachineLock('x', { root, timeoutMs: 0, __testHooks: { fault: f.fault } });
    if (!r.acquired) throw new Error('not acquired');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    r.handle.release();
    r.handle.release();
    expect([fs.existsSync(r.handle.path), f.reads(), vi.getTimerCount()]).toEqual([false, 1, 0]);
  });

  it('I3: a record that is no longer ours when the retry reads is not removed', async () => {
    const root = freshRoot('4558-ts-other');
    const f = failingReads(3);
    const r = await acquireMachineLock('x', { root, timeoutMs: 0, __testHooks: { fault: f.fault } });
    if (!r.acquired) throw new Error('not acquired');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    r.handle.release();
    fs.rmSync(r.handle.path, { recursive: true });
    writeOwner(r.handle.path, { pid: process.pid, host: 'h', token: 'someone-else', acquiredAt: 0, v: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect([ownerToken(r.handle.path), vi.getTimerCount()]).toEqual(['someone-else', 0]);
    expect(path.basename(r.handle.path)).toBe('x.lock');
  });
});
