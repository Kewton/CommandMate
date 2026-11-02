/**
 * The relay ledger's second slot — a reply waiting behind a prompt notice —
 * and the held count, split out of `relay-bind-db` (Issue #4095).
 *
 * `relay-bind-db` re-exports every public name here. This module imports only
 * `relay-bind-db-base`.
 *
 * @module lib/db/relay-bind-db-pending
 */

import Database from 'better-sqlite3';
import { OPEN_RELAY_STATES } from '@/lib/relay/types';
import { OPEN_STATE_PLACEHOLDERS, parseJson, type RelayPendingReply } from './relay-bind-db-base';

/**
 * Put a reply in the second slot while a prompt notice holds the first.
 *
 * Only one: the first reply to finish is the one kept.
 */
export function setRelayPendingReply(
  db: Database.Database,
  id: string,
  reply: RelayPendingReply,
  now = Date.now()
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays SET pending_reply = ?, updated_at = ?
      WHERE id = ? AND pending_kind = 'prompt' AND pending_reply IS NULL
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(JSON.stringify(reply), now, id, ...OPEN_RELAY_STATES);
  return result.changes === 1;
}

/**
 * What {@link replaceRelayPromptWithReply} put in the first slot: the reply it
 * was given, or (Issue #4082) the reply already waiting in the second slot.
 */
export type RelayPromptReplacement = 'reply' | 'waiting-reply';

/**
 * Replace an unclaimed prompt notice with the reply that made it moot.
 *
 * Conditional on the notice's own payload id, so a notice that was replaced or
 * delivered meanwhile is not overwritten — and (Issue #4064) on the notice not
 * being under a delivery hold: one whose delivery may have reached A is kept,
 * and the reply waits in the second slot behind it.
 *
 * Issue #4082: a reply already waiting in the second slot (it finished while
 * the notice was held, and the hold was then retried) goes first — the first
 * reply to finish is the one kept, as {@link setRelayPendingReply} keeps it —
 * and the given one is dropped. Either way the second slot is emptied in the
 * same write, so no older reply is left behind a closed relay. An unreadable
 * waiting reply is dropped and the given one takes the slot.
 *
 * @returns Which reply took the first slot, or null when nothing was replaced
 */
export function replaceRelayPromptWithReply(
  db: Database.Database,
  id: string,
  promptPayloadId: string | null,
  reply: RelayPendingReply,
  now = Date.now()
): RelayPromptReplacement | null {
  return db.transaction((): RelayPromptReplacement | null => {
    const row = db
      .prepare(`
        SELECT pending_reply FROM session_relays
        WHERE id = ? AND pending_kind = 'prompt' AND payload_id IS ? AND delivery_state IS NULL
          AND state IN (${OPEN_STATE_PLACEHOLDERS})
      `)
      .get(id, promptPayloadId, ...OPEN_RELAY_STATES) as { pending_reply: string | null } | undefined;
    if (!row) return null;
    const waiting = row.pending_reply === null ? null : parseJson<RelayPendingReply | null>(row.pending_reply, null);
    const taken = waiting ?? reply;
    db.prepare(`
      UPDATE session_relays
      SET pending_kind = 'reply', pending_body = ?, payload_id = ?, overlap = ?,
          pending_reply = NULL, updated_at = ?
      WHERE id = ?
    `).run(taken.body, taken.payloadId, taken.overlap, now, id);
    return waiting ? 'waiting-reply' : 'reply';
  })();
}

/**
 * Move the second slot into the first once the prompt notice is gone.
 *
 * Atomic: the reply becomes the pending payload and leaves `pending_reply` in
 * one write, so the pump finds it and nothing finds it twice.
 */
export function promoteRelayPendingReply(db: Database.Database, id: string, now = Date.now()): boolean {
  return db.transaction((): boolean => {
    const row = db
      .prepare(`
        SELECT pending_reply FROM session_relays
        WHERE id = ? AND pending_kind IS NULL AND pending_reply IS NOT NULL
          AND state IN (${OPEN_STATE_PLACEHOLDERS})
      `)
      .get(id, ...OPEN_RELAY_STATES) as { pending_reply: string } | undefined;
    if (!row) return false;
    const reply = parseJson<RelayPendingReply | null>(row.pending_reply, null);
    if (!reply) {
      db.prepare('UPDATE session_relays SET pending_reply = NULL WHERE id = ?').run(id);
      return false;
    }
    db.prepare(`
      UPDATE session_relays
      SET pending_kind = 'reply', pending_body = ?, payload_id = ?, overlap = ?,
          pending_reply = NULL, updated_at = ?
      WHERE id = ?
    `).run(reply.body, reply.payloadId, reply.overlap, now, id);
    return true;
  })();
}

