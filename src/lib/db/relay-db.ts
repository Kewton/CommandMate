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
  RelayHoldAction,
  RelayEndpoint,
  RelaySendState,
  SessionRelay,
  SessionRelaySummary,
} from '@/lib/relay/types';
import { emptyRelayCounts, isOpenRelayState, OPEN_RELAY_STATES } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';
import {
  endRelayPayloadAttempt,
  isCurrentRelayPayloadAttempt,
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
  clearRelayPendingReplyUnlessHeld,
  completeRelayPayloadDelivery,
  countHeldRelays,
  completeRelayPromptDelivery,
  explainRelayBindRefusal,
  failOrphanedRelayBind,
  getRelayBinding,
  getRelayPendingPayload,
  holdRelayPayloadDelivery,
  isCurrentRelayPayloadAttempt,
  listDeliverableRelayPayloads,
  listOpenBoundRelays,
  listRelaysWithDeliveryHold,
  listRelaysWithPendingPayload,
  promoteRelayPendingReply,
  recordRelayInputBoundary,
  recoverInterruptedRelayDeliveries,
  recoverInterruptedRelayDeliveryRefs,
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
  /** This call closed the relay as delivered; false = it was already closed, or the attempt is stale. */
  closed: boolean;
  /** The attempt was still the one on the row and is ended now; false = stale, nothing written. */
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
    // Issue #4082: the attempt is checked FIRST. A stale one — held meanwhile,
    // resolved, or replaced by a retry's new attempt — must not close the
    // relay or empty its payload: the close below is keyed on the relay only.
    if (!isCurrentRelayPayloadAttempt(db, input)) return { closed: false, completed: false };
    // Not `markRelayDelivered`: its catch turns a refused write into `false`,
    // and ending the attempt after that would commit an open relay with its
    // payload and hold gone — the next completion could capture the same reply
    // again. A refused close throws here, and nothing is committed.
    const closed = closeRelayDelivered(db, input.relayId, input.sentRequestId, now);
    // The attempt was checked above; the close emptied `payload_id`, so the
    // check is not asked again here.
    const completed = endRelayPayloadAttempt(db, {
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

// ---------------------------------------------------------------------------
// Issue #4082: resolving an `uncertain` delivery hold
// ---------------------------------------------------------------------------

/** What {@link resolveRelayDeliveryHold} is asked to do, and to which hold. */
export interface ResolveRelayDeliveryHoldInput {
  relayId: string;
  /** The held payload's id, as the caller read it (`deliveryHold.payloadId`). */
  payloadId: string;
  /** The held attempt's id, as the caller read it (`deliveryHold.attemptId`); null never matches. */
  attemptId: string | null;
  action: RelayHoldAction;
  /** The delivery id a confirmed reply closes under (`relay:<id>`, what its send carried). */
  sentRequestId: string;
  now?: number;
}

/** Why {@link resolveRelayDeliveryHold} refused. Every refusal writes nothing. */
export type RelayHoldRefusal =
  /** No such relay. */
  | 'not_found'
  /** No hold at all (queued, delivered, or resolved already). */
  | 'no_hold'
  /** A delivery is typing it right now; only its own result settles it. */
  | 'attempting'
  /** The hold names another payload or attempt than the caller's (an older screen, a second operation). */
  | 'stale'
  /** The hold is not one this action may settle (closed relay retried, deadline passed, no attempt id). */
  | 'not_allowed';

/** What {@link resolveRelayDeliveryHold} answers. */
export type ResolveRelayDeliveryHoldResult =
  | {
      ok: true;
      relay: SessionRelay;
      /** `retry`: the payload is queued again (not sent yet). */
      requeued: boolean;
      /** A reply waiting behind a prompt notice took the first slot. */
      promoted: boolean;
      /**
       * Issue #4082: a reply that waited behind the settled notice of a CLOSED
       * relay (the expiry sweep keeps it while the notice is held) was dropped
       * in the same transaction — it is never delivered from a closed relay.
       * Its payload id, or null when the slot could not be read. Null when
       * nothing was dropped.
       */
      discardedReply: { payloadId: string | null } | null;
    }
  | { ok: false; refusal: RelayHoldRefusal; message: string; relay: SessionRelay | null };

interface HeldRow {
  state: string;
  expires_at: number;
  pending_kind: string | null;
  payload_id: string | null;
  pending_reply: string | null;
  delivery_state: string | null;
  delivery_attempt_id: string | null;
}

/** The second slot's reply, or null when it cannot be read. */
function readPendingReply(text: string): { body: string; payloadId: string; overlap: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { body, payloadId, overlap } = parsed as { body?: unknown; payloadId?: unknown; overlap?: unknown };
  if (typeof body !== 'string' || typeof payloadId !== 'string') return null;
  return { body, payloadId, overlap: typeof overlap === 'string' ? overlap : null };
}

/** Thrown inside the transaction when a guarded write lost; rolls everything back. */
class RelayHoldConflict extends Error {}

/** `SET` assignments that drop the delivery hold. */
const DROP_HOLD_SET = `
  delivery_state = NULL, delivery_attempt_id = NULL, delivery_owner = NULL,
  delivery_reason = NULL, delivery_at = NULL
`;

/** The guard every resolve write carries: the hold the caller named, unchanged. */
const HELD_GUARD = `
  id = ? AND payload_id = ? AND delivery_attempt_id = ? AND delivery_state = 'uncertain' AND state = ?
`;

/**
 * Settle an `uncertain` delivery hold, once (Issue #4082).
 *
 * Keyed on the relay, the payload AND the attempt the caller read, and on the
 * hold still being `uncertain`: an operation from an older screen (the payload
 * was retried since, and a new attempt took it), a second operation on the
 * same hold, and a hold whose delivery is typing (`attempting`) are refused,
 * and nothing is written. Every write — the close, the emptied slots, the
 * promoted reply — commits in ONE transaction; a database error rolls all of
 * it back and is thrown (the caller answers 500).
 *
 * | payload | relay | confirm | retry | discard |
 * |---|---|---|---|---|
 * | reply | open | close `delivered`, slots emptied | queued again (deadline not passed) | close `cancelled`, both slots emptied |
 * | prompt | open | slot emptied, the waiting reply promoted | queued again (deadline not passed) | as confirm |
 * | expired | (closed) | slot emptied | queued again | slot emptied |
 * | reply / prompt | closed | slot emptied, state kept | refused | slot emptied, state kept |
 *
 * Issue #4082: a closed relay's reply waiting in the second slot (the expiry
 * sweep keeps it while the notice in front of it is held) is dropped by the
 * confirm / discard that empties the slot, and reported as `discardedReply`.
 *
 * `prompt_signature` is kept, so the same dialog is not told again; the send
 * binding's `send_state` / `hold_reason` / observation are not touched.
 * Nothing here types: a retried payload goes out through the pump.
 */
export function resolveRelayDeliveryHold(
  db: Database.Database,
  input: ResolveRelayDeliveryHoldInput
): ResolveRelayDeliveryHoldResult {
  const now = input.now ?? Date.now();
  type Discarded = { payloadId: string | null } | null;
  type Decided =
    | { ok: true; requeued: boolean; promoted: boolean; discardedReply?: Discarded }
    | { ok: false; refusal: RelayHoldRefusal; message: string };

  const refuse = (refusal: RelayHoldRefusal, message: string): Decided => ({ ok: false, refusal, message });

  const decide = (): Decided => {
    const row = db
      .prepare(`
        SELECT state, expires_at, pending_kind, payload_id, pending_reply, delivery_state, delivery_attempt_id
        FROM session_relays WHERE id = ?
      `)
      .get(input.relayId) as HeldRow | undefined;
    if (!row) return refuse('not_found', `Relay '${input.relayId}' not found`);
    if (row.delivery_state === null) return refuse('no_hold', 'The relay has no delivery hold (resolved, delivered or queued)');
    if (row.delivery_state === 'attempting') {
      return refuse('attempting', 'The payload is being delivered right now; only that delivery settles it');
    }
    if (row.delivery_state !== 'uncertain') return refuse('not_allowed', `Unknown delivery state '${row.delivery_state}'`);
    if (row.delivery_attempt_id === null || row.payload_id === null || input.attemptId === null) {
      return refuse('not_allowed', 'The hold carries no attempt id and cannot be resolved');
    }
    if (row.payload_id !== input.payloadId || row.delivery_attempt_id !== input.attemptId) {
      return refuse('stale', 'The hold names another payload or attempt (read the relay again)');
    }
    const kind = row.pending_kind;
    if (kind !== 'reply' && kind !== 'prompt' && kind !== 'expired') {
      return refuse('not_allowed', 'The held slot carries no payload');
    }
    const open = isOpenRelayState(row.state as SessionRelay['state']);

    // A guarded write that does not take exactly one row rolls the whole
    // transaction back; `false` is never read as success.
    const guarded = (setClause: string, ...setParams: (string | number)[]): void => {
      const result = db
        .prepare(`UPDATE session_relays SET ${setClause}, updated_at = ? WHERE ${HELD_GUARD}`)
        .run(...setParams, now, input.relayId, input.payloadId, input.attemptId as string, row.state);
      if (result.changes !== 1) throw new RelayHoldConflict('hold changed underneath the resolve');
    };
    const emptySlot = `pending_kind = NULL, pending_body = NULL, payload_id = NULL, ${DROP_HOLD_SET}`;

    if (input.action === 'retry') {
      if (kind !== 'expired') {
        if (!open) return refuse('not_allowed', `Relay is already ${row.state}; a closed relay's ${kind} is not sent again`);
        if (row.expires_at <= now) return refuse('not_allowed', 'Relay has passed its deadline; its payload is not sent again');
      }
      guarded(DROP_HOLD_SET);
      return { ok: true, requeued: true, promoted: false };
    }

    if (kind === 'reply' && open) {
      if (input.action === 'confirm') {
        guarded(
          `state = 'delivered', sent_request_id = COALESCE(sent_request_id, ?), delivered_at = ?,
           ${emptySlot}, pending_reply = NULL`,
          input.sentRequestId,
          now
        );
      } else {
        guarded(`state = 'cancelled', ${emptySlot}, pending_reply = NULL`);
      }
      return { ok: true, requeued: false, promoted: false };
    }

    if (!open && row.pending_reply !== null) {
      // Issue #4082: a closed relay delivers nothing more. The reply the
      // expiry sweep kept behind the held notice is dropped here, with the
      // slot, in this transaction — explicitly, so the requester is told.
      guarded(`${emptySlot}, pending_reply = NULL`);
      const dropped = readPendingReply(row.pending_reply);
      return { ok: true, requeued: false, promoted: false, discardedReply: { payloadId: dropped?.payloadId ?? null } };
    }
    guarded(emptySlot);
    if (kind !== 'prompt' || !open || row.pending_reply === null) {
      return { ok: true, requeued: false, promoted: false };
    }
    // The reply that finished while the notice was held takes the slot now,
    // in this same transaction: nothing can stash in between.
    const reply = readPendingReply(row.pending_reply);
    if (!reply) {
      // Unreadable: dropped, exactly as `promoteRelayPendingReply` drops it.
      logger.warn('relay-hold-resolve-unreadable-pending-reply', { relayId: input.relayId });
      db.prepare('UPDATE session_relays SET pending_reply = NULL WHERE id = ?').run(input.relayId);
      return { ok: true, requeued: false, promoted: false };
    }
    const promoted = db
      .prepare(`
        UPDATE session_relays
        SET pending_kind = 'reply', pending_body = ?, payload_id = ?, overlap = ?,
            pending_reply = NULL, updated_at = ?
        WHERE id = ? AND pending_kind IS NULL AND delivery_state IS NULL AND state = ?
      `)
      .run(
        reply.body,
        reply.payloadId,
        reply.overlap,
        now,
        input.relayId,
        row.state
      );
    if (promoted.changes !== 1) throw new RelayHoldConflict('pending reply could not be promoted');
    return { ok: true, requeued: false, promoted: true };
  };

  // The relay the answer carries is read INSIDE the transaction, before it
  // commits: a read that fails after the commit would answer 500 for a hold
  // already settled (and, for a retry, before the pump was asked to send it).
  // Failing here rolls the settle back with it, so a 500 still means
  // "nothing was committed".
  const decideAndRead = (): { decided: Decided; relay: SessionRelay | null } => {
    const decided = decide();
    const relay = getRelayById(db, input.relayId);
    if (decided.ok && !relay) throw new Error(`Relay '${input.relayId}' vanished while its hold was resolved`);
    return { decided, relay };
  };

  let settled: { decided: Decided; relay: SessionRelay | null };
  try {
    settled = db.transaction(decideAndRead).immediate();
  } catch (error) {
    if (!(error instanceof RelayHoldConflict)) throw error;
    // Rolled back: nothing was written, so a failing read here commits nothing either.
    settled = {
      decided: refuse('stale', 'The hold changed while it was being resolved (read the relay again)'),
      relay: getRelayById(db, input.relayId),
    };
  }
  const { decided, relay } = settled;
  if (!decided.ok) return { ...decided, relay };
  return {
    ok: true,
    relay: relay as SessionRelay,
    requeued: decided.requeued,
    promoted: decided.promoted,
    discardedReply: decided.discardedReply ?? null,
  };
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
