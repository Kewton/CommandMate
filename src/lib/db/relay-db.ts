/**
 * The relay ledger's CRUD (Issue #2377, table from migration v60).
 *
 * Every state change a relay can undergo is a statement in this file, and each
 * one that must happen at most once is written as a GUARDED update that reports
 * whether it won. That is not a style choice: the turn's end is judged by two
 * independent producers (the Stop hook and the poller) and the delivery pump can
 * be re-entered by a timer while a first pass is still awaiting a send, so
 * "read, decide, write" would deliver some replies twice. `better-sqlite3` is
 * synchronous, so a single `UPDATE … WHERE <precondition>` plus `changes === 1`
 * is a compare-and-set with no window in it.
 *
 * Shapes come from `@/lib/relay/types`, which knows nothing about SQL — the
 * browser hook reads the same interfaces.
 *
 * @module lib/db/relay-db
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type {
  RelayBindMode,
  RelayCounts,
  RelayEndpoint,
  RelaySendState,
  SessionRelay,
  SessionRelaySummary,
} from '@/lib/relay/types';
import { emptyRelayCounts, OPEN_RELAY_STATES } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';
import {
  completeRelayPayloadDelivery,
  KEEP_HELD_PAYLOAD_SET,
  mapRelay,
  OPEN_STATE_PLACEHOLDERS,
  RELAY_COLUMNS,
  type RelayPayloadAttemptRef,
  type SessionRelayRow,
} from '@/lib/db/relay-bind-db';

// Issue #3995: the send binding and the pending slots live in `relay-bind-db`;
// re-exported so every caller (and every `vi.mock`) keeps this module's surface.
export {
  appendRelayHeldCandidate,
  claimRelayPayloadDelivery,
  clearRelayHeldCandidates,
  clearRelayPending,
  clearRelayPendingReply,
  completeRelayPayloadDelivery,
  explainRelayBindRefusal,
  failOrphanedRelayBind,
  getRelayBinding,
  getRelayPendingPayload,
  holdRelayPayloadDelivery,
  listDeliverableRelayPayloads,
  listOpenBoundRelays,
  listRelaysWithDeliveryHold,
  listRelaysWithPendingPayload,
  promoteRelayPendingReply,
  recordRelayInputBoundary,
  recoverInterruptedRelayDeliveries,
  releaseRelayPayloadDelivery,
  RELAY_DELIVERY_SERVER_RESTARTED,
  replaceRelayPromptWithPendingReply,
  replaceRelayPromptWithReply,
  reserveRelayBind,
  setRelayHold,
  setRelayPendingReply,
  settleRelaySendState,
  stashRelayPayload,
  type ClaimRelayPayloadDeliveryInput,
  type RecordRelayInputBoundaryInput,
  type RelayBinding,
  type RelayBindRefusal,
  type RelayHeldCandidate,
  type RelayPayloadAttemptRef,
  type RelayPendingReply,
  type RelayWithPendingPayload,
  type ReserveRelayBindInput,
  type SettleRelaySendStateInput,
  type StashRelayPayloadOptions,
} from '@/lib/db/relay-bind-db';

const logger = createLogger('relay-db');

/** What {@link createRelay} needs. Everything else is derived here. */
export interface CreateRelayInput {
  from: RelayEndpoint;
  to: RelayEndpoint;
  /** Chain depth; the caller computed it from the triggering message. */
  hops: number;
  /** Epoch ms after which the relay is swept. */
  expiresAt: number;
  /** Epoch ms; injectable so a suite does not race the wall clock. */
  now?: number;
  /** Issue #3957: `bound` when the caller will pass the relay id to the send. */
  bindMode?: RelayBindMode;
}

