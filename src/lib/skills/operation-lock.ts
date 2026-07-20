/**
 * Cross-process exclusive lock for Skill operations (Issue #1234)
 *
 * Extends the O_EXCL pattern of `lib/app-update/update-lock` with the three
 * properties a Skill operation needs and a self-update does not:
 *
 * - **Owner nonce.** Release and renew require the caller to present the nonce
 *   written at acquisition, so no process can drop a lock it does not hold.
 * - **Lease heartbeat.** {@link renewSkillOperationLease} can extend a lease so
 *   a long operation is not reclaimed by age. It is not yet wired into the
 *   routes, so owner liveness below — not the heartbeat — is what currently
 *   keeps a live operation safe (Issue #1427).
 * - **Owner liveness.** A lock whose lease expired is reclaimed only when the
 *   owning PID is verifiably gone on this host. A live owner that missed a
 *   heartbeat keeps its lock, including a same-process concurrent operation:
 *   reclaiming it would let two processes write the same payload.
 *
 * The lock key is a digest of the *resolved* worktree path and the validated
 * Skill ID, so no untrusted name ever reaches a filename.
 *
 * @module lib/skills/operation-lock
 */

import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import {
  SKILL_LOCK_DIRNAME,
  SKILL_STATE_FILE_MODE,
  ensureSkillStateDir,
  readSkillStateFile,
  writeSkillStateFile,
  type SkillOperationStoreOptions,
} from '@/lib/skills/operation-store';

/** Lease length. A holder renews well before this; a crash expires it. */
export const SKILL_LOCK_LEASE_MS = 30_000;

/**
 * Extra wait before reclaiming a lock owned by another host.
 * Liveness cannot be checked across hosts, so time is the only evidence there.
 */
export const SKILL_LOCK_FOREIGN_HOST_GRACE_MS = 10 * 60_000;

/** Identity of the process holding a lock. */
export interface SkillLockOwner {
  /** Secret presented on renew/release. Possession is what proves ownership. */
  nonce: string;
  pid: number;
  host: string;
  /**
   * Random per-process id. Distinguishes the original holder from an unrelated
   * process that later inherited the same PID.
   */
  processGeneration: string;
}

/** Persisted lock record. */
export interface SkillOperationLockRecord {
  schemaVersion: 1;
  key: string;
  operationId: string;
  owner: SkillLockOwner;
  acquiredAt: number;
  renewedAt: number;
  leaseExpiresAt: number;
}

/** Client-safe description of a lock held by someone else. No path, no nonce. */
export interface SkillLockHolder {
  operationId: string;
  acquiredAt: number;
  leaseExpiresAt: number;
}

/** Why acquisition was refused. */
export type SkillLockDenyReason =
  /** Lease is still valid. Retry after it expires. */
  | 'HELD'
  /** Lease expired but the owning process is still alive. Never reclaimed. */
  | 'HELD_BY_LIVE_OWNER'
  /** Owned by another host, so liveness is unverifiable and the grace has not elapsed. */
  | 'HELD_UNVERIFIABLE_OWNER'
  /** Another process won the reclaim race. */
  | 'RACE_LOST';

export type SkillLockAcquireResult =
  | { ok: true; lock: SkillOperationLockRecord; reclaimed: boolean }
  | { ok: false; reason: SkillLockDenyReason; heldBy: SkillLockHolder | null };

/** How an observed lock record may be treated. */
export type SkillLockDisposition =
  | 'FREE'
  | 'HELD'
  | 'HELD_BY_LIVE_OWNER'
  | 'HELD_UNVERIFIABLE_OWNER'
  | 'RECLAIMABLE';

export interface SkillLockOptions extends SkillOperationStoreOptions {
  /** Injectable clock. */
  now?: number;
  /** Injectable liveness probe, so tests can simulate a dead or live owner. */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Identifies this process across restarts. A PID alone is reusable; combined
 * with this value a record can be recognised as "written by me".
 */
const PROCESS_GENERATION = randomUUID();

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Lock key for a (worktree, skill) pair.
 *
 * @param worktreeRealPath - Server-resolved, symlink-free worktree path. Two
 *   registrations pointing at the same directory must produce the same key, so
 *   the caller is responsible for having called realpath.
 * @param skillId - Skill ID already validated against the contract grammar.
 */
export function buildSkillOperationLockKey(worktreeRealPath: string, skillId: string): string {
  return createHash('sha256').update(`${worktreeRealPath}\x00${skillId}`).digest('hex');
}

function getLockDir(options: SkillLockOptions): string {
  return ensureSkillStateDir(SKILL_LOCK_DIRNAME, options);
}

function getLockPath(key: string, options: SkillLockOptions): string {
  return join(getLockDir(options), `${key}.lock`);
}

function isLockRecord(value: unknown): value is SkillOperationLockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<SkillOperationLockRecord>;
  const owner = record.owner;
  return (
    typeof record.key === 'string' &&
    typeof record.operationId === 'string' &&
    typeof record.leaseExpiresAt === 'number' &&
    Number.isFinite(record.leaseExpiresAt) &&
    typeof owner === 'object' &&
    owner !== null &&
    typeof owner.nonce === 'string' &&
    typeof owner.pid === 'number' &&
    typeof owner.host === 'string'
  );
}

