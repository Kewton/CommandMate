/**
 * Update Lock
 * Issue #1198: guard `POST /api/app/update` against concurrent self-updates.
 *
 * Design constraints:
 * - Acquisition is a single O_EXCL create (mirrors PidManager.writePid), so two
 *   concurrent requests cannot both win.
 * - A successful update restarts the server, so nothing survives to release the
 *   lock. Timeout expiry is therefore the primary release path, and
 *   releaseUpdateLock() exists only for the spawn-failed case.
 *
 * @module lib/app-update/update-lock
 */

import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from 'fs';
import { join } from 'path';
import { ensureConfigDir } from '@/cli/utils/install-context';

/** Lock file name inside the config directory */
export const UPDATE_LOCK_FILENAME = 'update.lock';

/**
 * Age after which a lock is considered abandoned.
 * `commandmate update` takes tens of seconds (npm install dominates); 10 minutes
 * is well clear of that while still recovering from a killed update process.
 */
export const UPDATE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/** Persisted lock payload */
interface LockData {
  /** Epoch ms when the lock was taken */
  startedAt: number;
  /** PID of the server process that took it (diagnostics only) */
  pid: number;
}

/**
 * Absolute path of the update lock file.
 */
export function getUpdateLockPath(): string {
  return join(ensureConfigDir(), UPDATE_LOCK_FILENAME);
}

/**
 * Whether an existing lock is old enough to reclaim.
 * An unreadable or malformed lock counts as stale: it can never expire on its
 * own, so treating it as held would block updates permanently.
 */
function isStale(lockPath: string, now: number): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf-8'));
    const startedAt = (parsed as { startedAt?: unknown }).startedAt;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
      return true;
    }
    return now - startedAt > UPDATE_LOCK_TIMEOUT_MS;
  } catch {
    return true;
  }
}

/**
 * Create the lock file, failing if it already exists.
 *
 * @returns true when this call created the file
 */
function tryCreate(lockPath: string, now: number): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    return false;
  }

  try {
    const data: LockData = { startedAt: now, pid: process.pid };
    writeSync(fd, JSON.stringify(data));
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Take the update lock.
 *
 * @param now - Current epoch ms (injectable for tests)
 * @returns true when the caller now holds the lock, false when an update is in progress
 */
export function acquireUpdateLock(now: number = Date.now()): boolean {
  const lockPath = getUpdateLockPath();

  if (tryCreate(lockPath, now)) {
    return true;
  }

  if (!isStale(lockPath, now)) {
    return false;
  }

  // Reclaim: unlink then re-create. A concurrent reclaimer loses the O_EXCL
  // race and correctly reports "in progress" rather than spawning a second update.
  try {
    unlinkSync(lockPath);
  } catch {
    return false;
  }

  return tryCreate(lockPath, now);
}

/**
 * Drop the update lock.
 * Only meaningful when the update never started (spawn failure): a started
 * update replaces this process, so the lock outlives it until it expires.
 */
export function releaseUpdateLock(): void {
  try {
    unlinkSync(getUpdateLockPath());
  } catch {
    // Already gone (expired and reclaimed elsewhere) — nothing to do.
  }
}
