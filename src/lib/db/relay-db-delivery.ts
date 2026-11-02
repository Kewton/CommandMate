/**
 * Closing a relay as delivered, and completing a reply's delivery (Issue #4064).
 *
 * Split out of `relay-db` (Issue #4096); `relay-db` re-exports every name here,
 * so callers (and every `vi.mock`) keep importing from `@/lib/db/relay-db`.
 * This module must not import `relay-db` (no cycle).
 *
 * @module lib/db/relay-db-delivery
 */

import Database from 'better-sqlite3';
import { OPEN_RELAY_STATES } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';
import {
  endRelayPayloadAttempt,
  isCurrentRelayPayloadAttempt,
  OPEN_STATE_PLACEHOLDERS,
  type RelayPayloadAttemptRef,
} from '@/lib/db/relay-bind-db';

const logger = createLogger('relay-db');

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