/** Read a lock record. Returns null when absent or unparseable. */
export function readSkillOperationLock(
  key: string,
  options: SkillLockOptions = {}
): SkillOperationLockRecord | null {
  const record = readSkillStateFile<unknown>(getLockPath(key, options));
  return isLockRecord(record) ? record : null;
}

/** Public, non-sensitive view of a lock record. */
export function describeSkillLockHolder(record: SkillOperationLockRecord): SkillLockHolder {
  return {
    operationId: record.operationId,
    acquiredAt: record.acquiredAt,
    leaseExpiresAt: record.leaseExpiresAt,
  };
}

/**
 * Decide how an observed record may be treated, given the clock and liveness.
 *
 * Ordering matters: a valid lease short-circuits every other consideration, so
 * a live holder is never reclaimed regardless of what its PID looks like. Once
 * the lease has lapsed on this host, PID liveness is the *only* remaining
 * evidence — a lock is reclaimed only when its owning process is verifiably gone.
 *
 * Same-process locks are deliberately not shortcut to RECLAIMABLE (Issue #1427).
 * Every Next.js route handler runs in one shared process and none renews its
 * lease ({@link renewSkillOperationLease} has no production caller), so a lapsed
 * lease is not evidence that a *concurrent* same-process operation abandoned its
 * lock. Shortcutting it to reclaimable let a second request steal a live
 * install's lock ~one lease window in and write the same payload underneath it.
 * A same-process owner that is still alive now resolves to HELD_BY_LIVE_OWNER
 * and is left alone.
 *
 * Tradeoff: this process can no longer instantly reclaim a lock it truly leaked
 * (acquired but never released). While the process stays alive such a lock reads
 * as HELD_BY_LIVE_OWNER; it clears only on an explicit release or after the
 * process exits — a later process then sees the dead PID and reclaims it. Note
 * this is stronger than "next acquire waits at most one lease window": with no
 * heartbeat there is no time-based signal, so within one live process the lock
 * is held until release/exit, not merely until the lease lapses. In practice the
 * acquire path always releases in a `finally`, so the only real remnant is a
 * crash — and crash orphans are unaffected: a new process has a different
 * generation and finds the old PID gone, so the liveness branch below reclaims
 * them exactly as before.
 */
export function evaluateSkillLock(
  record: SkillOperationLockRecord | null,
  options: SkillLockOptions = {}
): SkillLockDisposition {
  if (record === null) return 'FREE';

  const now = options.now ?? Date.now();
  if (now < record.leaseExpiresAt) return 'HELD';

  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  if (record.owner.host !== hostname()) {
    const expiredFor = now - record.leaseExpiresAt;
    return expiredFor > SKILL_LOCK_FOREIGN_HOST_GRACE_MS
      ? 'RECLAIMABLE'
      : 'HELD_UNVERIFIABLE_OWNER';
  }

  return isAlive(record.owner.pid) ? 'HELD_BY_LIVE_OWNER' : 'RECLAIMABLE';
}

function buildRecord(
  key: string,
  operationId: string,
  now: number,
  leaseMs: number
): SkillOperationLockRecord {
  return {
    schemaVersion: 1,
    key,
    operationId,
    owner: {
      nonce: randomBytes(24).toString('hex'),
      pid: process.pid,
      host: hostname(),
      processGeneration: PROCESS_GENERATION,
    },
    acquiredAt: now,
    renewedAt: now,
    leaseExpiresAt: now + leaseMs,
  };
}