/**
 * A prompt notice whose delivery did not go out, while a reply waits in the
 * second slot: the reply takes the first slot in its place (Issue #3957).
 *
 * Conditional on the notice's own payload id, in one transaction, so a notice
 * replaced meanwhile is left alone and the reply is not moved twice. Issue
 * #4064: never a notice under a delivery hold.
 */
export function replaceRelayPromptWithPendingReply(
  db: Database.Database,
  id: string,
  promptPayloadId: string | null,
  now = Date.now()
): boolean {
  return db.transaction((): boolean => {
    const row = db
      .prepare(`
        SELECT pending_reply FROM session_relays
        WHERE id = ? AND pending_kind = 'prompt' AND payload_id IS ? AND pending_reply IS NOT NULL
          AND delivery_state IS NULL
          AND state IN (${OPEN_STATE_PLACEHOLDERS})
      `)
      .get(id, promptPayloadId, ...OPEN_RELAY_STATES) as { pending_reply: string } | undefined;
    if (!row) return false;
    const reply = parseJson<RelayPendingReply | null>(row.pending_reply, null);
    if (!reply) return false;
    db.prepare(`
      UPDATE session_relays
      SET pending_kind = 'reply', pending_body = ?, payload_id = ?, overlap = ?,
          pending_reply = NULL, updated_at = ?
      WHERE id = ?
    `).run(reply.body, reply.payloadId, reply.overlap, now, id);
    return true;
  })();
}

/** Empty the second slot (an expiry or a cancel supersedes it). */
export function clearRelayPendingReply(db: Database.Database, id: string, now = Date.now()): void {
  db.prepare('UPDATE session_relays SET pending_reply = NULL, updated_at = ? WHERE id = ?').run(now, id);
}

/**
 * Empty the second slot unless the first is under a delivery hold (Issue #4082).
 *
 * For the expiry sweep: a reply waiting behind a held notice is kept, so that
 * settling the hold later decides what happens to it (a closed relay's waiting
 * reply is then discarded explicitly, with a line in the requester's history).
 * A cancel still empties it unconditionally ({@link clearRelayPendingReply}).
 *
 * @returns Whether the slot was emptied (false also when it was already empty)
 */
export function clearRelayPendingReplyUnlessHeld(
  db: Database.Database,
  id: string,
  now = Date.now()
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays SET pending_reply = NULL, updated_at = ?
      WHERE id = ? AND pending_reply IS NOT NULL AND delivery_state IS NULL
    `)
    .run(now, id);
  return result.changes === 1;
}

/**
 * How many payloads are held as `uncertain` (Issue #4082): the held axis of
 * the relay counts, apart from the per-state counts. Open relays and closed
 * ones alike, one per row (a row holds at most one payload), `attempting`
 * not included (it is still pending), and never narrowed by a period — a hold
 * is something to settle now, however old its relay.
 */
export function countHeldRelays(
  db: Database.Database,
  scope: { worktreeId?: string; instanceId?: string } = {}
): number {
  const clauses = ["delivery_state = 'uncertain'"];
  const params: string[] = [];
  if (scope.worktreeId && scope.instanceId) {
    clauses.push(
      '((from_worktree_id = ? AND from_instance_id = ?) OR (to_worktree_id = ? AND to_instance_id = ?))'
    );
    params.push(scope.worktreeId, scope.instanceId, scope.worktreeId, scope.instanceId);
  } else if (scope.worktreeId) {
    clauses.push('(from_worktree_id = ? OR to_worktree_id = ?)');
    params.push(scope.worktreeId, scope.worktreeId);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM session_relays WHERE ${clauses.join(' AND ')}`)
    .get(...params) as { n: number };
  return row.n;
}
