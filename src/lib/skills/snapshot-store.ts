/**
 * Read-only snapshot store for verified Skill artifacts (Issue #1229)
 *
 * A snapshot is verified artifact bytes parked in the service-owned data root
 * so a later step (#1230 extraction, #1231 install) can read them without
 * re-downloading. Snapshots are addressed by an opaque ID: absolute paths never
 * leave this module, because they identify the machine and the data root.
 *
 * Lifetime is reference-counted with a TTL backstop. A snapshot with live
 * references is never swept, no matter how much quota pressure there is —
 * failing the new download is correct, corrupting an in-progress install is
 * not. Process restart drops every reference, so initialization treats whatever
 * is on disk as orphaned and removes it.
 *
 * @module lib/skills/snapshot-store
 */

import { randomBytes } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { getConfigDir } from '@/cli/utils/install-context';
import {
  SKILL_SNAPSHOT_DIRNAME,
  SKILL_SNAPSHOT_DIR_MODE,
  SKILL_SNAPSHOT_FILE_MODE,
  SKILL_SNAPSHOT_ID_BYTES,
  SKILL_SNAPSHOT_ID_PATTERN,
  SKILL_SNAPSHOT_MAX_COUNT,
  SKILL_SNAPSHOT_TOTAL_QUOTA_BYTES,
  SKILL_SNAPSHOT_TTL_MS,
} from '@/config/skill-security-config';
import { isSystemDirectory } from '@/config/system-directories';
import { SKILL_ARTIFACT_MAX_SIZE } from '@/lib/skills';
import {
  SkillFetchError,
  SkillFetchErrorCode,
  computeSha256Hex,
  digestMatches,
} from '@/lib/skills/integrity';

// =============================================================================
// Types
// =============================================================================

/** Artifact bytes to snapshot, together with the coordinates they are bound to. */
export interface SkillSnapshotInput {
  skillId: string;
  version: string;
  /** Resolved 40-hex commit the version was published from. */
  commit: string;
  /** Lowercase hex SHA-256 the Catalog declared. Re-verified before storing. */
  sha256: string;
  bytes: Uint8Array;
}

/** What a consumer may know about a snapshot. Deliberately carries no path. */
export interface SkillSnapshotHandle {
  /** Opaque identifier. Safe to return from an API or write to a log. */
  snapshotId: string;
  skillId: string;
  version: string;
  commit: string;
  sha256: string;
  size: number;
  /** Epoch milliseconds after which an unreferenced snapshot may be swept. */
  expiresAt: number;
}

interface SnapshotRecord extends SkillSnapshotHandle {
  refCount: number;
  lastAccessedAt: number;
  filename: string;
}

interface SnapshotStoreState {
  rootDir: string | null;
  records: Map<string, SnapshotRecord>;
  totalBytes: number;
}

// =============================================================================
// State
// =============================================================================

declare global {
  // eslint-disable-next-line no-var -- globalThis cache pattern for hot-reload persistence (version-checker.ts precedent)
  var __skillSnapshotStore: SnapshotStoreState | undefined;
}

const state: SnapshotStoreState =
  globalThis.__skillSnapshotStore ??
  (globalThis.__skillSnapshotStore = { rootDir: null, records: new Map(), totalBytes: 0 });

const SNAPSHOT_FILE_SUFFIX = '.artifact';

// =============================================================================
// Initialization
// =============================================================================

function resolveDefaultRoot(): string {
  return path.join(getConfigDir(), 'data', SKILL_SNAPSHOT_DIRNAME);
}

/**
 * Prepare the snapshot root and drop anything left behind by a previous process.
 *
 * Repeated calls with the same root are no-ops so a warm store is not wiped by
 * a second consumer initializing lazily.
 *
 * @param options.rootDir Override for tests and for callers that own their data root
 * @returns The resolved snapshot root
 * @throws SkillFetchError with `STORE_IO`
 */
export function initSkillSnapshotStore(options: { rootDir?: string } = {}): string {
  const rootDir = path.resolve(options.rootDir ?? resolveDefaultRoot());

  if (isSystemDirectory(rootDir)) {
    throw new SkillFetchError(SkillFetchErrorCode.STORE_IO, { reason: 'system-directory' });
  }
  if (state.rootDir === rootDir) return rootDir;

  try {
    mkdirSync(rootDir, { recursive: true, mode: SKILL_SNAPSHOT_DIR_MODE });
    chmodSync(rootDir, SKILL_SNAPSHOT_DIR_MODE);
  } catch {
    throw new SkillFetchError(SkillFetchErrorCode.STORE_IO, { reason: 'mkdir' });
  }

  state.rootDir = rootDir;
  state.records.clear();
  state.totalBytes = 0;
  purgeOrphanFiles();
  return rootDir;
}

