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
  RelayBoundaryKind,
  RelayCounts,
  RelayEndpoint,
  RelayObsState,
  RelayOverlap,
  RelayPendingKind,
  RelaySendState,
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
  created_at, updated_at, expires_at, delivered_at,
  bind_mode, send_state, input_boundary_at, boundary_kind, turn_open_at_send,
  obs_state, hold_reason, overlap
`;

/**
 * The v62 columns no public reader sees (Issue #3957): the reservation token
 * and its owner, the observation's source, the send's own user row, and the
 * two JSON slots. Read only by the send binding and the delivery.
 */
const RELAY_BINDING_COLUMNS = `
  bind_attempt_id, bind_owner, obs_source, input_message_id,
  held_candidates, pending_reply, payload_id
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
  bind_mode: string;
  send_state: string | null;
  input_boundary_at: number | null;
  boundary_kind: string | null;
  turn_open_at_send: number | null;
  obs_state: string | null;
  hold_reason: string | null;
  overlap: string | null;
}

interface SessionRelayBindingRow extends SessionRelayRow {
  bind_attempt_id: string | null;
  bind_owner: string | null;
  obs_source: string | null;
  input_message_id: string | null;
  held_candidates: string | null;
  pending_reply: string | null;
  payload_id: string | null;
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
    bindMode: (row.bind_mode as RelayBindMode | null) ?? 'legacy',
    sendState: (row.send_state as RelaySendState | null) ?? null,
    inputBoundaryAt: row.input_boundary_at,
    boundaryKind: (row.boundary_kind as RelayBoundaryKind | null) ?? null,
    turnOpenAtSend: row.turn_open_at_send === null ? null : row.turn_open_at_send === 1,
    obsState: (row.obs_state as RelayObsState | null) ?? null,
    holdReason: row.hold_reason,
    overlap: (row.overlap as RelayOverlap | null) ?? null,
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
  now = Date.now(),
  options: StashRelayPayloadOptions = {}
): boolean {
  // Issue #3957: every payload gets its own id, so the delivery that sent it
  // clears THAT payload and not a newer one stashed while it was sending.
  const payloadId = options.payloadId ?? randomUUID();
  const result = db
    .prepare(`
      UPDATE session_relays
      SET pending_kind = ?, pending_body = ?, payload_id = ?,
          overlap = COALESCE(?, overlap), updated_at = ?
      WHERE id = ? AND pending_kind IS NULL
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(kind, body, payloadId, options.overlap ?? null, now, id, ...OPEN_RELAY_STATES);
  return result.changes === 1;
}

/** What {@link stashRelayPayload} may record beside the payload (Issue #3957). */
export interface StashRelayPayloadOptions {
  /** The payload's id; minted when omitted. */
  payloadId?: string;
  /** For a reply: what the delivery could prove about sharing a turn. */
  overlap?: RelayOverlap;
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

/**
 * Drop an undelivered payload (it went out, or it was superseded).
 *
 * Issue #3957: with `payloadId` the clear only takes the payload it names. The
 * delivery passes the id it sent, so a reply stashed over a prompt notice while
 * that notice was being typed survives the notice's cleanup.
 *
 * @returns Whether a payload was cleared
 */
export function clearRelayPending(
  db: Database.Database,
  id: string,
  now = Date.now(),
  payloadId?: string | null
): boolean {
  const result =
    payloadId === undefined
      ? db
          .prepare(`
            UPDATE session_relays
            SET pending_kind = NULL, pending_body = NULL, payload_id = NULL, updated_at = ?
            WHERE id = ?
          `)
          .run(now, id)
      : db
          .prepare(`
            UPDATE session_relays
            SET pending_kind = NULL, pending_body = NULL, payload_id = NULL, updated_at = ?
            WHERE id = ? AND payload_id IS ?
          `)
          .run(now, id, payloadId);
  return result.changes === 1;
}

/** The payload a relay carries now, with its id, or null (Issue #3957). */
export function getRelayPendingPayload(
  db: Database.Database,
  id: string
): (RelayWithPendingPayload & { payloadId: string | null }) | null {
  const row = db
    .prepare(`SELECT ${RELAY_COLUMNS}, payload_id FROM session_relays WHERE id = ?`)
    .get(id) as (SessionRelayRow & { payload_id: string | null }) | undefined;
  if (!row || row.pending_kind === null || row.pending_body === null) return null;
  return {
    relay: mapRelay(row),
    kind: row.pending_kind as RelayPendingKind,
    body: row.pending_body,
    payloadId: row.payload_id,
  };
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
            pending_kind = NULL, pending_body = NULL, payload_id = NULL, updated_at = ?
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
      SET state = 'cancelled', pending_kind = NULL, pending_body = NULL, payload_id = NULL,
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

// ---------------------------------------------------------------------------
// Issue #3957: the relay bound to its send (v62)
// ---------------------------------------------------------------------------

/** A completion seen before the bound send settled: the reply row it pointed at. */
export interface RelayHeldCandidate {
  messageId: string;
  /** The row's own timestamp, epoch ms. */
  timestamp: number;
  requestId: string | null;
}

/** A reply finished while a prompt notice held the pending slot (the second slot). */
export interface RelayPendingReply {
  /** The reply row the body was built from. */
  candidateId: string;
  body: string;
  /** Null for a legacy relay, whose reply is not judged. */
  overlap: RelayOverlap | null;
  /** Why the overlap reads as it does; kept for the log and the system line. */
  basis: string;
  payloadId: string;
}

/** A relay row with the v62 columns no public reader sees. */
export interface RelayBinding {
  relay: SessionRelay;
  bindAttemptId: string | null;
  bindOwner: string | null;
  obsSource: string | null;
  inputMessageId: string | null;
  heldCandidates: RelayHeldCandidate[];
  pendingReply: RelayPendingReply | null;
  payloadId: string | null;
  pendingKind: RelayPendingKind | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function mapBinding(row: SessionRelayBindingRow): RelayBinding {
  return {
    relay: mapRelay(row),
    bindAttemptId: row.bind_attempt_id,
    bindOwner: row.bind_owner,
    obsSource: row.obs_source,
    inputMessageId: row.input_message_id,
    heldCandidates: parseJson<RelayHeldCandidate[]>(row.held_candidates, []),
    pendingReply: parseJson<RelayPendingReply | null>(row.pending_reply, null),
    payloadId: row.payload_id,
    pendingKind: (row.pending_kind as RelayPendingKind | null) ?? null,
  };
}

/** One relay with its binding columns, or null. */
export function getRelayBinding(db: Database.Database, id: string): RelayBinding | null {
  const row = db
    .prepare(`SELECT ${RELAY_COLUMNS}, ${RELAY_BINDING_COLUMNS} FROM session_relays WHERE id = ?`)
    .get(id) as SessionRelayBindingRow | undefined;
  return row ? mapBinding(row) : null;
}

/** Every open bound relay, oldest first — the restart recovery's input. */
export function listOpenBoundRelays(db: Database.Database): RelayBinding[] {
  const rows = db
    .prepare(`
      SELECT ${RELAY_COLUMNS}, ${RELAY_BINDING_COLUMNS} FROM session_relays
      WHERE bind_mode = 'bound' AND state IN (${OPEN_STATE_PLACEHOLDERS})
      ORDER BY created_at ASC
    `)
    .all(...OPEN_RELAY_STATES) as SessionRelayBindingRow[];
  return rows.map(mapBinding);
}

/** What {@link reserveRelayBind} needs. */
export interface ReserveRelayBindInput {
  relayId: string;
  /** Fresh per send attempt; the only key later writes are accepted under. */
  attemptId: string;
  /** The server boot that holds the reservation. */
  owner: string;
  /** The send's own destination, already resolved. */
  worktreeId: string;
  instanceId: string;
  now?: number;
}

/**
 * Reserve a bound relay for one send attempt.
 *
 * One conditional UPDATE: a second send, a reused id, a closed or expired relay
 * or one aimed at another session all answer false, and nothing is written.
 */
export function reserveRelayBind(db: Database.Database, input: ReserveRelayBindInput): boolean {
  const now = input.now ?? Date.now();
  const result = db
    .prepare(`
      UPDATE session_relays SET bind_attempt_id = ?, bind_owner = ?, updated_at = ?
      WHERE id = ? AND bind_mode = 'bound' AND state = 'pending' AND send_state = 'awaiting'
        AND bind_attempt_id IS NULL AND expires_at > ?
        AND to_worktree_id = ? AND to_instance_id = ?
    `)
    .run(input.attemptId, input.owner, now, input.relayId, now, input.worktreeId, input.instanceId);
  return result.changes === 1;
}

/** Why {@link reserveRelayBind} said no, read back from the row. */
export type RelayBindRefusal =
  | { status: 400; code: 'RELAY_BIND_INVALID'; message: string }
  | { status: 409; code: 'RELAY_BIND_CONFLICT'; message: string };

/** Explain a failed reservation: 400 for a wrong id or destination, 409 for the rest. */
export function explainRelayBindRefusal(
  db: Database.Database,
  relayId: string,
  worktreeId: string,
  instanceId: string,
  now = Date.now()
): RelayBindRefusal {
  const binding = getRelayBinding(db, relayId);
  if (!binding) {
    return { status: 400, code: 'RELAY_BIND_INVALID', message: `Relay '${relayId}' not found` };
  }
  const { relay } = binding;
  if (relay.bindMode !== 'bound') {
    return { status: 400, code: 'RELAY_BIND_INVALID', message: `Relay '${relayId}' was not opened for binding` };
  }
  if (relay.to.worktreeId !== worktreeId || relay.to.instanceId !== instanceId) {
    return {
      status: 400,
      code: 'RELAY_BIND_INVALID',
      message: `Relay '${relayId}' is addressed to ${relay.to.worktreeId}/${relay.to.instanceId}, not this send`,
    };
  }
  if (relay.state !== 'pending') {
    return { status: 409, code: 'RELAY_BIND_CONFLICT', message: `Relay '${relayId}' is already ${relay.state}` };
  }
  if (relay.expiresAt <= now) {
    return { status: 409, code: 'RELAY_BIND_CONFLICT', message: `Relay '${relayId}' has expired` };
  }
  return { status: 409, code: 'RELAY_BIND_CONFLICT', message: `Relay '${relayId}' is already bound to a send` };
}

/** What {@link recordRelayInputBoundary} writes, in one statement. */
export interface RecordRelayInputBoundaryInput {
  relayId: string;
  attemptId: string;
  at: number;
  kind: RelayBoundaryKind;
  turnOpenAtSend: boolean | null;
  obsState: RelayObsState;
  obsSource: string;
  /** True only when an earlier `dispatch` boundary is known not to have sent. */
  replaceDispatch: boolean;
  now?: number;
}

/**
 * Record where the send's input began — in the same synchronous step as the
 * first key, under the attempt's token.
 *
 * @returns Whether it was written; false means the input must not start
 */
export function recordRelayInputBoundary(
  db: Database.Database,
  input: RecordRelayInputBoundaryInput
): boolean {
  const now = input.now ?? Date.now();
  const result = db
    .prepare(`
      UPDATE session_relays
      SET send_state = 'input_started', input_boundary_at = ?, boundary_kind = ?,
          turn_open_at_send = ?, obs_state = ?, obs_source = ?, updated_at = ?
      WHERE id = ? AND bind_attempt_id = ? AND state = 'pending' AND expires_at > ?
        AND (send_state = 'awaiting'
          OR (? = 1 AND send_state = 'input_started' AND boundary_kind = 'dispatch'))
    `)
    .run(
      input.at,
      input.kind,
      input.turnOpenAtSend === null ? null : input.turnOpenAtSend ? 1 : 0,
      input.obsState,
      input.obsSource,
      now,
      input.relayId,
      input.attemptId,
      now,
      input.replaceDispatch ? 1 : 0
    );
  return result.changes === 1;
}

/** What {@link settleRelaySendState} moves, and from where. */
export interface SettleRelaySendStateInput {
  relayId: string;
  attemptId: string;
  from: readonly RelaySendState[];
  to: Extract<RelaySendState, 'sent' | 'failed' | 'unknown'>;
  holdReason?: string | null;
  /** For `sent`: the send's own user row. */
  inputMessageId?: string | null;
  /** Mark the observation invalid in the same write (a relaunch during the send). */
  invalidateObservation?: boolean;
  /** Drop the hold reason (a held send that turned out delivered). */
  clearHoldReason?: boolean;
  now?: number;
}

/**
 * Move a bound send to its outcome, under the attempt's token and the state it
 * is expected to be in. A cancelled or expired relay is never moved back.
 */
export function settleRelaySendState(db: Database.Database, input: SettleRelaySendStateInput): boolean {
  const now = input.now ?? Date.now();
  const fromPlaceholders = input.from.map(() => '?').join(', ');
  const result = db
    .prepare(`
      UPDATE session_relays
      SET send_state = ?,
          hold_reason = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, hold_reason) END,
          input_message_id = COALESCE(?, input_message_id),
          obs_state = CASE WHEN ? = 1 THEN 'invalid' ELSE obs_state END,
          updated_at = ?
      WHERE id = ? AND bind_attempt_id = ? AND send_state IN (${fromPlaceholders})
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(
      input.to,
      input.clearHoldReason ? 1 : 0,
      input.holdReason ?? null,
      input.inputMessageId ?? null,
      input.invalidateObservation ? 1 : 0,
      now,
      input.relayId,
      input.attemptId,
      ...input.from,
      ...OPEN_RELAY_STATES
    );
  return result.changes === 1;
}

