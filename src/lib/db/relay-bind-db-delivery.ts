/**
 * The relay ledger's delivery attempts (Issue #4064, v63), split out of
 * `relay-bind-db` (Issue #4095).
 *
 * `relay-bind-db` re-exports every public name here. This module imports only
 * `relay-bind-db-base`.
 *
 * @module lib/db/relay-bind-db-delivery
 */

import Database from 'better-sqlite3';
import type { RelayEndpoint, RelayPendingKind, SessionRelay } from '@/lib/relay/types';
import { RELAY_COLUMNS, mapRelay, type SessionRelayRow } from './relay-bind-db-base';

// ---------------------------------------------------------------------------
// Issue #4064: the delivery's own attempt (v63)
// ---------------------------------------------------------------------------


/** What {@link claimRelayPayloadDelivery} takes. */
export interface ClaimRelayPayloadDeliveryInput {
  relayId: string;
  /** The payload the caller read; NULL for a row stashed before v62. */
  payloadId: string | null;
  kind: RelayPendingKind;
  body: string;
  /** Fresh per delivery attempt; the only key its result is written under. */
  attemptId: string;
  /** The server boot that takes it. */
  owner: string;
  /** Given to a payload that has no id yet, so the hold can name it. */
  mintPayloadId: string;
  now?: number;
}

/**
 * Take one payload for delivery, durably, before its first key (Issue #4064).
 *
 * One conditional UPDATE on the payload the caller read — its id, kind and
 * body — and on it not being taken already. Only the caller this answers for
 * may send it; a payload replaced, delivered, held or taken meanwhile answers
 * null and nothing is written. A throw (the database refused the write) means
 * the same: do not send.
 *
 * @returns The payload's id (minted for a row that had none), or null
 */
export function claimRelayPayloadDelivery(
  db: Database.Database,
  input: ClaimRelayPayloadDeliveryInput
): string | null {
  const now = input.now ?? Date.now();
  const payloadId = input.payloadId ?? input.mintPayloadId;
  const result = db
    .prepare(`
      UPDATE session_relays
      SET delivery_state = 'attempting', delivery_attempt_id = ?, delivery_owner = ?,
          delivery_reason = NULL, delivery_at = ?, payload_id = ?
      WHERE id = ? AND pending_kind = ? AND pending_body = ? AND payload_id IS ?
        AND delivery_state IS NULL
    `)
    .run(
      input.attemptId,
      input.owner,
      now,
      payloadId,
      input.relayId,
      input.kind,
      input.body,
      input.payloadId
    );
  return result.changes === 1 ? payloadId : null;
}

/** Which attempt a delivery result is written under (Issue #4064). */
export interface RelayPayloadAttemptRef {
  relayId: string;
  payloadId: string;
  attemptId: string;
  now?: number;
}

/**
 * Whether `ref` is still the attempt in progress on the row: the same payload,
 * the same attempt id, and still `attempting` (Issue #4082).
 *
 * Every result writer asks this BEFORE its first side effect. An attempt held
 * as `uncertain` meanwhile (another boot's recovery), resolved, or replaced by
 * a retry's new attempt is stale: its late success or failure must not close
 * the relay, empty a payload, promote a reply or end the newer attempt.
 */
