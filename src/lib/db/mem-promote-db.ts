/**
 * The records of the promote path (Issue #4225, design `mem-promote-4225.md` §6.1):
 * previews, operations and their attempts. `mem_items` is never written here — a
 * decision moves only through A's entrance (`memSettleDecisionTransition`).
 *
 * Synchronous, meant for the promote service's synchronous stretches.
 *
 * @module lib/db/mem-promote-db
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  PROMOTE_ATTEMPT_STALE_MS,
  PROMOTE_RETENTION_MS,
  type PromoteDestination,
  type PromoteEffect,
  type PromoteOperationState,
  type PromoteQuoteOrigin,
} from '@/lib/promote/model';
import { resolveWorktreeIdWithAlias } from './worktree-alias-db';

export interface PromotePreviewRow {
  id: string;
  operation_id: string;
  item_id: string;
  item_version: number;
  item_fingerprint: string;
  repository_id: string;
  branch: string | null;
  destination: string;
  base_fingerprint: string;
  body: string;
  body_sha256: string;
  effect: PromoteEffect;
  quote_origin: PromoteQuoteOrigin;
  quote_confirmed_at: number | null;
  rules_version: number;
  context_worktree_id: string;
  context_worktree_incarnation: string;
  acknowledged_operation_ids: string;
  poster_host: string | null;
  poster_id: number | null;
  poster_login: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  invalidated_reason: string | null;
}

export interface PromoteOperationRow {
  id: string;
  preview_id: string;
  item_id: string;
  item_version: number;
  item_fingerprint: string;
  context_worktree_id: string;
  context_worktree_incarnation: string;
  destination_worktree_incarnation: string | null;
  poster_id: number | null;
  repository_id: string;
  branch: string | null;
  destination_kind: PromoteDestination['kind'];
  destination: string;
  base_fingerprint: string;
  body: string;
  body_sha256: string;
  block: string | null;
  effect: PromoteEffect;
  quote_origin: PromoteQuoteOrigin;
  state: PromoteOperationState;
  result_ref: string | null;
  transition_pending: number;
  transition_reason: string | null;
  /** The request holding the item's transition (design §11.1 I2); null when none does. */
  transition_claim: string | null;
  concurrent_edit: number;
  unknown_reason: string | null;
  decided_by: 'server' | 'human' | null;
  approved_at: number;
  settled_at: number | null;
  updated_at: number;
}

export function destinationOf(row: { destination: string }): PromoteDestination {
  return JSON.parse(row.destination) as PromoteDestination;
}

export function insertPromotePreview(db: Database.Database, row: PromotePreviewRow): void {
  db.prepare(
    `INSERT INTO mem_promote_previews (id, operation_id, item_id, item_version, item_fingerprint, repository_id, branch, destination,
       base_fingerprint, body, body_sha256, effect, quote_origin, quote_confirmed_at, rules_version, context_worktree_id,
       context_worktree_incarnation, acknowledged_operation_ids, poster_host, poster_id, poster_login, created_at, expires_at,
       used_at, invalidated_reason)
     VALUES (@id, @operation_id, @item_id, @item_version, @item_fingerprint, @repository_id, @branch, @destination,
       @base_fingerprint, @body, @body_sha256, @effect, @quote_origin, @quote_confirmed_at, @rules_version, @context_worktree_id,
       @context_worktree_incarnation, @acknowledged_operation_ids, @poster_host, @poster_id, @poster_login, @created_at, @expires_at,
       @used_at, @invalidated_reason)`
  ).run(row);
}

export function getPromotePreview(db: Database.Database, id: string): PromotePreviewRow | null {
  return (db.prepare('SELECT * FROM mem_promote_previews WHERE id = ?').get(id) as PromotePreviewRow | undefined) ?? null;
}

/** A person's "やめる" or a failed check: the preview can no longer be approved. */
export function invalidatePromotePreview(db: Database.Database, id: string, reason: string): void {
  db.prepare('UPDATE mem_promote_previews SET invalidated_reason = ? WHERE id = ? AND used_at IS NULL AND invalidated_reason IS NULL').run(
    reason,
    id
  );
}