/** Create the lock file, failing when it already exists. */
function tryCreate(lockPath: string, record: SkillOperationLockRecord): boolean {
  let fd: number;
  try {
    fd = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      SKILL_STATE_FILE_MODE
    );
  } catch {
    return false;
  }
  try {
    writeSync(fd, JSON.stringify(record));
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Move a reclaimable lock aside atomically, then re-check it.
 *
 * The rename is the mutual exclusion: only one reclaimer can move the file, so
 * a second reclaimer fails and reports RACE_LOST instead of also proceeding.
 * The post-rename re-check closes the window where the holder renewed its lease
 * between our read and our rename; in that case the file is put back.
 */
function reclaim(
  lockPath: string,
  observed: SkillOperationLockRecord | null,
  options: SkillLockOptions
): { ok: true } | { ok: false; reason: SkillLockDenyReason } {
  const stagePath = `${lockPath}.reclaim-${randomBytes(8).toString('hex')}`;
  try {
    renameSync(lockPath, stagePath);
  } catch {
    return { ok: false, reason: 'RACE_LOST' };
  }

  const staged = readSkillStateFile<unknown>(stagePath);
  const stagedRecord = isLockRecord(staged) ? staged : null;
  const stillReclaimable =
    observed === null
      ? // The file was unparseable; only proceed if it still is.
        stagedRecord === null
      : stagedRecord === null ||
        (stagedRecord.owner.nonce === observed.owner.nonce &&
          evaluateSkillLock(stagedRecord, options) === 'RECLAIMABLE');

  if (!stillReclaimable) {
    try {
      renameSync(stagePath, lockPath);
    } catch {
      // The holder already re-created its own lock; nothing was lost.
    }
    return { ok: false, reason: 'RACE_LOST' };
  }

  try {
    unlinkSync(stagePath);
  } catch {
    // Already gone; the lock path is what matters.
  }
  return { ok: true };
}

/**
 * Take the exclusive lock for one (worktree, skill) pair.
 *
 * @returns the record on success. The caller must keep it: renew and release
 *   both require the nonce it carries.
 */
export function acquireSkillOperationLock(
  input: { key: string; operationId: string; leaseMs?: number },
  options: SkillLockOptions = {}
): SkillLockAcquireResult {
  const now = options.now ?? Date.now();
  const leaseMs = input.leaseMs ?? SKILL_LOCK_LEASE_MS;
  const lockPath = getLockPath(input.key, options);

  const record = buildRecord(input.key, input.operationId, now, leaseMs);
  if (tryCreate(lockPath, record)) {
    return { ok: true, lock: record, reclaimed: false };
  }

  const observed = readSkillOperationLock(input.key, options);
  // A file that exists but does not parse can never expire on its own, so it is
  // reclaimable rather than "free" — free would mean the create below succeeds.
  const disposition =
    observed === null
      ? existsSync(lockPath)
        ? 'RECLAIMABLE'
        : 'FREE'
      : evaluateSkillLock(observed, options);
  const heldBy = observed ? describeSkillLockHolder(observed) : null;

  if (disposition === 'HELD' || disposition === 'HELD_BY_LIVE_OWNER') {
    return { ok: false, reason: disposition, heldBy };
  }
  if (disposition === 'HELD_UNVERIFIABLE_OWNER') {
    return { ok: false, reason: 'HELD_UNVERIFIABLE_OWNER', heldBy };
  }
  if (disposition === 'FREE') {
    // The file vanished between the failed create and the read.
    return tryCreate(lockPath, record)
      ? { ok: true, lock: record, reclaimed: false }
      : { ok: false, reason: 'RACE_LOST', heldBy: null };
  }

  // RECLAIMABLE.
  const reclaimed = reclaim(lockPath, observed, options);
  if (!reclaimed.ok) {
    return { ok: false, reason: reclaimed.reason, heldBy };
  }
  return tryCreate(lockPath, record)
    ? { ok: true, lock: record, reclaimed: true }
    : { ok: false, reason: 'RACE_LOST', heldBy: null };
}

/**
 * Extend the lease. Fails when the caller is not the current owner, which is
 * how a process that was reclaimed learns it must stop writing.
 *
 * @returns the refreshed record, or null when the lock was lost.
 */
export function renewSkillOperationLease(
  lock: SkillOperationLockRecord,
  options: SkillLockOptions = {}
): SkillOperationLockRecord | null {
  const current = readSkillOperationLock(lock.key, options);
  if (current === null || current.owner.nonce !== lock.owner.nonce) return null;

  const now = options.now ?? Date.now();
  const leaseMs = lock.leaseExpiresAt - lock.renewedAt;
  const renewed: SkillOperationLockRecord = {
    ...current,
    renewedAt: now,
    leaseExpiresAt: now + (leaseMs > 0 ? leaseMs : SKILL_LOCK_LEASE_MS),
  };
  writeSkillStateFile(getLockPath(lock.key, options), renewed);
  return renewed;
}

/**
 * Drop the lock. Owner-only: presenting a stale or foreign nonce is refused so
 * no operation can release another operation's resource.
 */
export function releaseSkillOperationLock(
  lock: SkillOperationLockRecord,
  options: SkillLockOptions = {}
): boolean {
  const current = readSkillOperationLock(lock.key, options);
  if (current === null || current.owner.nonce !== lock.owner.nonce) return false;

  try {
    unlinkSync(getLockPath(lock.key, options));
    return true;
  } catch {
    return false;
  }
}

/** Keys of every lock file currently present. */
export function listSkillOperationLockKeys(options: SkillLockOptions = {}): string[] {
  return readdirSync(getLockDir(options))
    .filter((name) => name.endsWith('.lock'))
    .map((name) => name.slice(0, -'.lock'.length));
}

/**
 * Remove locks whose owner is verifiably gone.
 *
 * Used by startup reconciliation. A lock is only removed when
 * {@link evaluateSkillLock} says RECLAIMABLE, so a live owner — even one whose
 * lease lapsed — keeps its lock.
 *
 * @returns keys of the locks that were removed.
 */
export function releaseOrphanSkillLocks(options: SkillLockOptions = {}): string[] {
  const released: string[] = [];
  for (const key of listSkillOperationLockKeys(options)) {
    const record = readSkillOperationLock(key, options);
    // A file that exists but does not parse can never expire on its own.
    const disposition = record === null ? 'RECLAIMABLE' : evaluateSkillLock(record, options);
    if (disposition !== 'RECLAIMABLE') continue;
    try {
      unlinkSync(getLockPath(key, options));
      released.push(key);
    } catch {
      // Someone else cleaned it up first.
    }
  }
  return released;
}
