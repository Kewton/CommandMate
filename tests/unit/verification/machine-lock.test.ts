/**
 * Unit tests for the machine-wide gate lock (Issue #1771).
 *
 * Every test drives a real directory under `mkdtemp`, never the default
 * `~/.commandmate/locks`: that root is shared by every checkout on the machine,
 * so a suite that used it would serialize against live verification runs and
 * fail for reasons that have nothing to do with the code under test.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { hostname, tmpdir } from 'os';
import { join } from 'path';
import {
  acquireMachineLock,
  defaultMachineLockRoot,
  machineLockPath,
  MACHINE_LOCK_DIR_NAME,
  MACHINE_LOCK_ROOT_ENV,
  resolveMachineLockRoot,
} from '@/lib/verification/machine-lock';
import { removeTempDir } from '@tests/helpers/temp-dir';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-lock-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDir(root);
});

/** Acquire with test-speed polling; the production 250ms cadence is not under test. */
function acquire(name: string, timeoutMs: number) {
  return acquireMachineLock(name, { root, timeoutMs, pollIntervalMs: 5 });
}

describe('resolveMachineLockRoot', () => {
  it('defaults to ~/.commandmate/locks — the path both runners must agree on', () => {
    expect(resolveMachineLockRoot({})).toBe(defaultMachineLockRoot());
    expect(defaultMachineLockRoot().endsWith(join('.commandmate', MACHINE_LOCK_DIR_NAME))).toBe(
      true
    );
  });

  it('honours the override so a test never touches the shared root', () => {
    expect(resolveMachineLockRoot({ [MACHINE_LOCK_ROOT_ENV]: '/tmp/elsewhere' })).toBe(
      '/tmp/elsewhere'
    );
  });

  it('ignores a blank override rather than locking in the current directory', () => {
    expect(resolveMachineLockRoot({ [MACHINE_LOCK_ROOT_ENV]: '   ' })).toBe(
      defaultMachineLockRoot()
    );
  });
});

describe('acquireMachineLock', () => {
  it('creates <root>/<name>.lock and removes it on release', async () => {
    const result = await acquire('e2e', 1000);
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    expect(result.handle.path).toBe(machineLockPath('e2e', root));
    expect(existsSync(result.handle.path)).toBe(true);

    result.handle.release();
    expect(existsSync(result.handle.path)).toBe(false);
  });

  it('reports no wait when the lock was free', async () => {
    const result = await acquire('free', 1000);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(result.waitedMs).toBeLessThan(1000);
      result.handle.release();
    }
  });

  it('refuses a second holder while the first has it', async () => {
    const first = await acquire('busy', 1000);
    expect(first.acquired).toBe(true);

    const second = await acquire('busy', 50);
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      // The whole budget was spent waiting, and the caller is told so instead of
      // being handed a lock two runs would then share.
      expect(second.waitedMs).toBeGreaterThanOrEqual(45);
      expect(second.heldBy).toContain(`pid ${process.pid}`);
    }

    if (first.acquired) first.handle.release();
  });

  it('hands the lock to a waiter once the holder releases', async () => {
    const first = await acquire('handoff', 1000);
    expect(first.acquired).toBe(true);

    const waiter = acquire('handoff', 2000);
    setTimeout(() => {
      if (first.acquired) first.handle.release();
    }, 30);

    const second = await waiter;
    expect(second.acquired).toBe(true);
    if (second.acquired) {
      expect(second.waitedMs).toBeGreaterThan(0);
      second.handle.release();
    }
  });

  it('serializes concurrent acquisitions of the same name', async () => {
    const order: string[] = [];
    const worker = async (label: string): Promise<void> => {
      const result = await acquire('shared', 5000);
      expect(result.acquired).toBe(true);
      if (!result.acquired) return;
      order.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push(`${label}:end`);
      result.handle.release();
    };

    await Promise.all([worker('a'), worker('b'), worker('c')]);

    // No interleaving: every start is immediately followed by its own end.
    expect(order).toHaveLength(6);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i + 1]).toBe(order[i].replace(':start', ':end'));
    }
  });

  it('does not serialize different names', async () => {
    const a = await acquire('alpha', 1000);
    const b = await acquire('beta', 50);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    if (a.acquired) a.handle.release();
    if (b.acquired) b.handle.release();
  });

  it('breaks a lock whose recorded holder is gone', async () => {
    // A run killed between mkdir and release leaves the directory behind. If
    // that wedged the machine, one crash would disable the gate until someone
    // deleted a directory by hand.
    const lockPath = machineLockPath('crashed', root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, 'owner'),
      JSON.stringify({ pid: 2, host: hostname(), token: 'dead', acquiredAt: Date.now() })
    );
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 2) {
        const error: NodeJS.ErrnoException = new Error('no such process');
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    const result = await acquire('crashed', 200);
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(JSON.parse(readFileSync(join(lockPath, 'owner'), 'utf8')).pid).toBe(process.pid);
      result.handle.release();
    }
  });

  it('waits for a holder on another host instead of breaking it', async () => {
    // A pid from another machine says nothing about a process here, and guessing
    // would let two machines on a shared home run the gate at once.
    const lockPath = machineLockPath('remote', root);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, 'owner'),
      JSON.stringify({ pid: 999999, host: 'another-host', token: 't', acquiredAt: Date.now() })
    );

    const result = await acquire('remote', 40);
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.heldBy).toContain('another-host');
  });

  it('does not delete a lock that was broken and re-taken under it', async () => {
    const first = await acquire('stolen', 1000);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    // Simulate the break-and-retake: another run decided this holder was stale.
    writeFileSync(
      join(first.handle.path, 'owner'),
      JSON.stringify({ pid: 4242, host: hostname(), token: 'other', acquiredAt: Date.now() })
    );

    first.handle.release();

    // Still there: releasing on top of a live holder would hand the resource to
    // two runs at once.
    expect(existsSync(first.handle.path)).toBe(true);
  });

  it('is idempotent on release', async () => {
    const result = await acquire('twice', 1000);
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    result.handle.release();
    expect(() => result.handle.release()).not.toThrow();
  });

  it('creates the root when it does not exist yet', async () => {
    const nested = join(root, 'deeper', 'still');
    const result = await acquireMachineLock('fresh', { root: nested, timeoutMs: 500 });
    expect(result.acquired).toBe(true);
    if (result.acquired) result.handle.release();
  });
});
