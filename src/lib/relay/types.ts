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
}

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