export function getPromoteOperation(db: Database.Database, id: string): PromoteOperationRow | null {
  return (db.prepare('SELECT * FROM mem_promote_operations WHERE id = ?').get(id) as PromoteOperationRow | undefined) ?? null;
}

export function listPromoteOperations(db: Database.Database, itemIds: readonly string[]): PromoteOperationRow[] {
  if (itemIds.length === 0) return [];
  return db
    .prepare(`SELECT * FROM mem_promote_operations WHERE item_id IN (${itemIds.map(() => '?').join(',')}) ORDER BY approved_at, rowid`)
    .all(...itemIds) as PromoteOperationRow[];
}

/**
 * The unsettled operations of a branch (approved, in flight, unknown, or written with
 * the item's transition pending), whatever became of their item (5-2b P2-2): a close
 * or a purge of the item does not settle a write outside, and the screen must still
 * reach its reconcile.
 */
export function listUnresolvedPromoteOperations(
  db: Database.Database,
  repositoryIds: readonly string[],
  branch: string | null
): PromoteOperationRow[] {
  if (repositoryIds.length === 0) return [];
  return db
    .prepare(
      `SELECT * FROM mem_promote_operations
        WHERE repository_id IN (${repositoryIds.map(() => '?').join(',')}) AND branch IS ?
          AND (state IN ('approved','in_flight','unknown') OR (state = 'succeeded' AND transition_pending = 1))
        ORDER BY approved_at, rowid`
    )
    .all(...repositoryIds, branch) as PromoteOperationRow[];
}

/** The records already outside for an item: the `succeeded` and `unknown` operations (design §1.2). */
export function recordedOperationIds(db: Database.Database, itemId: string): string[] {
  return (
    db
      .prepare("SELECT id FROM mem_promote_operations WHERE item_id = ? AND state IN ('succeeded','unknown') ORDER BY id")
      .all(itemId) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** Whether the item has an operation in progress (the unique partial index's set). */
export function hasActivePromoteOperation(db: Database.Database, itemId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM mem_promote_operations WHERE item_id = ?
           AND (state IN ('approved','in_flight','unknown') OR (state = 'succeeded' AND transition_pending = 1))`
      )
      .get(itemId) !== undefined
  );
}

/** E's operations writing to this document (the reclaim rule of the temporary names, R4). */
export function docOperationsFor(db: Database.Database, worktreeId: string, rel: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const row of db
    .prepare("SELECT id, destination, block FROM mem_promote_operations WHERE destination_kind = 'worktree_doc'")
    .all() as Array<{ id: string; destination: string; block: string | null }>) {
    const dest = destinationOf(row);
    if (dest.kind !== 'worktree_doc' || dest.path !== rel) continue;
    // A rename since keeps the id written in the operation; its alias names the worktree now (5-2b P2-1).
    if (dest.worktreeId === worktreeId || resolveWorktreeIdWithAlias(db, dest.worktreeId) === worktreeId) out.set(row.id, row.block);
  }
  return out;
}

export interface PromoteClaim {
  preview: PromotePreviewRow;
  destinationWorktreeIncarnation: string | null;
  posterId: number | null;
  block: string | null;
  bootId: string;
  now: number;
}

/**
 * Make the operation and its attempt (`in_flight`) and use the preview, in one
 * transaction (design §2.3 step 5). `conflict` when the item already has one in
 * progress (the unique partial index) or the preview was used meanwhile.
 */
export function claimPromoteOperation(
  db: Database.Database,
  claim: PromoteClaim
): { ok: true; operationId: string; attemptId: string } | { ok: false; code: 'conflict' } {
  const { preview } = claim;
  const destination = JSON.parse(preview.destination) as PromoteDestination;
  try {
    return db.transaction(() => {
      const used = db
        .prepare('UPDATE mem_promote_previews SET used_at = ? WHERE id = ? AND used_at IS NULL AND invalidated_reason IS NULL')
        .run(claim.now, preview.id);
      if (used.changes !== 1) return { ok: false as const, code: 'conflict' as const };
      db.prepare(
        `INSERT INTO mem_promote_operations (id, preview_id, item_id, item_version, item_fingerprint, context_worktree_id,
           context_worktree_incarnation, destination_worktree_incarnation, poster_id, repository_id, branch, destination_kind,
           destination, base_fingerprint, body, body_sha256, block, effect, quote_origin, state, approved_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_flight', ?, ?)`
      ).run(
        preview.operation_id,
        preview.id,
        preview.item_id,
        preview.item_version,
        preview.item_fingerprint,
        preview.context_worktree_id,
        preview.context_worktree_incarnation,
        claim.destinationWorktreeIncarnation,
        claim.posterId,
        preview.repository_id,
        preview.branch,
        destination.kind,
        preview.destination,
        preview.base_fingerprint,
        preview.body,
        preview.body_sha256,
        claim.block,
        preview.effect,
        preview.quote_origin,
        claim.now,
        claim.now
      );
      const attemptId = randomUUID();
      db.prepare('INSERT INTO mem_promote_attempts (id, operation_id, boot_id, started_at) VALUES (?, ?, ?, ?)').run(
        attemptId,
        preview.operation_id,
        claim.bootId,
        claim.now
      );
      return { ok: true as const, operationId: preview.operation_id, attemptId };
    })();
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) return { ok: false, code: 'conflict' };
    throw error;
  }
}

