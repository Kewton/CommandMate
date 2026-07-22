/**
 * Issue #1234: lock + journal + audit + reconciliation against a real database.
 *
 * Exercises the flows that only show up when the three stores are wired
 * together: a crash between the filesystem commit and the DB write, a replayed
 * request, and a concurrent request for the same target.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  acquireSkillOperationLock,
  buildSkillOperationLockKey,
  readSkillOperationLock,
  releaseSkillOperationLock,
  type SkillOperationLockRecord,
} from '@/lib/skills/operation-lock';
import {
  beginSkillOperation,
  readSkillOperationJournal,
  transitionSkillOperation,
  type SkillOperationBinding,
  type SkillOperationJournalEntry,
} from '@/lib/skills/operation-journal';
import {
  buildSkillOperationAuditInput,
  getSkillOperationAuditByOperationId,
  listSkillOperationAudit,
  recordSkillOperationAudit,
} from '@/lib/skills/operation-audit';
import { reconcileSkillOperations } from '@/lib/skills/operation-reconciler';

let db: Database.Database;
let root: string;

const T0 = 1_800_000_000_000;
const WORKTREE_PATH = '/srv/worktrees/wt-1';
const SKILL_ID = 'demo-skill';
const LOCK_KEY = buildSkillOperationLockKey(WORKTREE_PATH, SKILL_ID);

const BINDING: SkillOperationBinding = {
  actor: { type: 'user', id: 'user-1' },
  operation: 'install',
  target: { worktreeId: 'wt-1', skillId: SKILL_ID, version: '1.2.3' },
  planHash: 'a'.repeat(64),
};

const SOURCE = {
  origin: 'github-release',
  repository: 'Kewton/commandmate-skills',
  ref: 'demo-skill-v1.2.3',
  commit: 'b'.repeat(40),
  artifactSha256: 'c'.repeat(64),
};

/** Payload files that "exist" on disk, keyed by operationId. */
let committedPayloads: Set<string>;
/** Index rows the install layer would own, keyed by `${worktreeId}/${skillId}`. */
let installedIndex: Map<string, string>;

function ports() {
  return {
    hasCommittedPayload: (entry: SkillOperationJournalEntry) =>
      committedPayloads.has(entry.operationId),
    reindex: (entry: SkillOperationJournalEntry) => {
      installedIndex.set(
        `${entry.target.worktreeId}/${entry.target.skillId}`,
        entry.target.version ?? ''
      );
    },
    recordAudit: (input: Parameters<typeof recordSkillOperationAudit>[1]) => {
      recordSkillOperationAudit(db, input);
    },
  };
}

