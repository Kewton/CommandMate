/**
 * scripts/orchestrate/consistency-review.mjs — two waiters reclaiming the same
 * dead lock (Issue #3633, consistency review P2).
 *
 * Both waiters see the same killed owner. Before, each checked the owner, then
 * moved the lock aside and removed it, with nothing between them: one could
 * reclaim and take a new lock in the other's gap, and the other then moved
 * that new, live lock away. The reclaim now holds `<lock>.reclaim` (mkdir), so
 * one waiter at a time re-reads the owner and moves the lock, and a lock that
 * names someone else is never moved.
 *
 * Everything is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCK_OWNER_FILE,
  acquireLock,
  reclaimDirOf,
  reclaimStaleLock,
} from '../../../../scripts/orchestrate/consistency-review.mjs';

type Owner = { pid: number; host: string; startedAt: string };

const T0 = Date.UTC(2026, 9, 13, 1, 0);

let tmp: string;
let lock: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-consistency-reclaim-'));
  lock = path.join(tmp, 'proposals', '2026-10-13', '.lock');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A pid that existed and has exited: the review that held the lock was killed. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid as number;
}

function write(dir: string, owner: Owner) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LOCK_OWNER_FILE), JSON.stringify(owner));
}

const ownerOf = (dir: string): Owner => JSON.parse(fs.readFileSync(path.join(dir, LOCK_OWNER_FILE), 'utf8'));

/** A waiter: its own clock (so the owners it writes differ), its stderr, and a sleep that can stop it. */
function waiter(startMs: number, { stopOnSleep = false } = {}) {
  let clock = startMs;
  const errors: string[] = [];
  const sleeps: number[] = [];
  return {
    errors,
    sleeps,
    deps: (between?: () => void) => ({
      now: () => new Date(clock),
      error: (line: string) => errors.push(line),
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        if (stopOnSleep) throw new Error('stopped waiting');
      },
      between,
    }),
  };
}

describe('reclaiming a dead owner\'s lock is one waiter at a time (#3633)', () => {
  it('two waiters at once: one takes the lock, the other waits and does not remove it', () => {
    const dead: Owner = { pid: deadPid(), host: os.hostname(), startedAt: new Date(T0 - 3_600_000).toISOString() };
    write(lock, dead);
    const first = waiter(T0);
    const second = waiter(T0 + 1_000, { stopOnSleep: true });
    let secondTried = false;

    // The first waiter has re-read the dead owner and is about to move the lock;
    // the second arrives exactly now and sees the same dead owner.
    const taken = acquireLock(
      lock,
      first.deps(() => {
        secondTried = true;
        expect(() => acquireLock(lock, second.deps())).toThrow('stopped waiting');
        // It neither moved nor replaced the lock: it is still the dead owner's.
        expect(ownerOf(lock)).toEqual(dead);
      })
    );

    expect(secondTried).toBe(true);
    expect(second.sleeps).toHaveLength(1);
    expect(second.errors.join('\n')).not.toContain('taking it over');
    expect(first.errors.join('\n')).toContain('taking it over');
    expect(ownerOf(lock)).toEqual(taken);
    expect(taken.startedAt).toBe(new Date(T0).toISOString());
    expect(fs.existsSync(reclaimDirOf(lock))).toBe(false);
    expect(fs.readdirSync(path.dirname(lock))).toEqual(['.lock']);
  });

  it('the late waiter, still holding the dead owner it read, leaves the lock the other took', () => {
    const dead: Owner = { pid: deadPid(), host: os.hostname(), startedAt: new Date(T0 - 3_600_000).toISOString() };
    write(lock, dead);
    const first = waiter(T0);
    const taken = acquireLock(lock, first.deps());
    const late = waiter(T0 + 1_000);

    expect(reclaimStaleLock(lock, dead, late.deps())).toBe('changed');
    expect(ownerOf(lock)).toEqual(taken);
    expect(late.errors).toEqual([]);
    expect(fs.existsSync(reclaimDirOf(lock))).toBe(false);
  });

  it('a lock removed meanwhile (not yet taken again) is left to mkdir, not renamed', () => {
    const dead: Owner = { pid: deadPid(), host: os.hostname(), startedAt: new Date(T0).toISOString() };
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    expect(reclaimStaleLock(lock, dead, waiter(T0).deps())).toBe('changed');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('a live reclaimer makes the other wait (busy); its lock and reclaim are untouched', () => {
    const dead: Owner = { pid: deadPid(), host: os.hostname(), startedAt: new Date(T0).toISOString() };
    const reclaimer: Owner = { pid: process.pid, host: os.hostname(), startedAt: new Date(T0).toISOString() };
    write(lock, dead);
    write(reclaimDirOf(lock), reclaimer);
    expect(reclaimStaleLock(lock, dead, waiter(T0).deps())).toBe('busy');
    expect(ownerOf(lock)).toEqual(dead);
    expect(ownerOf(reclaimDirOf(lock))).toEqual(reclaimer);
  });

  it('a reclaim left by a killed reclaimer stops with what to remove, and moves nothing', () => {
    const dead: Owner = { pid: deadPid(), host: os.hostname(), startedAt: new Date(T0).toISOString() };
    write(lock, dead);
    write(reclaimDirOf(lock), { ...dead, startedAt: new Date(T0 + 1).toISOString() });
    expect(() => reclaimStaleLock(lock, dead, waiter(T0).deps())).toThrow(`${reclaimDirOf(lock)} is left by pid ${dead.pid}`);
    expect(ownerOf(lock)).toEqual(dead);
  });

  it('a live owner\'s lock is not reclaimed at all (negative control)', () => {
    const live: Owner = { pid: process.pid, host: os.hostname(), startedAt: new Date(T0).toISOString() };
    write(lock, live);
    const w = waiter(T0, { stopOnSleep: true });
    expect(() => acquireLock(lock, w.deps())).toThrow('stopped waiting');
    expect(ownerOf(lock)).toEqual(live);
    expect(fs.existsSync(reclaimDirOf(lock))).toBe(false);
  });
});
