/**
 * Issue #1234: crash reconciliation converges every operation on one answer.
 *
 * The interesting cases are the ones where the DB and the filesystem disagree:
 * a payload that landed before the process died must end up SUCCEEDED, not
 * reported as a failure the user can see is untrue on disk.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  acquireSkillOperationLock,
  buildSkillOperationLockKey,
  readSkillOperationLock,
} from '@/lib/skills/operation-lock';
import {
  beginSkillOperation,
  readSkillOperationJournal,
  transitionSkillOperation,
  type SkillOperationBinding,
  type SkillOperationJournalEntry,
} from '@/lib/skills/operation-journal';
import {
  reconcileSkillOperations,
  type SkillReconcilerPorts,
} from '@/lib/skills/operation-reconciler';

let root: string;
const T0 = 1_800_000_000_000;
const LOCK_KEY = buildSkillOperationLockKey('/srv/wt-1', 'demo-skill');

const BINDING: SkillOperationBinding = {
  actor: { type: 'user', id: 'user-1' },
  operation: 'install',
  target: { worktreeId: 'wt-1', skillId: 'demo-skill', version: '1.2.3' },
  planHash: 'a'.repeat(64),
};

function makePorts(overrides: Partial<SkillReconcilerPorts> = {}): SkillReconcilerPorts {
  return {
    hasCommittedPayload: vi.fn(() => false),
    reindex: vi.fn(),
    recordAudit: vi.fn(),
    ...overrides,
  };
}

function start(key: string, binding = BINDING): SkillOperationJournalEntry {
  const result = beginSkillOperation(
    { idempotencyKey: key, binding, lockKey: LOCK_KEY },
    { root, now: T0 }
  );
  if (!result.ok) throw new Error('failed to open journal entry');
  return result.entry;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-skill-reconcile-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('convergence after a crash', () => {
  it('drives a committed-but-unindexed operation to SUCCEEDED', () => {
    const entry = start('k1');
    transitionSkillOperation(entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    const ports = makePorts();

    const report = reconcileSkillOperations(ports, { root, now: T0 + 100 });

    expect(report.converged).toBe(1);
    expect(report.outcomes[0].action).toBe('CONVERGED_SUCCEEDED');
    expect(readSkillOperationJournal('k1', { root })?.state).toBe('SUCCEEDED');
    expect(ports.reindex).toHaveBeenCalledTimes(1);
    // The commit point is authoritative: no filesystem probe is needed.
    expect(ports.hasCommittedPayload).not.toHaveBeenCalled();
  });

  it('recovers a FAILED_RECONCILABLE that had already committed', () => {
    // The DB write failed after the atomic rename. The install is real.
    const entry = start('k1');
    const committed = transitionSkillOperation(entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    transitionSkillOperation(
      committed,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_INDEX_FAILED', message: 'database is locked' } },
      { root, now: T0 + 2 }
    );

    const ports = makePorts();
    const report = reconcileSkillOperations(ports, { root, now: T0 + 100 });

    expect(report.outcomes[0].action).toBe('CONVERGED_SUCCEEDED');
    const final = readSkillOperationJournal('k1', { root });
    expect(final?.state).toBe('SUCCEEDED');
    expect(final?.error).toBeNull();
  });

  it('promotes a PREPARING entry whose rename landed before the crash', () => {
    start('k1');
    const ports = makePorts({ hasCommittedPayload: vi.fn(() => true) });

    reconcileSkillOperations(ports, { root, now: T0 + 100 });

    const final = readSkillOperationJournal('k1', { root });
    expect(final?.state).toBe('SUCCEEDED');
    expect(final?.fsCommittedAt).toBe(T0 + 100);
    expect(final?.history.map((h) => h.state)).toEqual([
      'PREPARING',
      'FS_COMMITTED',
      'INDEXED',
      'SUCCEEDED',
    ]);
  });

  it('marks a PREPARING entry with no payload as rolled back', () => {
    start('k1');
    const ports = makePorts();

    const report = reconcileSkillOperations(ports, { root, now: T0 + 100 });

    expect(report.outcomes[0].action).toBe('CONVERGED_FAILED');
    const final = readSkillOperationJournal('k1', { root });
    expect(final?.state).toBe('FAILED_RECONCILABLE');
    expect(final?.error?.code).toBe('SKILL_OPERATION_ROLLED_BACK');
    expect(ports.reindex).not.toHaveBeenCalled();
  });

  it('leaves the entry reconcilable when the index replay itself fails', () => {
    const entry = start('k1');
    transitionSkillOperation(entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    const ports = makePorts({
      reindex: vi.fn(() => {
        throw new Error('database is locked');
      }),
    });

    const report = reconcileSkillOperations(ports, { root, now: T0 + 100 });

    expect(report.outcomes[0].action).toBe('RECONCILE_FAILED');
    const final = readSkillOperationJournal('k1', { root });
    expect(final?.state).toBe('FAILED_RECONCILABLE');
    expect(final?.fsCommittedAt).toBe(T0 + 1);
    expect(final?.error?.code).toBe('SKILL_RECONCILE_FAILED');
  });

  it('is idempotent: a second pass does nothing', () => {
    const entry = start('k1');
    transitionSkillOperation(entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });

    reconcileSkillOperations(makePorts(), { root, now: T0 + 100 });
    const ports = makePorts();
    const second = reconcileSkillOperations(ports, { root, now: T0 + 200 });

    expect(second.outcomes[0].action).toBe('SKIPPED_TERMINAL');
    expect(ports.reindex).not.toHaveBeenCalled();
    expect(ports.recordAudit).not.toHaveBeenCalled();
  });

  it('leaves a pre-commit failure terminal without re-auditing it', () => {
    const entry = start('k1');
    transitionSkillOperation(
      entry,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_DOWNLOAD_FAILED', message: 'connection reset' } },
      { root, now: T0 + 1 }
    );

    const ports = makePorts();
    const report = reconcileSkillOperations(ports, { root, now: T0 + 100 });

    expect(report.outcomes[0].action).toBe('SKIPPED_TERMINAL');
    expect(ports.recordAudit).not.toHaveBeenCalled();
  });
});

describe('reconciliation respects running operations', () => {
  it('skips an entry whose lock is still held by a live owner', () => {
    const entry = start('k1');
    acquireSkillOperationLock(
      { key: LOCK_KEY, operationId: entry.operationId },
      { root, now: T0 }
    );

    const ports = makePorts();
    const report = reconcileSkillOperations(ports, {
      root,
      now: T0 + 1_000,
      isProcessAlive: () => true,
    });

    expect(report.outcomes[0].action).toBe('SKIPPED_LOCK_HELD');
    expect(readSkillOperationJournal('k1', { root })?.state).toBe('PREPARING');
    expect(ports.hasCommittedPayload).not.toHaveBeenCalled();
  });

  it('does not release a lock whose owner is still alive', () => {
    const entry = start('k1');
    acquireSkillOperationLock(
      { key: LOCK_KEY, operationId: entry.operationId },
      { root, now: T0 }
    );

    const report = reconcileSkillOperations(makePorts(), {
      root,
      now: T0 + 1_000,
      isProcessAlive: () => true,
    });

    expect(report.orphanLocksReleased).toEqual([]);
    expect(readSkillOperationLock(LOCK_KEY, { root })).not.toBeNull();
  });

  it('releases an orphaned lock once the operation converged', () => {
    const entry = start('k1');
    acquireSkillOperationLock(
      { key: LOCK_KEY, operationId: entry.operationId },
      { root, now: T0 }
    );

    const report = reconcileSkillOperations(makePorts({ hasCommittedPayload: () => true }), {
      root,
      now: T0 + 10 * 60_000,
      isProcessAlive: () => false,
    });

    expect(report.orphanLocksReleased).toEqual([LOCK_KEY]);
    expect(readSkillOperationLock(LOCK_KEY, { root })).toBeNull();
    expect(readSkillOperationJournal('k1', { root })?.state).toBe('SUCCEEDED');
  });
});

describe('audit is emitted for every converged outcome', () => {
  it('records a reconciled result carrying the actor and target', () => {
    const entry = start('k1');
    transitionSkillOperation(entry, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    const recordAudit = vi.fn();

    reconcileSkillOperations(makePorts({ recordAudit }), { root, now: T0 + 100 });

    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0][0]).toMatchObject({
      operationId: entry.operationId,
      operation: 'install',
      result: 'reconciled',
      state: 'SUCCEEDED',
      actorType: 'user',
      actorId: 'user-1',
      worktreeId: 'wt-1',
      skillId: 'demo-skill',
    });
  });

  it('reconciles several entries in one pass', () => {
    const a = start('k1');
    transitionSkillOperation(a, 'FS_COMMITTED', {}, { root, now: T0 + 1 });
    start('k2', { ...BINDING, planHash: 'b'.repeat(64) });

    const report = reconcileSkillOperations(makePorts(), { root, now: T0 + 100 });

    expect(report.scanned).toBe(2);
    expect(report.converged).toBe(1);
    expect(report.failed).toBe(1);
  });
});