/** Note why a relay is held, optionally invalidating its observation. */
export function setRelayHold(
  db: Database.Database,
  id: string,
  reason: string,
  options: { invalidate?: boolean; now?: number } = {}
): void {
  db.prepare(`
    UPDATE session_relays
    SET hold_reason = ?, obs_state = CASE WHEN ? = 1 THEN 'invalid' ELSE obs_state END, updated_at = ?
    WHERE id = ?
  `).run(reason, options.invalidate ? 1 : 0, options.now ?? Date.now(), id);
}

/**
 * Keep a completion that arrived before the bound send settled.
 *
 * Appended in arrival order and never replaced by a later one: the earliest
 * candidate at or after the boundary is the one taken once the send is
 * confirmed. A row already held is not added twice.
 *
 * @returns Whether the candidate was added
 */
export function appendRelayHeldCandidate(
  db: Database.Database,
  id: string,
  candidate: RelayHeldCandidate,
  now = Date.now()
): boolean {
  return db.transaction((): boolean => {
    const row = db
      .prepare(`
        SELECT held_candidates FROM session_relays
        WHERE id = ? AND bind_mode = 'bound' AND send_state IN ('awaiting','input_started')
          AND state IN (${OPEN_STATE_PLACEHOLDERS})
      `)
      .get(id, ...OPEN_RELAY_STATES) as { held_candidates: string | null } | undefined;
    if (!row) return false;
    const held = parseJson<RelayHeldCandidate[]>(row.held_candidates, []);
    if (held.some((item) => item.messageId === candidate.messageId)) return false;
    held.push(candidate);
    db.prepare('UPDATE session_relays SET held_candidates = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(held),
      now,
      id
    );
    return true;
  })();
}