function requireRoot(): string {
  if (!state.rootDir) throw new SkillFetchError(SkillFetchErrorCode.STORE_UNINITIALIZED);
  return state.rootDir;
}

/** Remove every snapshot file the in-memory index does not account for. */
function purgeOrphanFiles(): void {
  const rootDir = requireRoot();
  const tracked = new Set([...state.records.values()].map((record) => record.filename));
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    throw new SkillFetchError(SkillFetchErrorCode.STORE_IO, { reason: 'readdir' });
  }
  for (const entry of entries) {
    if (tracked.has(entry)) continue;
    rmSync(path.join(rootDir, entry), { force: true, recursive: true });
  }
}

// =============================================================================
// Internals
// =============================================================================

function filePathOf(record: SnapshotRecord): string {
  return path.join(requireRoot(), record.filename);
}

function removeRecord(record: SnapshotRecord): void {
  rmSync(filePathOf(record), { force: true });
  state.records.delete(record.snapshotId);
  state.totalBytes -= record.size;
}

function requireRecord(snapshotId: string): SnapshotRecord {
  requireRoot();
  if (!SKILL_SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new SkillFetchError(SkillFetchErrorCode.SNAPSHOT_NOT_FOUND);
  }
  const record = state.records.get(snapshotId);
  if (!record) throw new SkillFetchError(SkillFetchErrorCode.SNAPSHOT_NOT_FOUND);
  if (record.refCount === 0 && Date.now() >= record.expiresAt) {
    removeRecord(record);
    throw new SkillFetchError(SkillFetchErrorCode.SNAPSHOT_EXPIRED);
  }
  return record;
}

function toHandle(record: SnapshotRecord): SkillSnapshotHandle {
  return {
    snapshotId: record.snapshotId,
    skillId: record.skillId,
    version: record.version,
    commit: record.commit,
    sha256: record.sha256,
    size: record.size,
    expiresAt: record.expiresAt,
  };
}

function touch(record: SnapshotRecord, now: number): void {
  record.lastAccessedAt = now;
  record.expiresAt = now + SKILL_SNAPSHOT_TTL_MS;
}

/**
 * Free space for an incoming snapshot by evicting unreferenced ones.
 *
 * Expired entries go first, then least-recently-used. Referenced snapshots are
 * never candidates, so a full store rejects the newcomer instead.
 */