function start(idempotencyKey: string, binding = BINDING) {
  return beginSkillOperation(
    { idempotencyKey, binding, lockKey: LOCK_KEY, source: SOURCE },
    { root, now: T0 }
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  root = mkdtempSync(join(tmpdir(), 'cm-skill-op-state-'));
  committedPayloads = new Set();
  installedIndex = new Map();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('a completed operation is audited with its provenance', () => {
  it('records source, actor and result on success', () => {
    const started = start('key-1');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const lock = acquireSkillOperationLock(
      { key: LOCK_KEY, operationId: started.entry.operationId },
      { root, now: T0 }
    );
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;

    let entry = transitionSkillOperation(started.entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    committedPayloads.add(entry.operationId);
    ports().reindex(entry);
    entry = transitionSkillOperation(entry, 'INDEXED', {}, { root, now: T0 + 2 });
    entry = transitionSkillOperation(entry, 'SUCCEEDED', {}, { root, now: T0 + 3 });
    recordSkillOperationAudit(db, buildSkillOperationAuditInput(entry, 'succeeded', T0 + 3));
    releaseSkillOperationLock(lock.lock, { root });

    const audit = listSkillOperationAudit(db, { worktreeId: 'wt-1', skillId: SKILL_ID });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation: 'install',
      result: 'succeeded',
      state: 'SUCCEEDED',
      actorType: 'user',
      actorId: 'user-1',
      skillVersion: '1.2.3',
      sourceOrigin: 'github-release',
      sourceRepository: 'Kewton/commandmate-skills',
      sourceRef: 'demo-skill-v1.2.3',
      sourceCommit: 'b'.repeat(40),
      artifactSha256: 'c'.repeat(64),
      errorCode: null,
    });
  });

  it('redacts a signed URL out of a failure before it reaches the table', () => {
    const started = start('key-1');
    if (!started.ok) return;
    const failed = transitionSkillOperation(
      started.entry,
      'FAILED_RECONCILABLE',
      {
        error: {
          code: 'SKILL_DOWNLOAD_FAILED',
          message: 'GET https://objects.example.com/a.tar.gz?X-Amz-Signature=abc123 failed',
        },
      },
      { root, now: T0 + 1 }
    );
    recordSkillOperationAudit(db, buildSkillOperationAuditInput(failed, 'failed', T0 + 1));

    const [row] = listSkillOperationAudit(db, { worktreeId: 'wt-1' });
    expect(row.errorCode).toBe('SKILL_DOWNLOAD_FAILED');
    expect(row.errorMessage).not.toContain('X-Amz-Signature');
    expect(row.errorMessage).not.toContain('abc123');
  });
});

describe('a crash after the filesystem commit converges to SUCCEEDED', () => {
  it('reconstructs the index from the receipt rather than reporting a rollback', () => {
    const started = start('key-1');
    if (!started.ok) return;
    const lock = acquireSkillOperationLock(
      { key: LOCK_KEY, operationId: started.entry.operationId },
      { root, now: T0 }
    );
    expect(lock.ok).toBe(true);

    // Rename landed, then the DB write threw and the process died.
    const committed = transitionSkillOperation(
      started.entry,
      'FS_COMMITTED',
      { receiptDigest: 'd'.repeat(64) },
      { root, now: T0 + 1 }
    );
    committedPayloads.add(committed.operationId);
    transitionSkillOperation(
      committed,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_INDEX_FAILED', message: 'database is locked' } },
      { root, now: T0 + 2 }
    );
    expect(installedIndex.size).toBe(0);

    // Restart: the lock owner is gone and its lease has lapsed.
    const report = reconcileSkillOperations(ports(), {
      root,
      now: T0 + 60 * 60_000,
      isProcessAlive: () => false,
    });

    expect(report.converged).toBe(1);
    expect(readSkillOperationJournal('key-1', { root })?.state).toBe('SUCCEEDED');
    expect(installedIndex.get('wt-1/demo-skill')).toBe('1.2.3');
    expect(report.orphanLocksReleased).toEqual([LOCK_KEY]);
    expect(readSkillOperationLock(LOCK_KEY, { root })).toBeNull();

    const trail = getSkillOperationAuditByOperationId(db, started.entry.operationId);
    expect(trail.map((r) => r.result)).toEqual(['reconciled']);
    expect(trail[0].state).toBe('SUCCEEDED');
  });

  it('reports a genuinely rolled back operation as failed', () => {
    const started = start('key-1');
    if (!started.ok) return;

    const report = reconcileSkillOperations(ports(), {
      root,
      now: T0 + 60 * 60_000,
      isProcessAlive: () => false,
    });

    expect(report.failed).toBe(1);
    expect(readSkillOperationJournal('key-1', { root })?.state).toBe('FAILED_RECONCILABLE');
    expect(installedIndex.size).toBe(0);
    const trail = getSkillOperationAuditByOperationId(db, started.entry.operationId);
    expect(trail[0].result).toBe('failed');
    expect(trail[0].errorCode).toBe('SKILL_OPERATION_ROLLED_BACK');
  });

  it('appends rather than rewriting when an operation is audited twice', () => {
    const started = start('key-1');
    if (!started.ok) return;
    const failed = transitionSkillOperation(
      started.entry,
      'FS_COMMITTED',
      {},
      { root, now: T0 + 1 }
    );
    committedPayloads.add(failed.operationId);
    const reconcilable = transitionSkillOperation(
      failed,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_INDEX_FAILED', message: 'database is locked' } },
      { root, now: T0 + 2 }
    );
    recordSkillOperationAudit(db, buildSkillOperationAuditInput(reconcilable, 'failed', T0 + 2));

    reconcileSkillOperations(ports(), { root, now: T0 + 60 * 60_000, isProcessAlive: () => false });

    const trail = getSkillOperationAuditByOperationId(db, started.entry.operationId);
    expect(trail.map((r) => r.result)).toEqual(['failed', 'reconciled']);
  });
});

describe('idempotent replay does not duplicate payload writes', () => {
  it('returns the recorded operation instead of installing twice', () => {
    const first = start('key-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let installs = 0;
    const install = (entry: SkillOperationJournalEntry) => {
      installs += 1;
      committedPayloads.add(entry.operationId);
      return transitionSkillOperation(entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    };

    let entry = install(first.entry);
    ports().reindex(entry);
    entry = transitionSkillOperation(entry, 'INDEXED', {}, { root, now: T0 + 2 });
    entry = transitionSkillOperation(entry, 'SUCCEEDED', {}, { root, now: T0 + 3 });
    recordSkillOperationAudit(db, buildSkillOperationAuditInput(entry, 'succeeded', T0 + 3));

    // The client retried the same request after a timeout.
    const replay = start('key-1');
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replayed).toBe(true);
    expect(replay.entry.operationId).toBe(first.entry.operationId);
    expect(replay.entry.state).toBe('SUCCEEDED');

    expect(installs).toBe(1);
    expect(listSkillOperationAudit(db, { worktreeId: 'wt-1' })).toHaveLength(1);
  });

  it('refuses a reused key that carries a different plan', () => {
    start('key-1');
    const drifted = beginSkillOperation(
      {
        idempotencyKey: 'key-1',
        binding: { ...BINDING, planHash: 'e'.repeat(64) },
        lockKey: LOCK_KEY,
      },
      { root, now: T0 + 10 }
    );
    expect(drifted.ok).toBe(false);
    if (drifted.ok) return;
    expect(drifted.reason).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});

describe('concurrent operations on the same target', () => {
  let firstLock: SkillOperationLockRecord;

  beforeEach(() => {
    const started = start('key-1');
    if (!started.ok) throw new Error('journal entry not created');
    const acquired = acquireSkillOperationLock(
      { key: LOCK_KEY, operationId: started.entry.operationId },
      { root, now: T0 }
    );
    if (!acquired.ok) throw new Error('lock not acquired');
    firstLock = acquired.lock;
  });

  it('rejects a second operation with a retryable reason', () => {
    const second = acquireSkillOperationLock(
      { key: LOCK_KEY, operationId: 'op-2' },
      { root, now: T0 + 1_000 }
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('HELD');
    expect(second.heldBy?.leaseExpiresAt).toBe(firstLock.leaseExpiresAt);
  });

  it('lets the next operation through once the owner releases', () => {
    expect(releaseSkillOperationLock(firstLock, { root })).toBe(true);
    const second = acquireSkillOperationLock(
      { key: LOCK_KEY, operationId: 'op-2' },
      { root, now: T0 + 1_000 }
    );
    expect(second.ok).toBe(true);
  });

  it('does not lock out a different Skill in the same worktree', () => {
    const otherKey = buildSkillOperationLockKey(WORKTREE_PATH, 'another-skill');
    const other = acquireSkillOperationLock(
      { key: otherKey, operationId: 'op-3' },
      { root, now: T0 + 1 }
    );
    expect(other.ok).toBe(true);
  });

  it('leaves a running operation untouched during reconciliation', () => {
    const report = reconcileSkillOperations(ports(), {
      root,
      now: T0 + 1_000,
      isProcessAlive: () => true,
    });
    expect(report.outcomes[0].action).toBe('SKIPPED_LOCK_HELD');
    expect(readSkillOperationLock(LOCK_KEY, { root })?.owner.nonce).toBe(firstLock.owner.nonce);
    expect(listSkillOperationAudit(db, { worktreeId: 'wt-1' })).toHaveLength(0);
  });
});
