/**
 * Crash reconciliation for Skill operations (Issue #1234)
 *
 * Runs at startup and on demand. For every journal entry that is not terminal
 * it asks one question — *did the payload actually land?* — and drives the entry
 * to the answer the filesystem already gave:
 *
 * - payload present  → replay the index step, converge on SUCCEEDED
 * - payload absent   → FAILED_RECONCILABLE, the operation is genuinely undone
 *
 * The DB is never treated as the source of truth: an operation that committed
 * to the filesystem and then lost its DB write is *installed*, and reporting it
 * as failed would be a lie the user could see on disk.
 *
 * Payload probing and index rebuilding are injected ports, because this issue
 * deliberately does not implement payload installation (#1235 owns that).
 *
 * @module lib/skills/operation-reconciler
 */

import {
  evaluateSkillLock,
  readSkillOperationLock,
  releaseOrphanSkillLocks,
  type SkillLockOptions,
} from '@/lib/skills/operation-lock';
import {
  hasSkillFilesystemCommit,
  isSkillOperationTerminal,
  listSkillOperationJournal,
  transitionSkillOperation,
  type SkillOperationJournalEntry,
  type SkillOperationState,
} from '@/lib/skills/operation-journal';
import {
  buildSkillOperationAuditInput,
  type SkillOperationAuditInput,
} from '@/lib/skills/operation-audit';

/** Capabilities the reconciler needs from the layers that own the filesystem and the index. */
export interface SkillReconcilerPorts {
  /**
   * Whether the committed payload for this operation is present on disk.
   * Implemented by the install layer (#1235) against the receipt.
   */
  hasCommittedPayload: (entry: SkillOperationJournalEntry) => boolean;
  /**
   * Rebuild the index/DB rows for a committed operation. Must be idempotent:
   * reconciliation may call it after a partially successful earlier attempt.
   */
  reindex: (entry: SkillOperationJournalEntry) => void;
  /** Append one audit event. */
  recordAudit: (input: SkillOperationAuditInput) => void;
}

/** What reconciliation did to one entry. */
export type SkillReconcileAction =
  /** Already terminal; nothing to do. */
  | 'SKIPPED_TERMINAL'
  /** A live owner still holds the lock, so the operation is still running. */
  | 'SKIPPED_LOCK_HELD'
  /** Converged forward to SUCCEEDED from the receipt. */
  | 'CONVERGED_SUCCEEDED'
  /** No payload on disk: the operation is genuinely undone. */
  | 'CONVERGED_FAILED'
  /** The index replay itself failed; the entry stays reconcilable. */
  | 'RECONCILE_FAILED';

export interface SkillReconcileOutcome {
  operationId: string;
  idempotencyKey: string;
  from: SkillOperationState;
  to: SkillOperationState;
  action: SkillReconcileAction;
}

export interface SkillReconcileReport {
  scanned: number;
  converged: number;
  failed: number;
  skipped: number;
  orphanLocksReleased: string[];
  outcomes: SkillReconcileOutcome[];
}

export interface SkillReconcileOptions extends SkillLockOptions {
  /** Skip orphan lock cleanup (on-demand reconciliation of a single flow). */
  skipOrphanLocks?: boolean;
}

function toError(error: unknown): { code: string; message: string } {
  return {
    code: 'SKILL_RECONCILE_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Whether an entry is currently owned by a running operation.
 *
 * A lock held by a live owner means the process is still working; reconciling
 * underneath it would race the very write it is performing.
 */
function isLockedByLiveOwner(
  entry: SkillOperationJournalEntry,
  options: SkillReconcileOptions
): boolean {
  const record = readSkillOperationLock(entry.lockKey, options);
  if (record === null) return false;
  if (record.operationId !== entry.operationId) return false;
  const disposition = evaluateSkillLock(record, options);
  return disposition === 'HELD' || disposition === 'HELD_BY_LIVE_OWNER';
}

/** Drive one journal entry to its final state. */
export function reconcileSkillOperation(
  entry: SkillOperationJournalEntry,
  ports: SkillReconcilerPorts,
  options: SkillReconcileOptions = {}
): SkillReconcileOutcome {
  const from = entry.state;
  const base = { operationId: entry.operationId, idempotencyKey: entry.idempotencyKey, from };

  if (isSkillOperationTerminal(entry)) {
    return { ...base, to: from, action: 'SKIPPED_TERMINAL' };
  }
  if (isLockedByLiveOwner(entry, options)) {
    return { ...base, to: from, action: 'SKIPPED_LOCK_HELD' };
  }

  // The journal may have crashed before recording the commit, so the filesystem
  // is consulted even for PREPARING rather than trusting the last written state.
  const committed = hasSkillFilesystemCommit(entry) || ports.hasCommittedPayload(entry);

  if (!committed) {
    if (from === 'FAILED_RECONCILABLE') {
      return { ...base, to: from, action: 'CONVERGED_FAILED' };
    }
    const failed = transitionSkillOperation(
      entry,
      'FAILED_RECONCILABLE',
      { error: { code: 'SKILL_OPERATION_ROLLED_BACK', message: 'no payload was committed' } },
      options
    );
    ports.recordAudit(buildSkillOperationAuditInput(failed, 'failed', options.now));
    return { ...base, to: failed.state, action: 'CONVERGED_FAILED' };
  }

  let current = entry;
  try {
    if (current.state === 'PREPARING') {
      current = transitionSkillOperation(current, 'FS_COMMITTED', {}, options);
    }
    ports.reindex(current);
    if (current.state !== 'INDEXED') {
      current = transitionSkillOperation(current, 'INDEXED', {}, options);
    }
    current = transitionSkillOperation(current, 'SUCCEEDED', { error: null }, options);
  } catch (error) {
    const stalled = transitionSkillOperation(
      current,
      'FAILED_RECONCILABLE',
      { error: toError(error) },
      options
    );
    ports.recordAudit(buildSkillOperationAuditInput(stalled, 'failed', options.now));
    return { ...base, to: stalled.state, action: 'RECONCILE_FAILED' };
  }

  ports.recordAudit(buildSkillOperationAuditInput(current, 'reconciled', options.now));
  return { ...base, to: current.state, action: 'CONVERGED_SUCCEEDED' };
}

/**
 * Reconcile every journal entry and clean up locks whose owner is verifiably
 * gone. Called at startup so a restart restores a single, explainable answer
 * for each operation (UX-06/UX-07).
 */
export function reconcileSkillOperations(
  ports: SkillReconcilerPorts,
  options: SkillReconcileOptions = {}
): SkillReconcileReport {
  const outcomes = listSkillOperationJournal(options).map((entry) =>
    reconcileSkillOperation(entry, ports, options)
  );

  // Locks are cleaned after reconciliation: an entry still owned by a live
  // process must be observed as locked, not as an orphan.
  const orphanLocksReleased = options.skipOrphanLocks ? [] : releaseOrphanSkillLocks(options);

  return {
    scanned: outcomes.length,
    converged: outcomes.filter((o) => o.action === 'CONVERGED_SUCCEEDED').length,
    failed: outcomes.filter((o) => o.action === 'CONVERGED_FAILED' || o.action === 'RECONCILE_FAILED')
      .length,
    skipped: outcomes.filter(
      (o) => o.action === 'SKIPPED_TERMINAL' || o.action === 'SKIPPED_LOCK_HELD'
    ).length,
    orphanLocksReleased,
    outcomes,
  };
}
