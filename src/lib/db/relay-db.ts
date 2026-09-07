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
  RelayCounts,
  RelayEndpoint,
  RelayPendingKind,
  RelayState,
  SessionRelay,
  SessionRelaySummary,
} from '@/lib/relay/types';
import { emptyRelayCounts, OPEN_RELAY_STATES } from '@/lib/relay/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-db');

/** Every column, in one place, so the readers cannot drift from each other. */
const RELAY_COLUMNS = `
  id, from_worktree_id, from_instance_id, to_worktree_id, to_instance_id,
  state, hops, sent_request_id, pending_kind, pending_body, prompt_signature,
  created_at, updated_at, expires_at, delivered_at
`;

interface SessionRelayRow {
  id: string;
  from_worktree_id: string;
  from_instance_id: string;
  to_worktree_id: string;
  to_instance_id: string;
  state: string;
  hops: number;
  sent_request_id: string | null;
  pending_kind: string | null;
  pending_body: string | null;
  prompt_signature: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  delivered_at: number | null;
}

function mapRelay(row: SessionRelayRow): SessionRelay {
  return {
    id: row.id,
    from: { worktreeId: row.from_worktree_id, instanceId: row.from_instance_id },
    to: { worktreeId: row.to_worktree_id, instanceId: row.to_instance_id },
    state: row.state as RelayState,
    hops: row.hops,
    sentRequestId: row.sent_request_id,
    pendingKind: (row.pending_kind as RelayPendingKind | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
  };
}

/** A relay row plus the body waiting to be delivered. Pump-only. */
export interface RelayWithPendingPayload {
  relay: SessionRelay;
  kind: RelayPendingKind;
  body: string;
}

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
}

/** Insert a new `pending` relay and hand it back. */
export function createRelay(db: Database.Database, input: CreateRelayInput): SessionRelay {
  const id = randomUUID();
  const now = input.now ?? Date.now();

  db.prepare(`
    INSERT INTO session_relays
      (id, from_worktree_id, from_instance_id, to_worktree_id, to_instance_id,
       state, hops, sent_request_id, pending_kind, pending_body, prompt_signature,
       created_at, updated_at, expires_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)
  `).run(
    id,
    input.from.worktreeId,
    input.from.instanceId,
    input.to.worktreeId,
    input.to.instanceId,
    input.hops,
    now,
    now,
    input.expiresAt
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
  };
}

/** One relay by id, or null. */
export function getRelayById(db: Database.Database, id: string): SessionRelay | null {
  const row = db
    .prepare(`SELECT ${RELAY_COLUMNS} FROM session_relays WHERE id = ?`)
    .get(id) as SessionRelayRow | undefined;
  return row ? mapRelay(row) : null;
}

/** Placeholders for an `IN (…)` over the open states. */
const OPEN_STATE_PLACEHOLDERS = OPEN_RELAY_STATES.map(() => '?').join(', ');

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
 * Record a payload that has been decided and not yet delivered.
 *
 * Guarded on `pending_kind IS NULL`, which is what makes two producers finding
 * the same finished turn cost ONE delivery: the second one loses the race and
 * returns false rather than queueing a duplicate. The guard is released by
 * {@link clearRelayPending} once the payload has actually gone out, so the same
 * relay can carry a prompt notice now and a reply later.
 *
 * @returns Whether this call is the one that stashed it
 */
export function stashRelayPayload(
  db: Database.Database,
  id: string,
  kind: RelayPendingKind,
  body: string,
  now = Date.now()
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays
      SET pending_kind = ?, pending_body = ?, updated_at = ?
      WHERE id = ? AND pending_kind IS NULL
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(kind, body, now, id, ...OPEN_RELAY_STATES);
  return result.changes === 1;
}

/** Every relay carrying an undelivered payload, oldest first. */
export function listRelaysWithPendingPayload(
  db: Database.Database
): RelayWithPendingPayload[] {
  const rows = db
    .prepare(`
      SELECT ${RELAY_COLUMNS} FROM session_relays
      WHERE pending_kind IS NOT NULL
      ORDER BY updated_at ASC
    `)
    .all() as SessionRelayRow[];
  return rows
    .filter((row) => row.pending_body !== null && row.pending_kind !== null)
    .map((row) => ({
      relay: mapRelay(row),
      kind: row.pending_kind as RelayPendingKind,
      body: row.pending_body as string,
    }));
}

/** Drop an undelivered payload (it went out, or it was superseded). */
export function clearRelayPending(
  db: Database.Database,
  id: string,
  now = Date.now()
): void {
  db.prepare(`
    UPDATE session_relays
    SET pending_kind = NULL, pending_body = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, id);
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
    const result = db
      .prepare(`
        UPDATE session_relays
        SET state = 'delivered', sent_request_id = ?, delivered_at = ?,
            pending_kind = NULL, pending_body = NULL, updated_at = ?
        WHERE id = ? AND sent_request_id IS NULL
          AND state IN (${OPEN_STATE_PLACEHOLDERS})
      `)
      .run(sentRequestId, now, now, id, ...OPEN_RELAY_STATES);
    return result.changes === 1;
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

/** Withdraw a relay. Returns false when it was already closed or absent. */
export function cancelRelay(
  db: Database.Database,
  id: string,
  now = Date.now()
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays
      SET state = 'cancelled', pending_kind = NULL, pending_body = NULL, updated_at = ?
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
