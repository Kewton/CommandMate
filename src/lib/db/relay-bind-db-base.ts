/**
 * The relay ledger's shared row shape, mapper and SQL fragments, split out of
 * `relay-bind-db` (Issue #4095). Imported by `relay-bind-db` and its other
 * split modules; this module imports none of them.
 *
 * @module lib/db/relay-bind-db-base
 */

import type {
  RelayBindMode,
  RelayBoundaryKind,
  RelayDeliveryHold,
  RelayDeliveryState,
  RelayObsState,
  RelayOverlap,
  RelayPendingKind,
  RelaySendState,
  RelayState,
  SessionRelay,
} from '@/lib/relay/types';
import { OPEN_RELAY_STATES, relayRequesterPaneCommand } from '@/lib/relay/types';

/** Every column, in one place, so the readers cannot drift from each other. */
export const RELAY_COLUMNS = `
  id, from_worktree_id, from_instance_id, to_worktree_id, to_instance_id,
  state, hops, sent_request_id, pending_kind, pending_body, prompt_signature,
  created_at, updated_at, expires_at, delivered_at,
  bind_mode, send_state, input_boundary_at, boundary_kind, turn_open_at_send,
  obs_state, hold_reason, overlap,
  delivery_state, delivery_reason, delivery_at,
  CASE WHEN delivery_state IS NULL THEN NULL ELSE payload_id END AS delivery_payload_id,
  CASE WHEN delivery_state IS NULL THEN NULL ELSE delivery_attempt_id END AS delivery_hold_attempt_id
`;

export interface SessionRelayRow {
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
  /** Issue #4064 (v63). */
  delivery_state: string | null;
  delivery_reason: string | null;
  delivery_at: number | null;
  /** `payload_id`, only while a delivery hold names it. */
  delivery_payload_id: string | null;
  /** `delivery_attempt_id`, only while a delivery hold names it (Issue #4082). */
  delivery_hold_attempt_id: string | null;
}

export function mapRelay(row: SessionRelayRow): SessionRelay {
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
    deliveryHold: mapDeliveryHold(row),
  };
}

/** The delivery hold a row carries, or null (Issue #4064). */
function mapDeliveryHold(row: SessionRelayRow): RelayDeliveryHold | null {
  if (row.delivery_state === null || row.delivery_state === undefined) return null;
  return {
    state: row.delivery_state as RelayDeliveryState,
    payloadId: row.delivery_payload_id ?? null,
    attemptId: row.delivery_hold_attempt_id ?? null,
    kind: (row.pending_kind as RelayPendingKind | null) ?? null,
    reason: row.delivery_reason ?? null,
    at: row.delivery_at ?? null,
    checkCommand: relayRequesterPaneCommand({
      worktreeId: row.from_worktree_id,
      instanceId: row.from_instance_id,
    }),
  };
}

/**
 * `SET` assignments that empty the pending slot unless its payload is under a
 * delivery hold (Issue #4064). For the writers that close a relay (cancel, the
 * restart recovery's cancel): they stop later deliveries, and a held payload's
 * body, id and reason stay readable — closing a relay does not prove that what
 * may already be in A's composer is not.
 */
export const KEEP_HELD_PAYLOAD_SET = `
  pending_kind = CASE WHEN delivery_state IS NULL THEN NULL ELSE pending_kind END,
  pending_body = CASE WHEN delivery_state IS NULL THEN NULL ELSE pending_body END,
  payload_id = CASE WHEN delivery_state IS NULL THEN NULL ELSE payload_id END
`;

/** Placeholders for an `IN (…)` over the open states. */
export const OPEN_STATE_PLACEHOLDERS = OPEN_RELAY_STATES.map(() => '?').join(', ');

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

export function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
