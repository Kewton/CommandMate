/**
 * Tests for src/lib/skills/snapshot-store.ts
 * Issue #1229: read-only snapshots with TTL, reference counting and quota
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import {
  SKILL_SNAPSHOT_ID_PATTERN,
  SKILL_SNAPSHOT_MAX_COUNT,
  SKILL_SNAPSHOT_TTL_MS,
} from '@/config/skill-security-config';
import { SkillFetchError, SkillFetchErrorCode } from '@/lib/skills/integrity';
import {
  acquireSkillSnapshot,
  createSkillSnapshot,
  getSkillSnapshot,
  getSkillSnapshotUsage,
  initSkillSnapshotStore,
  readSkillSnapshotBytes,
  releaseSkillSnapshot,
  resetSkillSnapshotStoreForTesting,
  resolveSkillSnapshotPath,
  sweepSkillSnapshots,
} from '@/lib/skills/snapshot-store';
import { ARTIFACT_BYTES, ARTIFACT_SHA256, COMMIT, SKILL_ID } from './fixtures';

/**
 * The store refuses system directories, and os.tmpdir() resolves under /var on
 * macOS, so test roots live in the repo-local (gitignored) temp directory.
 */
const TEST_ROOT_PARENT = path.join(process.cwd(), 'temp');

let rootDir: string;

