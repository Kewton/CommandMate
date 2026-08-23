/**
 * The edge of an upstream-fault episode, and the one place it is observed
 * (Issue #2000).
 *
 * ## Why an edge is needed at all
 *
 * `upstreamFault` is a **level**, not an event. `matchUpstreamFault` (#1839) is
 * re-evaluated on every frame that is read, and the frame keeps the banner for
 * as long as it is on screen — so "notify when a fault is visible" means
 * "notify on every poll", which is the precise opposite of what Epic #2002 asks
 * for. The signal has to be converted to an edge before it can ring a phone.
 *
 * ## Why not reuse `session/waiting-episode-state`
 *
 * #1786's store is the right *shape* and the wrong *store*. It is the single
 * writer of the **waiting** edge, read by three surfaces (the status API, the
 * WebSocket frame, the push notifier), and its episode identity is a boolean
 * level per instance. An upstream fault differs on both counts:
 *
 *  - its identity includes **which** fault is on the frame, because a session
 *    that goes from `retrying` to `limit-reached` has changed what the human
 *    has to do about it;
 *  - it has exactly one consumer (push), so nothing is gained by putting it on
 *    a shared seam, and `observeWaitingEdge`'s listener fan-out would have to
 *    grow a second event type to carry it.
 *
 * So this is a deliberate same-shape/second-store, and the shape is copied on
 * purpose: one writer, `globalThis`-held (see the note below), a level in and
 * an edge out, idempotent for an unchanged level.
 *
 * ## Why the edge alone is not enough: the cooldown
 *
 * The fault is judged on the **last 100 rows** of the pane, so a retry storm
 * scrolls its own banner out of scope between polls. Measured shape of a 529
 * storm (#1839): `API Error: Repeated 529 Overloaded errors …` followed by
 * `Retrying in 34s · attempt 9/10`. Those match two different signatures
 * (`overloaded` and `retrying`) and the agent keeps printing between them, so a
 * pure open/close edge can legitimately fire many times for **one** incident —
 * up to once per retry. That is a flood, and a flood is the thing this Epic
 * exists to remove.
 *
 * The cooldown is therefore keyed on the **instance**, not on the fault id: the
 * action a reader takes is the same for all four signatures ("go look at that
 * session"), so telling them twice in ten minutes is not more informative, it
 * is just louder. A genuinely separate incident later than
 * {@link UPSTREAM_FAULT_COOLDOWN_MS} still rings.
 *
 * In-memory, like every other live-session state here: it describes a tmux pane
 * and must not outlive the server that watched it.
 *
 * @module lib/push/failure-episode-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * How long after notifying about an upstream fault this instance stays quiet
 * about upstream faults.
 *
 * 30 minutes is chosen against the two failure modes rather than against a
 * cadence: shorter re-opens the retry-storm flood described above (a storm runs
 * for minutes and re-matches throughout), and longer starts hiding incidents
 * that really are new. An operator who wants the detail already has
 * `capture --json`'s `upstreamFault` and the `[failure-push]` log lines; this
 * bound only governs how often the *phone* is used.
 */
export const UPSTREAM_FAULT_COOLDOWN_MS = 30 * 60_000;

/** What this module remembers about one agent instance. */
interface UpstreamFaultState {
  /** The fault currently on the frame, or null when the frame is clean. */
  current: { faultId: string; since: number } | null;
  /** Epoch ms this instance last *notified* about an upstream fault. */
  lastNotifiedAt: number | null;
}

/**
 * Reached through `globalThis` and not module scope, for the reason #1736
 * documented at length in `agent-event-state`: under `next dev` each route
 * handler is bundled separately, and a module-scoped Map would give two callers
 * one map each — which here means every caller has its own idea of whether the
 * fault is new, with no error to show for it.
 */
declare global {
  // eslint-disable-next-line no-var
  var __upstreamFaultPushState: Map<string, UpstreamFaultState> | undefined;
}

const states = globalThis.__upstreamFaultPushState ??
  (globalThis.__upstreamFaultPushState = new Map<string, UpstreamFaultState>());

/** Why {@link observeUpstreamFaultEdge} decided as it did. Goes into the log. */
export type UpstreamFaultEdgeReason =
  /** No known signature on the frame. Any open episode is closed. */
  | 'no-fault'
  /** The same fault is still on the frame — this is not a new incident. */
  | 'same-episode'
  /** A new episode, but this instance rang recently. See the cooldown above. */
  | 'cooldown'
  /** A new episode and nothing recent to collapse it into: notify. */
  | 'new-episode';

export interface UpstreamFaultEdge {
  /** True only for `reason: 'new-episode'`. */
  notify: boolean;
  reason: UpstreamFaultEdgeReason;
  /** Epoch ms the current episode opened; null when there is no fault. */
  since: number | null;
  /** Milliseconds left on the cooldown, for `reason: 'cooldown'`. Log context. */
  cooldownRemainingMs?: number;
}

export interface ObserveUpstreamFaultParams {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Omitted for the primary instance, exactly as `buildCompositeKey` expects. */
  instanceId?: string;
  /** {@link UpstreamFault.id} on this frame, or null when the frame is clean. */
  faultId: string | null;
  /** Epoch ms; defaults to now. */
  now?: number;
  /** Overridable so a test can exercise expiry without a fake clock. */
  cooldownMs?: number;
}

/**
 * Record this frame's fault level and answer whether it is worth a phone.
 *
 * The single writer of this edge. Idempotent for an unchanged level: repeated
 * frames carrying the same fault return `notify: false` with the episode's
 * original `since`, so a caller may hand it every poll.
 *
 * Records the notification as it decides, exactly like `shouldSendWaitingPush`
 * — so it must be called once per observation, and a caller that drops the
 * notification afterwards has consumed the incident's one slot.
 */
export function observeUpstreamFaultEdge({
  worktreeId,
  cliToolId,
  instanceId,
  faultId,
  now = Date.now(),
  cooldownMs = UPSTREAM_FAULT_COOLDOWN_MS,
}: ObserveUpstreamFaultParams): UpstreamFaultEdge {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const state = states.get(key);

  if (faultId === null) {
    // The episode closes, but `lastNotifiedAt` is kept: it is what stops the
    // banner scrolling out of the window and straight back in from ringing
    // twice. A state with nothing left to remember is dropped so an idle server
    // does not accumulate one entry per session it ever polled.
    if (state !== undefined) {
      if (state.lastNotifiedAt === null) states.delete(key);
      else state.current = null;
    }
    return { notify: false, reason: 'no-fault', since: null };
  }

  if (state !== undefined && state.current !== null && state.current.faultId === faultId) {
    return { notify: false, reason: 'same-episode', since: state.current.since };
  }

  const lastNotifiedAt = state?.lastNotifiedAt ?? null;
  const episode = { faultId, since: now };

  if (lastNotifiedAt !== null && now - lastNotifiedAt < cooldownMs) {
    // The episode is still opened — the level has to be tracked either way, or
    // the next poll would read this same fault as new again.
    states.set(key, { current: episode, lastNotifiedAt });
    return {
      notify: false,
      reason: 'cooldown',
      since: now,
      cooldownRemainingMs: cooldownMs - (now - lastNotifiedAt),
    };
  }

  states.set(key, { current: episode, lastNotifiedAt: now });
  return { notify: true, reason: 'new-episode', since: now };
}

/**
 * Drop every remembered fault. Test seam.
 *
 * CI runs with `fileParallelism: false`, so one process holds this map for the
 * whole suite: a test that leaves a cooldown behind would mute the next file.
 */
export function clearUpstreamFaultEpisodes(): void {
  states.clear();
}
