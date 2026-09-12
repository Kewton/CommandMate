/**
 * How often one live pane polls, and why the tile grid may not use the worktree
 * screen's answer (Issue #2511, Epic #2508 Phase 3).
 *
 * `useTerminalPanePolling` and `useSplitMessages` were written for the worktree
 * screen, where at most two or three panes are alive and every one of them is
 * the thing the reader is looking at. `/sessions`' tile grid (#2509) mounts one
 * of each **per visible tile**, so the numbers that are generous for three panes
 * are the numbers that decide whether twenty tiles are affordable. Both surfaces
 * therefore name a *profile* instead of reading module-level constants, and the
 * worktree screen's profile is byte-for-byte what it did before — that is the
 * entire reason the split exists.
 *
 * ## What the measurement said
 *
 * Full method and raw numbers: `docs/design/sessions-tile-polling-2511.md`.
 * The three findings that shaped the values below:
 *
 * 1. **An idle tile polls at the FAST cadence, not the slow one.** The Issue
 *    predicted 5s; it is actually 2s. `PaneTerminalState.isRunning` means "a
 *    healthy tmux session exists", not "the agent is generating" (#2238), so the
 *    `terminal.isRunning ? ACTIVE : IDLE` branch picks ACTIVE for every tile
 *    whose session is merely alive — which on `/sessions` is all of them.
 *
 * 2. **`pushHealthy` can never be true for an idle pane.** It is set by
 *    `markPushHealthy()` when a `terminal_snapshot` arrives, and snapshots are
 *    only broadcast from the response poller, which only runs while a turn is
 *    being recorded. Gating the slow cadence on it therefore guarantees the fast
 *    cadence exactly when there is nothing to fetch.
 *
 * 3. **The cost is real.** 20 tiles at the worktree screen's cadence measured
 *    11.3 req/s and 18.6 MB/s of uncompressed JSON, at 24.6% of one core in the
 *    server plus 9.9% in tmux — with every session idle. 99.8% of a
 *    `/current-output` body is the captured frame, which the payload carries
 *    twice (`content` and `fullOutput` are the same string).
 *
 * ## Why a tile may trust a bare connection
 *
 * {@link PanePollingCadence.idleTrustsConnection} is the tile-only rule that
 * answers finding 2: while the socket is up, a tile that is *not generating* may
 * fall back to the slow cadence without waiting for a push heartbeat. It is safe
 * for a tile and not for the worktree screen because of what the two are for. A
 * turn that starts through CommandMate starts a response poller, and that poller
 * broadcasts snapshots to the worktree room the tile is already subscribed to —
 * so the tile learns about it by push, within one poller tick, no matter what
 * its own interval says. What the slow cadence does cost is a turn started
 * *outside* CommandMate (typed straight into tmux), which no push announces:
 * that one takes up to {@link TILE_PANE_POLLING_CADENCE}`.wsFallbackMs` to
 * appear. On an overview screen where every tile is one tap from the real thing,
 * that is the right trade; on the worktree screen it is not, which is why the
 * detail profile leaves the heartbeat gate in place.
 *
 * @module config/pane-polling-cadence
 */

/** The knobs that decide one terminal pane's poll interval. */
export interface PanePollingCadence {
  /** Interval while the pane is busy (see {@link activeRequiresGenerating}). */
  readonly activeMs: number;
  /** Interval while the pane is quiet and no live socket is up. */
  readonly idleMs: number;
  /** Interval while a live socket carries the pane's frames. */
  readonly wsFallbackMs: number;
  /**
   * What counts as "busy".
   *
   * `false` — the worktree screen — treats a healthy tmux session as busy
   * (`PaneTerminalState.isRunning`). `true` — a tile — requires the merged
   * status verdict to say the agent is generating or waiting on a human. See
   * finding 1 in the module comment for why the distinction is not cosmetic.
   */
  readonly activeRequiresGenerating: boolean;
  /**
   * Whether a quiet pane may take {@link wsFallbackMs} on connectedness alone.
   *
   * `false` — the worktree screen — additionally requires a recent push
   * heartbeat, which a quiet pane never has. `true` — a tile — does not. See
   * "Why a tile may trust a bare connection" in the module comment.
   */
  readonly idleTrustsConnection: boolean;
}

/** The knobs that decide one pane's history poll interval. */
export interface MessagesPollingCadence {
  /** Interval while no live socket is up. */
  readonly pollMs: number;
  /** Interval while a socket is up and history rows arrive as pushes (#2195). */
  readonly wsFallbackMs: number;
}

/**
 * The worktree screen's cadence — **unchanged since #1120**, deliberately.
 *
 * Every number and every flag here reproduces the `intervalMs` expression
 * `useTerminalPanePolling` carried before this Issue. `/worktrees/<id>` is a
 * screen someone is watching one agent on, and #2511 is explicit that its feel
 * must not move; `tests/unit/hooks/useTerminalPanePolling-tile-cadence-2511`
 * pins that against the real hook rather than against this table.
 */
export const DETAIL_PANE_POLLING_CADENCE: PanePollingCadence = {
  activeMs: 2000,
  idleMs: 5000,
  wsFallbackMs: 15000,
  activeRequiresGenerating: false,
  idleTrustsConnection: false,
};