function snapshotInput(bytes: Uint8Array = ARTIFACT_BYTES) {
  return {
    skillId: SKILL_ID,
    version: '1.2.3',
    commit: COMMIT,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function expectFetchError(run: () => unknown, code: string): SkillFetchError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SkillFetchError);
    expect((error as SkillFetchError).code).toBe(code);
    return error as SkillFetchError;
  }
  throw new Error(`expected throw with ${code}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
  mkdirSync(TEST_ROOT_PARENT, { recursive: true });
  rootDir = mkdtempSync(path.join(TEST_ROOT_PARENT, 'skill-snapshots-'));
  initSkillSnapshotStore({ rootDir });
});

afterEach(() => {
  resetSkillSnapshotStoreForTesting();
  rmSync(rootDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('initSkillSnapshotStore', () => {
  it('creates a service-owned root that is not group or world readable', () => {
    expect(existsSync(rootDir)).toBe(true);
    expect(statSync(rootDir).mode & 0o077).toBe(0);
  });

  it('removes files left behind by a previous process', () => {
    resetSkillSnapshotStoreForTesting();
    writeFileSync(path.join(rootDir, 'orphan.artifact'), 'left over');

    initSkillSnapshotStore({ rootDir });

    expect(readdirSync(rootDir)).toEqual([]);
  });

  it('does not wipe live snapshots when initialized again with the same root', () => {
    const handle = createSkillSnapshot(snapshotInput());

    initSkillSnapshotStore({ rootDir });

    expect(getSkillSnapshot(handle.snapshotId).sha256).toBe(ARTIFACT_SHA256);
  });

  it('refuses a system directory as the data root', () => {
    resetSkillSnapshotStoreForTesting();
    expectFetchError(
      () => initSkillSnapshotStore({ rootDir: '/etc/cm-skill-snapshots' }),
      SkillFetchErrorCode.STORE_IO
    );
  });

  it('refuses use before initialization', () => {
    resetSkillSnapshotStoreForTesting();
    expectFetchError(
      () => createSkillSnapshot(snapshotInput()),
      SkillFetchErrorCode.STORE_UNINITIALIZED
    );
  });
});

describe('createSkillSnapshot', () => {
  it('stores verified bytes behind an opaque id and exposes no path', () => {
    const handle = createSkillSnapshot(snapshotInput());

    expect(handle.snapshotId).toMatch(SKILL_SNAPSHOT_ID_PATTERN);
    expect(handle).not.toHaveProperty('path');
    expect(JSON.stringify(handle)).not.toContain(rootDir);
    expect(handle.sha256).toBe(ARTIFACT_SHA256);
    expect(handle.size).toBe(ARTIFACT_BYTES.byteLength);
    expect(handle.commit).toBe(COMMIT);
  });

  it('writes the snapshot file read-only', () => {
    const handle = createSkillSnapshot(snapshotInput());

    const mode = statSync(resolveSkillSnapshotPath(handle.snapshotId)).mode & 0o777;
    expect(mode & 0o222).toBe(0);
    expect(mode & 0o077).toBe(0);
  });

  it('returns the stored bytes verbatim', () => {
    const handle = createSkillSnapshot(snapshotInput());

    expect(Buffer.from(readSkillSnapshotBytes(handle.snapshotId)).equals(ARTIFACT_BYTES)).toBe(true);
  });

  it('never publishes bytes whose digest does not match the declared one', () => {
    expectFetchError(
      () => createSkillSnapshot({ ...snapshotInput(), sha256: 'b'.repeat(64) }),
      SkillFetchErrorCode.CHECKSUM_MISMATCH
    );

    expect(readdirSync(rootDir)).toEqual([]);
    expect(getSkillSnapshotUsage()).toEqual({ totalBytes: 0, count: 0 });
  });

  it('rejects empty bytes', () => {
    expectFetchError(
      () => createSkillSnapshot(snapshotInput(Buffer.alloc(0))),
      SkillFetchErrorCode.SIZE_LIMIT_EXCEEDED
    );
  });

  it('shares one copy between identical artifacts', () => {
    const first = createSkillSnapshot(snapshotInput());
    const second = createSkillSnapshot(snapshotInput());

    expect(second.snapshotId).toBe(first.snapshotId);
    expect(readdirSync(rootDir)).toHaveLength(1);
    expect(getSkillSnapshotUsage().count).toBe(1);
  });
});

describe('reference counting and TTL', () => {
  it('keeps a referenced snapshot past its TTL', () => {
    const handle = createSkillSnapshot(snapshotInput());

    vi.advanceTimersByTime(SKILL_SNAPSHOT_TTL_MS * 2);

    expect(sweepSkillSnapshots()).toBe(0);
    expect(getSkillSnapshot(handle.snapshotId).snapshotId).toBe(handle.snapshotId);
  });

  it('sweeps a released snapshot once the TTL elapsed', () => {
    const handle = createSkillSnapshot(snapshotInput());
    releaseSkillSnapshot(handle.snapshotId);

    expect(sweepSkillSnapshots()).toBe(0);

    vi.advanceTimersByTime(SKILL_SNAPSHOT_TTL_MS + 1);

    expect(sweepSkillSnapshots()).toBe(1);
    expect(readdirSync(rootDir)).toEqual([]);
    expect(getSkillSnapshotUsage()).toEqual({ totalBytes: 0, count: 0 });
  });

  it('requires every reference to be released before sweeping', () => {
    const handle = createSkillSnapshot(snapshotInput());
    acquireSkillSnapshot(handle.snapshotId);
    releaseSkillSnapshot(handle.snapshotId);

    vi.advanceTimersByTime(SKILL_SNAPSHOT_TTL_MS + 1);
    expect(sweepSkillSnapshots()).toBe(0);

    releaseSkillSnapshot(handle.snapshotId);
    vi.advanceTimersByTime(SKILL_SNAPSHOT_TTL_MS + 1);
    expect(sweepSkillSnapshots()).toBe(1);
  });

  it('extends the TTL on acquire', () => {
    const handle = createSkillSnapshot(snapshotInput());
    releaseSkillSnapshot(handle.snapshotId);

    vi.advanceTimersByTime(SKILL_SNAPSHOT_TTL_MS - 1);
    const reacquired = acquireSkillSnapshot(handle.snapshotId);
    expect(reacquired.expiresAt).toBe(Date.now() + SKILL_SNAPSHOT_TTL_MS);

    vi.advanceTimersByTime(SKILL_SNAPSHOT_TTL_MS + 1);
    releaseSkillSnapshot(handle.snapshotId);
    expect(sweepSkillSnapshots()).toBe(1);
  });

  it('reports an expired snapshot as expired and drops it', () => {
    const handle = createSkillSnapshot(snapshotInput());
    releaseSkillSnapshot(handle.snapshotId);
    vi.advanceTimersByTime(SKILL_SNAPSHOT_TTL_MS + 1);

    expectFetchError(
      () => getSkillSnapshot(handle.snapshotId),
      SkillFetchErrorCode.SNAPSHOT_EXPIRED
    );
    expectFetchError(
      () => getSkillSnapshot(handle.snapshotId),
      SkillFetchErrorCode.SNAPSHOT_NOT_FOUND
    );
  });

  it('treats an unknown or malformed id as not found', () => {
    expectFetchError(
      () => getSkillSnapshot(randomBytes(16).toString('hex')),
      SkillFetchErrorCode.SNAPSHOT_NOT_FOUND
    );
    expectFetchError(
      () => getSkillSnapshot('../../etc/passwd'),
      SkillFetchErrorCode.SNAPSHOT_NOT_FOUND
    );
  });

  it('tolerates releasing an unknown id so cleanup paths are safe to repeat', () => {
    expect(() => releaseSkillSnapshot('deadbeef')).not.toThrow();
  });
});

describe('quota', () => {
  function fillStore(count: number, release: boolean): string[] {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const handle = createSkillSnapshot(snapshotInput(randomBytes(32)));
      ids.push(handle.snapshotId);
      if (release) releaseSkillSnapshot(handle.snapshotId);
      vi.advanceTimersByTime(1);
    }
    return ids;
  }

  it('evicts the least recently used unreferenced snapshot at the count limit', () => {
    const ids = fillStore(SKILL_SNAPSHOT_MAX_COUNT, true);
    expect(getSkillSnapshotUsage().count).toBe(SKILL_SNAPSHOT_MAX_COUNT);

    createSkillSnapshot(snapshotInput(randomBytes(32)));

    expect(getSkillSnapshotUsage().count).toBeLessThanOrEqual(SKILL_SNAPSHOT_MAX_COUNT);
    expectFetchError(() => getSkillSnapshot(ids[0]), SkillFetchErrorCode.SNAPSHOT_NOT_FOUND);
    expect(getSkillSnapshot(ids[ids.length - 1]).snapshotId).toBe(ids[ids.length - 1]);
  });

  it('refuses a new snapshot rather than evicting one that is in use', () => {
    const ids = fillStore(SKILL_SNAPSHOT_MAX_COUNT, false);

    expectFetchError(
      () => createSkillSnapshot(snapshotInput(randomBytes(32))),
      SkillFetchErrorCode.QUOTA_EXCEEDED
    );

    for (const id of ids) {
      expect(getSkillSnapshot(id).snapshotId).toBe(id);
    }
  });
});

describe('resolveSkillSnapshotPath', () => {
  it('stays inside the snapshot root', () => {
    const handle = createSkillSnapshot(snapshotInput());
    const filePath = resolveSkillSnapshotPath(handle.snapshotId);

    expect(path.dirname(filePath)).toBe(rootDir);
    expect(path.basename(filePath).startsWith(handle.snapshotId)).toBe(true);
  });

  it('refuses to resolve a released and expired snapshot', () => {
    const handle = createSkillSnapshot(snapshotInput());
    releaseSkillSnapshot(handle.snapshotId);
    vi.advanceTimersByTime(SKILL_SNAPSHOT_TTL_MS + 1);

    expectFetchError(
      () => resolveSkillSnapshotPath(handle.snapshotId),
      SkillFetchErrorCode.SNAPSHOT_EXPIRED
    );
  });
});
