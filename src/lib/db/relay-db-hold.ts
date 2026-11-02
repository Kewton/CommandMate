/**
 * Resolving an `uncertain` delivery hold on a relay (Issue #4082).
 *
 * Split out of `relay-db` (Issue #4096); `relay-db` re-exports every name here,
 * so callers (and every `vi.mock`) keep importing from `@/lib/db/relay-db`.
 * This module must not import `relay-db` (no cycle).
 *
 * @module lib/db/relay-db-hold
 */

import Database from 'better-sqlite3';
import type { RelayHoldAction, SessionRelay } from '@/lib/relay/types';
import { isOpenRelayState } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';
import { getRelayById } from '@/lib/db/relay-db-base';

const logger = createLogger('relay-db');

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
      /**
       * Issue #4082: an open relay past its deadline (not swept yet) was
       * closed as `expired` by settling its held prompt notice — no expiry
       * notice is queued; the caller writes the usual `expired` history line.
       */
      expired: boolean;
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

type HeldKind = 'reply' | 'prompt' | 'expired';

type HoldDecided =
  | { ok: true; requeued: boolean; promoted: boolean; discardedReply?: { payloadId: string | null } | null; expired?: boolean }
  | HoldRefused;

type HoldRefused = { ok: false; refusal: RelayHoldRefusal; message: string };

/** What the per-action steps of {@link resolveRelayDeliveryHold} work on. */
interface HoldContext {
  db: Database.Database;
  input: ResolveRelayDeliveryHoldInput;
  now: number;
  row: HeldRow;
  kind: HeldKind;
  open: boolean;
  guarded: (setClause: string, ...setParams: (string | number)[]) => void;
}

const EMPTY_SLOT_SET = `pending_kind = NULL, pending_body = NULL, payload_id = NULL, ${DROP_HOLD_SET}`;

function refuseHold(refusal: RelayHoldRefusal, message: string): HoldRefused {
  return { ok: false, refusal, message };
}

/** Read the held row and refuse it unless it is an `uncertain` hold the caller named. */
function readResolvableHold(
  db: Database.Database,
  input: ResolveRelayDeliveryHoldInput
): { ok: true; row: HeldRow; kind: HeldKind } | HoldRefused {
  const refuse = refuseHold;
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
  return { ok: true, row, kind };
}

/** `retry`: queue the held payload again (not sent here). */
function retryHold({ row, kind, open, now, guarded }: HoldContext): HoldDecided {
  if (kind !== 'expired') {
    if (!open) return refuseHold('not_allowed', `Relay is already ${row.state}; a closed relay's ${kind} is not sent again`);
    if (row.expires_at <= now) return refuseHold('not_allowed', 'Relay has passed its deadline; its payload is not sent again');
  }
  guarded(DROP_HOLD_SET);
  return { ok: true, requeued: true, promoted: false };
}

/** `confirm` / `discard`: empty the held slot (and close or promote as the table says). */
function settleHold(ctx: HoldContext): HoldDecided {
  const { db, input, now, row, kind, open, guarded } = ctx;
  const emptySlot = EMPTY_SLOT_SET;

  if (kind === 'reply' && open) return settleOpenReply(ctx);

  if (kind === 'prompt' && open && row.expires_at <= now) {
    // Issue #4082: the deadline passed and the sweep has not run yet. The
    // relay ends here exactly as if the sweep had found the notice held:
    // closed as `expired`, no expiry notice queued for the composer, and a
    // waiting reply dropped explicitly (the requester is told) rather than
    // promoted — promoting it would only have let the sweep erase it
    // silently and queue a fresh expiry notice after the settle.
    guarded(`state = 'expired', ${emptySlot}, pending_reply = NULL`);
    const dropped = row.pending_reply === null ? null : readPendingReply(row.pending_reply);
    return {
      ok: true,
      requeued: false,
      promoted: false,
      expired: true,
      discardedReply: row.pending_reply === null ? null : { payloadId: dropped?.payloadId ?? null },
    };
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
  return promotePendingReplyAfterSettle(db, input, now, row, row.pending_reply);
}

/** `confirm` closes an open relay's held reply `delivered`; `discard` closes it `cancelled`. */
function settleOpenReply({ input, now, guarded }: HoldContext): HoldDecided {
  const emptySlot = EMPTY_SLOT_SET;
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

function promotePendingReplyAfterSettle(
  db: Database.Database,
  input: ResolveRelayDeliveryHoldInput,
  now: number,
  row: HeldRow,
  pendingReply: string
): HoldDecided {
  // The reply that finished while the notice was held takes the slot now,
  // in this same transaction: nothing can stash in between.
  const reply = readPendingReply(pendingReply);
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
}

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
 * A prompt notice on an OPEN relay whose deadline has passed (the sweep has
 * not run yet) is settled the same way, and the relay is closed `expired`
 * in the same write (`expired: true`) with no expiry notice queued — so
 * resolve-then-sweep ends where sweep-then-resolve does.
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
  type Decided = HoldDecided;

  const refuse = (refusal: RelayHoldRefusal, message: string): Decided => ({ ok: false, refusal, message });

  const decide = (): Decided => {
    const checked = readResolvableHold(db, input);
    if (!checked.ok) return checked;
    const { row, kind } = checked;
    const open = isOpenRelayState(row.state as SessionRelay['state']);

    // A guarded write that does not take exactly one row rolls the whole
    // transaction back; `false` is never read as success.
    const guarded = (setClause: string, ...setParams: (string | number)[]): void => {
      const result = db
        .prepare(`UPDATE session_relays SET ${setClause}, updated_at = ? WHERE ${HELD_GUARD}`)
        .run(...setParams, now, input.relayId, input.payloadId, input.attemptId as string, row.state);
      if (result.changes !== 1) throw new RelayHoldConflict('hold changed underneath the resolve');
    };
    const ctx: HoldContext = { db, input, now, row, kind, open, guarded };

    if (input.action === 'retry') return retryHold(ctx);
    return settleHold(ctx);
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
    expired: decided.expired === true,
  };
}