/** Forget the held candidates (they were judged). */
export function clearRelayHeldCandidates(db: Database.Database, id: string): void {
  db.prepare('UPDATE session_relays SET held_candidates = NULL WHERE id = ?').run(id);
}

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
 * Replace an unclaimed prompt notice with the reply that made it moot.
 *
 * Conditional on the notice's own payload id, so a notice that was replaced or
 * delivered meanwhile is not overwritten.
 */
export function replaceRelayPromptWithReply(
  db: Database.Database,
  id: string,
  promptPayloadId: string | null,
  reply: RelayPendingReply,
  now = Date.now()
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays
      SET pending_kind = 'reply', pending_body = ?, payload_id = ?, overlap = ?, updated_at = ?
      WHERE id = ? AND pending_kind = 'prompt' AND payload_id IS ?
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(reply.body, reply.payloadId, reply.overlap, now, id, promptPayloadId, ...OPEN_RELAY_STATES);
  return result.changes === 1;
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
 * replaced meanwhile is left alone and the reply is not moved twice.
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

/** Cancel a relay as part of the restart recovery, recording why. */
export function failOrphanedRelayBind(
  db: Database.Database,
  id: string,
  attemptId: string,
  reason: string,
  now = Date.now()
): boolean {
  const result = db
    .prepare(`
      UPDATE session_relays
      SET send_state = 'failed', state = 'cancelled', hold_reason = ?,
          pending_kind = NULL, pending_body = NULL, payload_id = NULL, pending_reply = NULL,
          updated_at = ?
      WHERE id = ? AND bind_attempt_id = ? AND send_state = 'awaiting'
        AND state IN (${OPEN_STATE_PLACEHOLDERS})
    `)
    .run(reason, now, id, attemptId, ...OPEN_RELAY_STATES);
  return result.changes === 1;
}