/**
 * A `/sessions` tile's cadence.
 *
 * - `activeMs` 4000: a generating tile whose push has gone stale. Half the rate
 *   of the worktree screen's 2s, because a tile is a glance and not a read, and
 *   because this is the branch twenty tiles could take at once — measured at
 *   15.2% of one core for 20 simultaneously-generating tiles, against 24.6% for
 *   the same twenty merely *idle* under the old rule.
 * - `idleMs` 10000: quiet, and the socket is down, so the poll is the only
 *   signal there is. Slower than the worktree screen's 5s but deliberately
 *   faster than `wsFallbackMs`: nothing else will tell this tile that a turn
 *   started. Measured at 8.7% of one core for 20 tiles.
 * - `wsFallbackMs` 15000: quiet with a live socket — the steady state of this
 *   screen, and the one the tuning is for. Measured at 6.7% of one core, 2.0
 *   req/s and 2.5 MB/s for 20 tiles, against 24.6% / 11.3 req/s / 18.6 MB/s.
 *
 * The same 15s the worktree screen already uses for its own WS fallback: the
 * change that matters is not the number, it is that a tile can actually reach
 * it (`idleTrustsConnection`).
 */
export const TILE_PANE_POLLING_CADENCE: PanePollingCadence = {
  activeMs: 4000,
  idleMs: 10000,
  wsFallbackMs: 15000,
  activeRequiresGenerating: true,
  idleTrustsConnection: true,
};

/** The worktree screen's history cadence — unchanged since #2195. */
export const DETAIL_MESSAGES_POLLING_CADENCE: MessagesPollingCadence = {
  pollMs: 5000,
  wsFallbackMs: 15000,
};

/**
 * A tile's history cadence.
 *
 * History is push-first (#2195): every row the server writes is broadcast to the
 * worktree room, and the tile is subscribed. The poll is a gap-filler, and a
 * gap-filler on twenty tiles does not need to run three times a minute. Cheap
 * either way — `/messages` measured 40KB and 5ms with no tmux work at all — so
 * this is the smaller half of the saving, kept in step with the terminal pane so
 * the two do not disagree about how stale a quiet tile may be.
 */
export const TILE_MESSAGES_POLLING_CADENCE: MessagesPollingCadence = {
  pollMs: 15000,
  wsFallbackMs: 30000,
};

/** What a pane knows about itself when it is choosing an interval. */
export interface PaneCadenceSignals {
  /** A live WebSocket connection exists. */
  connected: boolean;
  /** A `terminal_snapshot` arrived within the push-staleness window. */
  pushHealthy: boolean;
  /**
   * A human is looking at something that has to react promptly — a prompt, a
   * selection list, a pager, a dismissable panel, an unclassified frame.
   */
  interactionActive: boolean;
  /** A healthy tmux session exists (`PaneTerminalState.isRunning`). */
  sessionAlive: boolean;
  /**
   * The merged status verdict says the agent is generating (`'running'`) or
   * waiting on an answer (`'waiting'`).
   */
  generating: boolean;
}

/**
 * The SessionStatus values a tile treats as "busy".
 *
 * `'waiting'` is in because a pane that has asked a question is a pane whose
 * screen is about to change the moment it is answered, and the answer may come
 * from somewhere this tile cannot see (the CLI, another device, Auto-Yes).
 * `'ready'` and `'idle'` are not: they are the states this Issue exists to stop
 * paying 2s for.
 */
const GENERATING_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting']);

/**
 * Whether a pane's published `sessionStatus` counts as generating.
 *
 * Takes the raw wire string rather than a narrowed union because that is how
 * `CurrentOutputPayload.sessionStatus` publishes it, and `''` (nothing polled
 * yet) has to be answerable without pretending it is a `SessionStatus`.
 *
 * @param sessionStatus - The pane's last published status verdict
 * @returns True when the agent is generating or waiting on an answer
 */
export function isGeneratingStatus(sessionStatus: string): boolean {
  return GENERATING_STATUSES.has(sessionStatus);
}

/**
 * Pick a terminal pane's poll interval.
 *
 * Order matters and is the same order the worktree screen has always used: a
 * human interaction outranks everything, then a live push connection, then
 * busy-ness. Under {@link DETAIL_PANE_POLLING_CADENCE} this is exactly the
 * expression `useTerminalPanePolling` used to inline.
 *
 * @param cadence - The profile the surface declared
 * @param signals - What the pane currently knows about itself
 * @returns The interval, in milliseconds
 *
 * @example
 * ```ts
 * selectPanePollIntervalMs(TILE_PANE_POLLING_CADENCE, {
 *   connected: true, pushHealthy: false, interactionActive: false,
 *   sessionAlive: true, generating: false,
 * }); // 15000 — a quiet tile on a live socket
 * ```
 */
export function selectPanePollIntervalMs(
  cadence: PanePollingCadence,
  signals: PaneCadenceSignals,
): number {
  if (signals.interactionActive) return cadence.activeMs;

  const busy = cadence.activeRequiresGenerating ? signals.generating : signals.sessionAlive;

  if (signals.connected && signals.pushHealthy) return cadence.wsFallbackMs;
  // The tile-only branch. Guarded on `!busy` so a generating pane whose push has
  // gone stale still drops back to the fast cadence — that recovery is the whole
  // point of the heartbeat, and it is not what this Issue is relaxing.
  if (signals.connected && !busy && cadence.idleTrustsConnection) return cadence.wsFallbackMs;

  return busy ? cadence.activeMs : cadence.idleMs;
}

/**
 * Pick a history pane's poll interval.
 *
 * Connectedness is the only signal: unlike the terminal there is no push
 * heartbeat to judge, because history rows are written only when a turn ends and
 * a quiet hour is completely normal (see `useSplitMessages`).
 *
 * @param cadence - The profile the surface declared
 * @param signals - Whether a live socket is up
 * @returns The interval, in milliseconds
 */
export function selectMessagesPollIntervalMs(
  cadence: MessagesPollingCadence,
  signals: { connected: boolean },
): number {
  return signals.connected ? cadence.wsFallbackMs : cadence.pollMs;
}