function makeRoomFor(size: number, now: number): void {
  const fits = (): boolean =>
    state.totalBytes + size <= SKILL_SNAPSHOT_TOTAL_QUOTA_BYTES &&
    state.records.size < SKILL_SNAPSHOT_MAX_COUNT;

  if (fits()) return;

  const candidates = [...state.records.values()]
    .filter((record) => record.refCount === 0)
    .sort((a, b) => {
      const aExpired = now >= a.expiresAt ? 0 : 1;
      const bExpired = now >= b.expiresAt ? 0 : 1;
      if (aExpired !== bExpired) return aExpired - bExpired;
      return a.lastAccessedAt - b.lastAccessedAt;
    });

  for (const candidate of candidates) {
    if (fits()) return;
    removeRecord(candidate);
  }

  if (!fits()) {
    throw new SkillFetchError(SkillFetchErrorCode.QUOTA_EXCEEDED, {
      requested: size,
      limit: SKILL_SNAPSHOT_TOTAL_QUOTA_BYTES,
    });
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Store verified artifact bytes as a read-only snapshot with one reference held.
 *
 * The digest is recomputed here rather than trusted from the downloader: this
 * is the last point before bytes become readable by another module, and bytes
 * that do not match the Catalog must never become visible as a snapshot.
 *
 * Bytes already snapshotted under the same digest are shared: the existing
 * snapshot gains a reference and no second copy is written.
 *
 * @throws SkillFetchError — `CHECKSUM_MISMATCH`, `QUOTA_EXCEEDED`, `STORE_IO`
 */
export function createSkillSnapshot(input: SkillSnapshotInput): SkillSnapshotHandle {
  const rootDir = requireRoot();
  const now = Date.now();
  const size = input.bytes.byteLength;

  if (size <= 0 || size > SKILL_ARTIFACT_MAX_SIZE) {
    throw new SkillFetchError(SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED, {
      limit: SKILL_ARTIFACT_MAX_SIZE,
    });
  }
  if (!digestMatches(input.sha256, computeSha256Hex(input.bytes))) {
    throw new SkillFetchError(SkillFetchErrorCode.CHECKSUM_MISMATCH);
  }

  for (const record of state.records.values()) {
    if (record.sha256 === input.sha256 && existsSync(filePathOf(record))) {
      record.refCount += 1;
      touch(record, now);
      return toHandle(record);
    }
  }

  makeRoomFor(size, now);

  const snapshotId = randomBytes(SKILL_SNAPSHOT_ID_BYTES).toString('hex');
  const filename = `${snapshotId}${SNAPSHOT_FILE_SUFFIX}`;
  const finalPath = path.join(rootDir, filename);
  const stagingPath = `${finalPath}.tmp`;

  try {
    writeFileSync(stagingPath, input.bytes, { mode: 0o600 });
    chmodSync(stagingPath, SKILL_SNAPSHOT_FILE_MODE);
    renameSync(stagingPath, finalPath);
  } catch {
    rmSync(stagingPath, { force: true });
    throw new SkillFetchError(SkillFetchErrorCode.STORE_IO, { reason: 'write' });
  }

  const record: SnapshotRecord = {
    snapshotId,
    skillId: input.skillId,
    version: input.version,
    commit: input.commit,
    sha256: input.sha256,
    size,
    expiresAt: now + SKILL_SNAPSHOT_TTL_MS,
    refCount: 1,
    lastAccessedAt: now,
    filename,
  };
  state.records.set(snapshotId, record);
  state.totalBytes += size;
  return toHandle(record);
}

/** Take an additional reference, extending the TTL. */
export function acquireSkillSnapshot(snapshotId: string): SkillSnapshotHandle {
  const record = requireRecord(snapshotId);
  record.refCount += 1;
  touch(record, Date.now());
  return toHandle(record);
}

/**
 * Drop one reference.
 *
 * The bytes stay until the TTL elapses or quota pressure evicts them, so a
 * retry right after a failed install does not have to re-download. Releasing an
 * unknown ID is a no-op: cleanup paths must be safe to run twice.
 */
export function releaseSkillSnapshot(snapshotId: string): void {
  const record = state.records.get(snapshotId);
  if (!record) return;
  if (record.refCount > 0) record.refCount -= 1;
  if (record.refCount === 0) record.lastAccessedAt = Date.now();
}

/** Read a snapshot's metadata without taking a reference. */
export function getSkillSnapshot(snapshotId: string): SkillSnapshotHandle {
  return toHandle(requireRecord(snapshotId));
}

/** Read the snapshot bytes. */
export function readSkillSnapshotBytes(snapshotId: string): Uint8Array {
  const record = requireRecord(snapshotId);
  try {
    const bytes = readFileSync(filePathOf(record));
    record.lastAccessedAt = Date.now();
    return bytes;
  } catch {
    throw new SkillFetchError(SkillFetchErrorCode.STORE_IO, { reason: 'read' });
  }
}

/**
 * Absolute path of a snapshot file.
 *
 * For modules that must hand a path to a streaming reader (#1230 extraction).
 * The result identifies the machine's data root and must never reach an API
 * response, a log line or an error message.
 *
 * @internal
 */
export function resolveSkillSnapshotPath(snapshotId: string): string {
  return filePathOf(requireRecord(snapshotId));
}

/**
 * Remove expired, unreferenced snapshots and any untracked file in the root.
 *
 * @returns Number of snapshots removed
 */
export function sweepSkillSnapshots(): number {
  requireRoot();
  const now = Date.now();
  let removed = 0;
  for (const record of [...state.records.values()]) {
    if (record.refCount === 0 && now >= record.expiresAt) {
      removeRecord(record);
      removed += 1;
    }
  }
  purgeOrphanFiles();
  return removed;
}

/** Current disk usage in bytes, for quota assertions and diagnostics. */
export function getSkillSnapshotUsage(): { totalBytes: number; count: number } {
  return { totalBytes: state.totalBytes, count: state.records.size };
}

/**
 * Drop every snapshot and forget the root.
 * @internal
 */
export function resetSkillSnapshotStoreForTesting(): void {
  if (state.rootDir && existsSync(state.rootDir)) {
    for (const record of [...state.records.values()]) {
      rmSync(path.join(state.rootDir, record.filename), { force: true });
    }
  }
  state.rootDir = null;
  state.records.clear();
  state.totalBytes = 0;
}