export function isCurrentRelayPayloadAttempt(
  db: Database.Database,
  ref: RelayPayloadAttemptRef
): boolean {
  const row = db
    .prepare(`
      SELECT 1 AS hit FROM session_relays
      WHERE id = ? AND payload_id = ? AND delivery_attempt_id = ? AND delivery_state = 'attempting'
    `)
    .get(ref.relayId, ref.payloadId, ref.attemptId) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * The attempt delivered its payload: empty the slot (if it still holds that
 * payload) and drop the attempt, in one transaction (Issue #4064).
 *
 * Issue #4082: only while the attempt is still the one in progress
 * ({@link isCurrentRelayPayloadAttempt}); a stale attempt writes nothing.
 *
 * @returns Whether the attempt was still the one on the row
 */
export function completeRelayPayloadDelivery(
  db: Database.Database,
  ref: RelayPayloadAttemptRef
): boolean {
  const now = ref.now ?? Date.now();
  return db.transaction((): boolean => {
    if (!isCurrentRelayPayloadAttempt(db, ref)) return false;
    return endRelayPayloadAttempt(db, { ...ref, now });
  })();
}

/**
 * The writes behind {@link completeRelayPayloadDelivery}, without its check:
 * empty the slot if it still holds the payload, and end the attempt. For a
 * caller that checked the attempt itself, in its own transaction, before a
 * write that empties the payload (the reply's close).
 *
 * @returns Whether the attempt was ended
 */
export function endRelayPayloadAttempt(db: Database.Database, ref: RelayPayloadAttemptRef): boolean {
  const now = ref.now ?? Date.now();
  db.prepare(`
    UPDATE session_relays
    SET pending_kind = NULL, pending_body = NULL, payload_id = NULL, updated_at = ?
    WHERE id = ? AND payload_id = ? AND delivery_attempt_id = ? AND delivery_state = 'attempting'
  `).run(now, ref.relayId, ref.payloadId, ref.attemptId);
  const result = db
    .prepare(`
      UPDATE session_relays
      SET delivery_state = NULL, delivery_attempt_id = NULL, delivery_owner = NULL,
          delivery_reason = NULL, delivery_at = NULL, updated_at = ?
      WHERE id = ? AND delivery_attempt_id = ? AND delivery_state = 'attempting'
    `)
    .run(now, ref.relayId, ref.attemptId);
  return result.changes === 1;
}

/**
 * The attempt is known not to have sent (`not-sent`, `prompt_waiting`): the
 * payload is queued again (Issue #4064).
 *
 * @returns Whether the attempt was still the one on the row
 */
export function releaseRelayPayloadDelivery(
  db: Database.Database,
  ref: RelayPayloadAttemptRef
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays
      SET delivery_state = NULL, delivery_attempt_id = NULL, delivery_owner = NULL,
          delivery_reason = NULL, delivery_at = NULL, updated_at = ?
      WHERE id = ? AND payload_id = ? AND delivery_attempt_id = ? AND delivery_state = 'attempting'
    `)
    .run(ref.now ?? Date.now(), ref.relayId, ref.payloadId, ref.attemptId);
  return result.changes === 1;
}

/**
 * Whether the attempt reached A is not known: hold the payload as `uncertain`,
 * with the reason (Issue #4064). It stays in the slot — readable, and blocking
 * the relay's later deliveries — and is never sent again automatically.
 *
 * @returns Whether the attempt was still the one on the row
 */
export function holdRelayPayloadDelivery(
  db: Database.Database,
  ref: RelayPayloadAttemptRef & { reason: string }
): boolean {
  const now = ref.now ?? Date.now();
  const result = db
    .prepare(`
      UPDATE session_relays
      SET delivery_state = 'uncertain', delivery_reason = ?, delivery_at = ?, updated_at = ?
      WHERE id = ? AND payload_id = ? AND delivery_attempt_id = ? AND delivery_state = 'attempting'
    `)
    .run(ref.reason, now, now, ref.relayId, ref.payloadId, ref.attemptId);
  return result.changes === 1;
}

/** {@link recoverInterruptedRelayDeliveries}' reason. */
export const RELAY_DELIVERY_SERVER_RESTARTED = 'server-restarted';

/**
 * An attempt another boot left `attempting` stopped somewhere between its
 * claim and its result: hold it as `uncertain` (Issue #4064). Every relay —
 * legacy or bound, open or closed — and every kind. A payload that was in fact
 * never typed (the server stopped right after the claim) is held too; that is
 * the price of never typing one twice.
 *
 * Safe to run again: this boot's own attempts are not touched.
 *
 * @returns How many were held
 */
export function recoverInterruptedRelayDeliveries(
  db: Database.Database,
  boot: string,
  now = Date.now()
): number {
  return recoverInterruptedRelayDeliveryRefs(db, boot, now).length;
}

/**
 * {@link recoverInterruptedRelayDeliveries}, answering WHICH attempts this call
 * moved to `uncertain` (Issue #4082): the relay, payload and attempt of each
 * row whose guarded write took, so the requester can be told about exactly
 * those — not a row another boot held first, not one already `uncertain`, not
 * this boot's own `attempting`.
 *
 * One transaction: the rows are read and each is moved under its own attempt
 * id, so a row resolved or retried between the read and the write is not
 * reported.
 */
export function recoverInterruptedRelayDeliveryRefs(
  db: Database.Database,
  boot: string,
  now = Date.now()
): RelayPayloadAttemptRef[] {
  return db.transaction((): RelayPayloadAttemptRef[] => {
    const rows = db
      .prepare(`
        SELECT id, payload_id, delivery_attempt_id FROM session_relays
        WHERE delivery_state = 'attempting' AND (delivery_owner IS NULL OR delivery_owner <> ?)
      `)
      .all(boot) as Array<{ id: string; payload_id: string | null; delivery_attempt_id: string | null }>;
    const held: RelayPayloadAttemptRef[] = [];
    const hold = db.prepare(`
      UPDATE session_relays
      SET delivery_state = 'uncertain', delivery_reason = ?, delivery_at = ?, updated_at = ?
      WHERE id = ? AND delivery_attempt_id IS ? AND delivery_state = 'attempting'
        AND (delivery_owner IS NULL OR delivery_owner <> ?)
    `);
    for (const row of rows) {
      const result = hold.run(RELAY_DELIVERY_SERVER_RESTARTED, now, now, row.id, row.delivery_attempt_id, boot);
      if (result.changes !== 1) continue;
      // A row without the ids is held all the same, and simply not reported:
      // a line could not name what to resolve.
      if (row.payload_id === null || row.delivery_attempt_id === null) continue;
      held.push({ relayId: row.id, payloadId: row.payload_id, attemptId: row.delivery_attempt_id, now });
    }
    return held;
  })();
}

/**
 * Every relay, open or closed, whose payload is under a delivery hold
 * (Issue #4064), oldest first. With an endpoint, those with it at either end;
 * with a worktree only, those with that worktree at either end.
 */
export function listRelaysWithDeliveryHold(
  db: Database.Database,
  scope: { worktreeId?: string; endpoint?: RelayEndpoint } = {}
): SessionRelay[] {
  const clauses = ['delivery_state IS NOT NULL'];
  const params: string[] = [];
  if (scope.endpoint) {
    clauses.push(
      '((from_worktree_id = ? AND from_instance_id = ?) OR (to_worktree_id = ? AND to_instance_id = ?))'
    );
    const { worktreeId, instanceId } = scope.endpoint;
    params.push(worktreeId, instanceId, worktreeId, instanceId);
  } else if (scope.worktreeId) {
    clauses.push('(from_worktree_id = ? OR to_worktree_id = ?)');
    params.push(scope.worktreeId, scope.worktreeId);
  }
  const rows = db
    .prepare(`
      SELECT ${RELAY_COLUMNS} FROM session_relays
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ASC
    `)
    .all(...params) as SessionRelayRow[];
  return rows.map(mapRelay);
}