/** Insert a new `pending` relay and hand it back. */
export function createRelay(db: Database.Database, input: CreateRelayInput): SessionRelay {
  const id = randomUUID();
  const now = input.now ?? Date.now();
  const bindMode: RelayBindMode = input.bindMode ?? 'legacy';
  // A legacy row carries no send state at all: NULL, never a pretended `sent`.
  const sendState: RelaySendState | null = bindMode === 'bound' ? 'awaiting' : null;

  db.prepare(`
    INSERT INTO session_relays
      (id, from_worktree_id, from_instance_id, to_worktree_id, to_instance_id,
       state, hops, sent_request_id, pending_kind, pending_body, prompt_signature,
       created_at, updated_at, expires_at, delivered_at, bind_mode, send_state)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    input.from.worktreeId,
    input.from.instanceId,
    input.to.worktreeId,
    input.to.instanceId,
    input.hops,
    now,
    now,
    input.expiresAt,
    bindMode,
    sendState
  );

  return {
    id,
    from: { ...input.from },
    to: { ...input.to },
    state: 'pending',
    hops: input.hops,
    sentRequestId: null,
    pendingKind: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt,
    deliveredAt: null,
    bindMode,
    sendState,
    inputBoundaryAt: null,
    boundaryKind: null,
    turnOpenAtSend: null,
    obsState: null,
    holdReason: null,
    overlap: null,
    deliveryHold: null,
  };
}

/** One relay by id, or null. */
export function getRelayById(db: Database.Database, id: string): SessionRelay | null {
  const row = db
    .prepare(`SELECT ${RELAY_COLUMNS} FROM session_relays WHERE id = ?`)
    .get(id) as SessionRelayRow | undefined;
  return row ? mapRelay(row) : null;
}

/** Every still-open relay this session must answer (it is the `to` end). */
export function listOpenRelaysTo(
  db: Database.Database,
  endpoint: RelayEndpoint
): SessionRelay[] {
  const rows = db
    .prepare(`
      SELECT ${RELAY_COLUMNS} FROM session_relays
      WHERE to_worktree_id = ? AND to_instance_id = ?
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
      ORDER BY created_at ASC
    `)
    .all(endpoint.worktreeId, endpoint.instanceId, ...OPEN_RELAY_STATES) as SessionRelayRow[];
  return rows.map(mapRelay);
}

/** Every still-open relay this session is waiting on (it is the `from` end). */
export function listOpenRelaysFrom(
  db: Database.Database,
  endpoint: RelayEndpoint
): SessionRelay[] {
  const rows = db
    .prepare(`
      SELECT ${RELAY_COLUMNS} FROM session_relays
      WHERE from_worktree_id = ? AND from_instance_id = ?
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
      ORDER BY created_at ASC
    `)
    .all(endpoint.worktreeId, endpoint.instanceId, ...OPEN_RELAY_STATES) as SessionRelayRow[];
  return rows.map(mapRelay);
}

/** Both halves of {@link SessionRelaySummary} in one call. */
export function getSessionRelaySummary(
  db: Database.Database,
  endpoint: RelayEndpoint
): SessionRelaySummary {
  return {
    owed: listOpenRelaysTo(db, endpoint),
    awaiting: listOpenRelaysFrom(db, endpoint),
  };
}

/** Every open relay in a worktree, whichever end it belongs to. */
export function listOpenRelaysForWorktree(
  db: Database.Database,
  worktreeId: string
): SessionRelay[] {
  const rows = db
    .prepare(`
      SELECT ${RELAY_COLUMNS} FROM session_relays
      WHERE (from_worktree_id = ? OR to_worktree_id = ?)
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
      ORDER BY created_at ASC
    `)
    .all(worktreeId, worktreeId, ...OPEN_RELAY_STATES) as SessionRelayRow[];
  return rows.map(mapRelay);
}

/**
 * How many open relays already run from `from` to `to`.
 *
 * The Issue's "a from→to pair must not sit at two pending relays at once": a
 * second standing instruction to the same session says nothing the first one
 * does not, and both would fire on the same finished turn.
 */
export function countOpenRelaysBetween(
  db: Database.Database,
  from: RelayEndpoint,
  to: RelayEndpoint
): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n FROM session_relays
      WHERE from_worktree_id = ? AND from_instance_id = ?
        AND to_worktree_id = ? AND to_instance_id = ?
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .get(
      from.worktreeId,
      from.instanceId,
      to.worktreeId,
      to.instanceId,
      ...OPEN_RELAY_STATES
    ) as { n: number };
  return row.n;
}

/**
 * The UPDATE behind {@link markRelayDelivered}, without its catch: a write the
 * database refuses (the UNIQUE index included) throws. `false` means only that
 * the relay was no longer open, or already carried a delivery id.
 */
function closeRelayDelivered(
  db: Database.Database,
  id: string,
  sentRequestId: string,
  now: number
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays
      SET state = 'delivered', sent_request_id = ?, delivered_at = ?,
          pending_kind = NULL, pending_body = NULL, payload_id = NULL, updated_at = ?
      WHERE id = ? AND sent_request_id IS NULL
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(sentRequestId, now, now, id, ...OPEN_RELAY_STATES);
  return result.changes === 1;
}

/**
 * Close the relay as delivered, exactly once.
 *
 * Two clauses, and they guard different things — worth separating, because a
 * later reader who notices that the second is redundant *for one relay id* will
 * otherwise delete the one that is not.
 *
 *  - `state IN (open)` is what makes a SECOND call for the same relay answer
 *    false: the first call left it `delivered`, which is not an open state.
 *  - `sent_request_id IS NULL`, together with the column's UNIQUE index, is what
 *    makes the delivery id itself unrepeatable ACROSS relays and across
 *    processes. It is the idempotency key the Issue names, and it is why this
 *    function catches: the index refusing a write is the answer "somebody else
 *    got there first", and that answer must not arrive as an exception inside a
 *    delivery path.
 *
 * @returns Whether this call is the one that closed it
 */
export function markRelayDelivered(
  db: Database.Database,
  id: string,
  sentRequestId: string,
  now = Date.now()
): boolean {
  try {
    return closeRelayDelivered(db, id, sentRequestId, now);
  } catch (error) {
    // The UNIQUE index refusing the write IS the answer "somebody else got
    // there first", and it must not become an exception in a delivery path.
    logger.warn('relay-deliver-conflict', {
      relayId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Which attempt delivered the reply, and the delivery id it closes under (Issue #4064). */
export interface RelayReplyDeliveryInput extends RelayPayloadAttemptRef {
  sentRequestId: string;
}

/** What {@link completeRelayReplyDelivery} did. */
export interface RelayReplyDeliveryResult {
  /** This call closed the relay as delivered; false = it was already closed. */
  closed: boolean;
  /** The attempt was still the one on the row and is ended now. */
  completed: boolean;
}

/**
 * A reply's send went out: close the relay as delivered AND end the delivery
 * attempt, in one transaction (Issue #4064).
 *
 * Closing the relay empties the payload (body, kind, payload id). Committed
 * on its own, a failure or a stop before the attempt is ended left an
 * `attempting` row with no payload, which the next boot held as an
 * `uncertain` delivery nobody can identify. Here either both writes land or
 * neither does: a throw rolls the payload back with the attempt, so the row
 * stays `attempting` with its body and payload id — held, never re-sent, and
 * labelled by the next boot.
 *
 * @throws When the database refuses a write; nothing is committed then
 */
export function completeRelayReplyDelivery(
  db: Database.Database,
  input: RelayReplyDeliveryInput
): RelayReplyDeliveryResult {
  const now = input.now ?? Date.now();
  return db.transaction((): RelayReplyDeliveryResult => {
    // Not `markRelayDelivered`: its catch turns a refused write into `false`,
    // and ending the attempt after that would commit an open relay with its
    // payload and hold gone — the next completion could capture the same reply
    // again. A refused close throws here, and nothing is committed.
    const closed = closeRelayDelivered(db, input.relayId, input.sentRequestId, now);
    const completed = completeRelayPayloadDelivery(db, {
      relayId: input.relayId,
      payloadId: input.payloadId,
      attemptId: input.attemptId,
      now,
    });
    return { closed, completed };
  })();
}

/**
 * Note that A is being told B is waiting on a confirmation.
 *
 * Leaves the relay OPEN — `prompt` is an open state, so answering the dialog
 * lets B finish and the reply is stashed and delivered from here — and leaves
 * any stashed payload alone: this records the DECISION to notify, while
 * `clearRelayPending` records that the notice went out. `prompt_signature` is
 * what stops a twenty-minute wait from producing a notice on every poll.
 */
export function markRelayPromptNotified(
  db: Database.Database,
  id: string,
  signature: string,
  now = Date.now()
): void {
  db.prepare(`
    UPDATE session_relays
    SET state = 'prompt', prompt_signature = ?, updated_at = ?
    WHERE id = ?
  `).run(signature, now, id);
}

/** The confirmation notice already sent for this relay, or null. */
export function getRelayPromptSignature(
  db: Database.Database,
  id: string
): string | null {
  const row = db
    .prepare('SELECT prompt_signature FROM session_relays WHERE id = ?')
    .get(id) as { prompt_signature: string | null } | undefined;
  return row?.prompt_signature ?? null;
}

/**
 * Close the relay as expired, exactly once.
 *
 * The once-ness is the point: the Issue asks for ONE line of notice, and the
 * state transition is what the notice is written from.
 *
 * @returns Whether this call is the one that expired it
 */
export function markRelayExpired(
  db: Database.Database,
  id: string,
  now = Date.now()
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays
      SET state = 'expired', updated_at = ?
      WHERE id = ? AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(now, id, ...OPEN_RELAY_STATES);
  return result.changes === 1;
}

/** Every open relay whose deadline has passed. */
export function listExpiredOpenRelays(
  db: Database.Database,
  now = Date.now()
): SessionRelay[] {
  const rows = db
    .prepare(`
      SELECT ${RELAY_COLUMNS} FROM session_relays
      WHERE state IN (${OPEN_STATE_PLACEHOLDERS}) AND expires_at <= ?
      ORDER BY expires_at ASC
    `)
    .all(...OPEN_RELAY_STATES, now) as SessionRelayRow[];
  return rows.map(mapRelay);
}

/**
 * Withdraw a relay. Returns false when it was already closed or absent.
 *
 * Issue #4064: stops later deliveries only. A payload under a delivery hold
 * (it may already be in A's composer) keeps its body, id and reason.
 */
export function cancelRelay(
  db: Database.Database,
  id: string,
  now = Date.now()
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays
      SET state = 'cancelled', ${KEEP_HELD_PAYLOAD_SET},
          pending_reply = NULL, updated_at = ?
      WHERE id = ? AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(now, id, ...OPEN_RELAY_STATES);
  return result.changes === 1;
}

/** Which relays {@link countRelays} should count. All fields are optional. */
export interface RelayCountFilter {
  /** Only relays with this worktree at either end. */
  worktreeId?: string;
  /** Narrows {@link RelayCountFilter.worktreeId} to one instance. */
  instanceId?: string;
  /** Only relays created at or after this epoch ms. */
  since?: number;
}

/**
 * Count relays per state.
 *
 * The shape `commandmate task show` and `report metrics` print. Counting in SQL
 * rather than reading rows because a long-lived server accumulates thousands
 * and both callers want five integers.
 */
export function countRelays(
  db: Database.Database,
  filter: RelayCountFilter = {}
): RelayCounts {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.worktreeId) {
    if (filter.instanceId) {
      clauses.push(
        '((from_worktree_id = ? AND from_instance_id = ?) OR (to_worktree_id = ? AND to_instance_id = ?))'
      );
      params.push(filter.worktreeId, filter.instanceId, filter.worktreeId, filter.instanceId);
    } else {
      clauses.push('(from_worktree_id = ? OR to_worktree_id = ?)');
      params.push(filter.worktreeId, filter.worktreeId);
    }
  }
  if (filter.since !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.since);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT state, COUNT(*) AS n FROM session_relays ${where} GROUP BY state`)
    .all(...params) as Array<{ state: string; n: number }>;

  const counts = emptyRelayCounts();
  for (const row of rows) {
    if (row.state in counts) {
      counts[row.state as keyof RelayCounts] = row.n;
    }
  }
  return counts;
}
