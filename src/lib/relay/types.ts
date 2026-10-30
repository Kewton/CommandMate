/**
 * The vocabulary of a session-to-session relay (Issue #2377).
 *
 * Kept in its own module because both halves of the process read it — the
 * server modules that create, deliver and expire a relay, and the browser hook
 * that draws the badges — and neither may pull the other's graph in. Nothing
 * here touches a database, a socket or a DOM.
 *
 * @module lib/relay/types
 */

/**
 * Where a relay row stands.
 *
 *  - `pending`   — B has not finished the turn A is waiting on.
 *  - `prompt`    — B stopped on a confirmation, and A has been told so. Still
 *                  open: answering the prompt lets B finish and the reply is
 *                  delivered from this state.
 *  - `delivered` — B's reply reached A's composer. Terminal.
 *  - `expired`   — the deadline passed with nothing delivered. Terminal.
 *  - `cancelled` — somebody withdrew it (`commandmate relays cancel`). Terminal.
 */
export type RelayState = 'pending' | 'delivered' | 'prompt' | 'expired' | 'cancelled';

/** The states from which a relay can still produce a delivery. */
export const OPEN_RELAY_STATES: readonly RelayState[] = ['pending', 'prompt'];

/** Whether this state can still produce a delivery. */
export function isOpenRelayState(state: RelayState): boolean {
  return OPEN_RELAY_STATES.includes(state);
}

/** One end of a relay: a worktree plus the agent instance inside it. */
export interface RelayEndpoint {
  worktreeId: string;
  /** Resolved instance id. The primary instance's id IS its tool id (#868). */
  instanceId: string;
}

/**
 * What a decided-but-undelivered payload is.
 *
 *  - `reply`   — B's finished answer.
 *  - `prompt`  — B is waiting on a confirmation; the notice describes it.
 *  - `expired` — the one-line notice that the relay ran out of time.
 */
export type RelayPendingKind = 'reply' | 'prompt' | 'expired';

/**
 * How a relay is tied to the send that asked for it (Issue #3957).
 *
 *  - `legacy` — opened by an older CLI or a bare `POST /api/relays`: delivered
 *               from the first reply after `createdAt`, as before.
 *  - `bound`  — opened with `bind: true`; the send API reserves it and records
 *               where the send's input began, and only that send can settle it.
 */
export type RelayBindMode = 'legacy' | 'bound';

/**
 * Where a bound relay's send stands (Issue #3957). Null for a legacy relay.
 *
 *  - `awaiting`      — the relay exists; no key has been typed for it.
 *  - `input_started` — the boundary was recorded; the body is going in.
 *  - `sent`          — the send was confirmed. Only now can a reply be taken.
 *  - `failed`        — the send did not happen; nothing will be delivered.
 *  - `unknown`       — whether it happened cannot be said; held, with a reason.
 */
export type RelaySendState = 'awaiting' | 'input_started' | 'sent' | 'failed' | 'unknown';

/** Where the boundary was taken: right before the first key, or right before an HTTP dispatch. */
export type RelayBoundaryKind = 'input_start' | 'dispatch';

/**
 * Whether the observation made at the boundary still describes the session.
 *
 *  - `valid`        — the boundary and the turn reading both hold.
 *  - `invalid`      — the session (or the server) changed underneath; held.
 *  - `turn_unknown` — the boundary holds, the turn state was never known.
 */
export type RelayObsState = 'valid' | 'invalid' | 'turn_unknown';

/**
 * What the delivery could prove about sharing a turn with another request.
 *
 * A direction is named only when it was DETECTED: `later` = a turn was already
 * open when this request's input began; `earlier` = another input arrived after
 * this one and before the reply; `both`; `none` = neither (and `later` was
 * ruled out); `unknown` = could not be told. Unknown is never shown as none.
 */
export type RelayOverlap = 'none' | 'later' | 'earlier' | 'both' | 'unknown';

/** A relay ledger row, as every reader sees it. */
export interface SessionRelay {
  id: string;
  /** The session that asked, and is owed the answer. */
  from: RelayEndpoint;
  /** The session that was asked. */
  to: RelayEndpoint;
  state: RelayState;
  /** Chain depth; 1 for a relay nothing relayed into. */
  hops: number;
  /** `relay:<id>` once the reply has been delivered, else null. */
  sentRequestId: string | null;
  /** A payload decided but not yet delivered, or null. */
  pendingKind: RelayPendingKind | null;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  deliveredAt: number | null;
  /** Issue #3957: `legacy` for every row an older CLI opened. */
  bindMode: RelayBindMode;
  /** Issue #3957: null for a legacy relay. */
  sendState: RelaySendState | null;
  /** Issue #3957: the delivery's lower bound (epoch ms), once recorded. */
  inputBoundaryAt: number | null;
  boundaryKind: RelayBoundaryKind | null;
  /** Issue #3957: whether a turn was open at the boundary; null = not known. */
  turnOpenAtSend: boolean | null;
  obsState: RelayObsState | null;
  /** Issue #3957: why the relay is held (`send_unknown`, `generation_changed`, …). */
  holdReason: string | null;
  /** Issue #3957: the decided reply's overlap, once one was decided. */
  overlap: RelayOverlap | null;
}

/** The v62 fields of a row with no binding, as a legacy relay reads (Issue #3957). */
export const LEGACY_RELAY_BINDING_FIELDS: Pick<
  SessionRelay,
  | 'bindMode'
  | 'sendState'
  | 'inputBoundaryAt'
  | 'boundaryKind'
  | 'turnOpenAtSend'
  | 'obsState'
  | 'holdReason'
  | 'overlap'
> = {
  bindMode: 'legacy',
  sendState: null,
  inputBoundaryAt: null,
  boundaryKind: null,
  turnOpenAtSend: null,
  obsState: null,
  holdReason: null,
  overlap: null,
};

/**
 * The relays that concern one session, as the badges read them.
 *
 * `owed` are relays this session must answer (it is the `to` end); `awaiting`
 * are relays it is waiting on (it is the `from` end). Open states only — a
 * delivered relay is history, not a badge.
 */
export interface SessionRelaySummary {
  owed: SessionRelay[];
  awaiting: SessionRelay[];
}

/** Aggregate counts, for `task show` / `report metrics`. */
export interface RelayCounts {
  pending: number;
  delivered: number;
  prompt: number;
  expired: number;
  cancelled: number;
}

/** An empty {@link RelayCounts}. */
export function emptyRelayCounts(): RelayCounts {
  return { pending: 0, delivered: 0, prompt: 0, expired: 0, cancelled: 0 };
}