export interface PromoteSettle {
  state: Extract<PromoteOperationState, 'succeeded' | 'failed' | 'unknown'>;
  reason: string | null;
  resultRef?: string | null;
  concurrentEdit?: boolean;
  decidedBy?: 'server' | 'human';
}

const OUTCOME_OF: Record<PromoteSettle['state'], 'success' | 'failure' | 'unknown'> = {
  succeeded: 'success',
  failed: 'failure',
  unknown: 'unknown',
};

/**
 * Close the open attempt and settle the operation (design §11.1 I2: conditional on the
 * state as read). `from` is the set the caller read: an approval's own write settles
 * from `in_flight` or the `unknown` a staleness made of it (the true outcome wins over
 * unknown, never over a person's reconcile or abandon); a reconcile settles from `unknown` only.
 */
export function settlePromoteOperation(
  db: Database.Database,
  operationId: string,
  settle: PromoteSettle,
  now: number,
  from: ReadonlyArray<Extract<PromoteOperationState, 'in_flight' | 'unknown'>> = ['in_flight', 'unknown']
): boolean {
  if (from.length === 0) return false;
  return db.transaction(() => {
    const changed = db
      .prepare(
        `UPDATE mem_promote_operations SET state = ?, result_ref = COALESCE(?, result_ref), concurrent_edit = ?,
           unknown_reason = ?, decided_by = ?, settled_at = ?, updated_at = ?
         WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`
      )
      .run(
        settle.state,
        settle.resultRef ?? null,
        settle.concurrentEdit ? 1 : 0,
        settle.state === 'unknown' ? settle.reason : null,
        settle.state === 'unknown' ? null : (settle.decidedBy ?? 'server'),
        settle.state === 'unknown' ? null : now,
        now,
        operationId,
        ...from
      );
    if (changed.changes !== 1) return false;
    db.prepare('UPDATE mem_promote_attempts SET ended_at = ?, outcome = ?, reason = ? WHERE operation_id = ? AND ended_at IS NULL').run(
      now,
      OUTCOME_OF[settle.state],
      settle.reason,
      operationId
    );
    return true;
  })();
}

/** What a request read of the transition before it takes it (design §11.1 I2). */
export interface PromoteTransitionRead {
  transition_pending: number;
  transition_claim: string | null;
}

/**
 * Take the item's transition of a succeeded write (design §3.5・§11.1 I2): pending, with
 * this request's claim, only while the operation is as the request read it (`state =
 * 'succeeded'` and the same pending and claim). A later request takes it over from an
 * earlier one; the earlier one's answer is then not written. Null when the state moved.
 */
export function beginPromoteTransition(db: Database.Database, operationId: string, read: PromoteTransitionRead, now: number): string | null {
  const claim = randomUUID();
  const changed = db
    .prepare(
      `UPDATE mem_promote_operations SET transition_pending = 1, transition_reason = NULL, transition_claim = ?, updated_at = ?
       WHERE id = ? AND state = 'succeeded' AND transition_pending = ? AND transition_claim IS ?`
    )
    .run(claim, now, operationId, read.transition_pending, read.transition_claim);
  return changed.changes === 1 ? claim : null;
}

/**
 * A's answer to the request holding `claim` (design §11.1 I2).
 * - moved: the item followed, so nothing is pending whoever holds the claim now (A's
 *   success is the fact the pending stood for); written only while it is still pending.
 * - not moved: the reason is written only while this request still holds the claim, so
 *   a person's acknowledgement or a later request in between is never overwritten.
 */
export function finishPromoteTransition(
  db: Database.Database,
  operationId: string,
  claim: string,
  answer: { moved: true } | { moved: false; reason: string },
  now: number
): boolean {
  if (answer.moved) {
    return (
      db
        .prepare(
          `UPDATE mem_promote_operations SET transition_pending = 0, transition_reason = NULL, transition_claim = NULL, updated_at = ?
           WHERE id = ? AND state = 'succeeded' AND transition_pending = 1`
        )
        .run(now, operationId).changes === 1
    );
  }
  return (
    db
      .prepare(
        `UPDATE mem_promote_operations SET transition_reason = ?, transition_claim = NULL, updated_at = ?
         WHERE id = ? AND state = 'succeeded' AND transition_pending = 1 AND transition_claim = ?`
      )
      .run(answer.reason, now, operationId, claim).changes === 1
  );
}

/**
 * A person acknowledged that a closed or purged item will not follow (5-2c P2-3): the
 * pending ends without A, only while it is as the person's request read it (§11.1 I2).
 * Any claim of an earlier request is dropped with it, so its answer is not written.
 */
export function acknowledgePromoteTransition(db: Database.Database, operationId: string, read: PromoteTransitionRead, now: number): boolean {
  if (read.transition_pending !== 1) return false;
  return (
    db
      .prepare(
        `UPDATE mem_promote_operations SET transition_pending = 0, transition_reason = NULL, transition_claim = NULL, updated_at = ?
         WHERE id = ? AND state = 'succeeded' AND transition_pending = 1 AND transition_claim IS ?`
      )
      .run(now, operationId, read.transition_claim).changes === 1
  );
}

/** A person checked outside that nothing was written (design §3.4): `unknown → abandoned`. */
export function abandonPromoteOperation(db: Database.Database, operationId: string, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE mem_promote_operations SET state = 'abandoned', decided_by = 'human', settled_at = ?, updated_at = ?
         WHERE id = ? AND state = 'unknown'`
      )
      .run(now, now, operationId).changes === 1
  );
}

/**
 * An attempt of another boot, or `in_flight` past {@link PROMOTE_ATTEMPT_STALE_MS}, is
 * unknown (design §3.2's last row). Settled here, in a write's synchronous stretch.
 */
export function settleStalePromoteAttempts(db: Database.Database, bootId: string, now: number): number {
  const stale = db
    .prepare(
      `SELECT operation_id FROM mem_promote_attempts WHERE ended_at IS NULL AND (boot_id != ? OR started_at < ?)`
    )
    .all(bootId, now - PROMOTE_ATTEMPT_STALE_MS) as Array<{ operation_id: string }>;
  for (const row of stale) settlePromoteOperation(db, row.operation_id, { state: 'unknown', reason: 'stale_attempt' }, now);
  return stale.length;
}

/**
 * Retention (design §6.1), in a write's stretch (no timer): unused previews past
 * their expiry, and settled records past 90 days. What is in progress, unknown or
 * waiting for its transition, and the previews they used, are never removed.
 */
export function prunePromoteRecords(db: Database.Database, now: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM mem_promote_previews WHERE used_at IS NULL AND expires_at < ?').run(now);
    const old = db
      .prepare(
        `SELECT id, preview_id FROM mem_promote_operations
         WHERE ((state = 'succeeded' AND transition_pending = 0) OR state IN ('failed','abandoned')) AND updated_at < ?`
      )
      .all(now - PROMOTE_RETENTION_MS) as Array<{ id: string; preview_id: string }>;
    for (const row of old) {
      db.prepare('DELETE FROM mem_promote_operations WHERE id = ?').run(row.id);
      db.prepare('DELETE FROM mem_promote_previews WHERE id = ?').run(row.preview_id);
    }
  })();
}
