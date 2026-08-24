/**
 * When each agent instance started waiting, and the one place that edge is
 * observed (Issue #1786).
 *
 * `isWaitingForResponse` is a level, and every question the display Issues ask
 * is about the *edge*: #1787 wants "waiting for how long", #1788 wants to push a
 * WebSocket frame the instant it flips, #1790 wants to fire a push notification
 * on the same instant and not on the 200 polls that follow. A level cannot
 * answer any of those, and three surfaces each keeping their own "was it waiting
 * last time?" would be three chances to disagree about when a wait began.
 *
 * So the edge is detected exactly once, here, by {@link observeWaitingEdge}, and
 * everything else either reads {@link getWaitingEpisode} or subscribes with
 * {@link onWaitingTransition}. There is one caller today —
 * `worktree-status-helper`, on the list API's per-instance probe — and it passes
 * the *composed* verdict (scraper OR structured), so a wait that only the
 * agent's own events can see opens an episode exactly like one the screen
 * scraper read.
 *
 * ## Where #1788 / #1790 plug in
 *
 * `onWaitingTransition(listener)` — the listener receives every false→true and
 * true→false crossing, with the instance it belongs to, the episode's `since`
 * and its {@link WaitingKind}. #1788 broadcasts it (`broadcastToWorktree`),
 * #1790 decides whether to send a push. Neither needs to touch this module's
 * internals, and neither can move the timestamps the other reports.
 *
 * Listeners are called synchronously, inside the request that observed the edge,
 * because the point of the seam is immediacy. A listener that throws is
 * contained: this store is on the list API's hot path, and a broken notification
 * sink must not take the status read down with it.
 *
 * In-memory (via `globalThis`, per Issue #1736 — see the note in
 * `agent-event-state`) rather than SQLite, for the same reason the structured
 * state is: it describes a live tmux session, and a wait does not outlive the
 * server process that observed it.
 *
 * @module lib/session/waiting-episode-state
 */

import { buildCompositeKey, COMPOSITE_KEY_SEPARATOR } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import type { WaitingKind } from '@/lib/session/waiting-kind';

const logger = createLogger('waiting-episode-state');

/**
 * Reached through `globalThis` and not through the module scope, for the reason
 * spelled out at length in `agent-event-state`: under `next dev` each route
 * handler is bundled separately, and a module-scoped `Map` would give the writer
 * and the reader one map each — a failure that produces no error and no warning,
 * only a field that is always null.
 */
declare global {
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodes: Map<string, WaitingEpisode> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingTransitionListeners: Set<WaitingTransitionListener> | undefined;
}

/** compositeKey -> the wait currently in progress for that instance. */
const episodes = globalThis.__sessionWaitingEpisodes ??
  (globalThis.__sessionWaitingEpisodes = new Map<string, WaitingEpisode>());

/** Subscribers to the edge. See the module docblock. */
const listeners = globalThis.__sessionWaitingTransitionListeners ??
  (globalThis.__sessionWaitingTransitionListeners = new Set<WaitingTransitionListener>());

/** One uninterrupted stretch of waiting by one agent instance. */
export interface WaitingEpisode {
  /**
   * Epoch ms the wait began.
   *
   * Fixed when the episode opens and never moved while it lasts — a value that
   * crept forward on every poll would make "waiting for 12 minutes" unreadable,
   * which is the whole reason #1787 asked for it.
   */
  since: number;
  /** The most recent classification of this wait. May change mid-episode. */
  kind: WaitingKind | null;
}

/** A crossing of the waiting edge, handed to every listener. */
export interface WaitingTransition {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** The agent instance; undefined/`cliToolId` both mean the primary. */
  instanceId: string | undefined;
  /** Which way it crossed: true = the wait began, false = it ended. */
  waiting: boolean;
  /** The episode's start, or null when the wait just ended. */
  since: number | null;
  /** The episode's kind, or null when the wait just ended. */
  kind: WaitingKind | null;
  /** Epoch ms the crossing was observed. */
  at: number;
}

export type WaitingTransitionListener = (transition: WaitingTransition) => void;

/**
 * Subscribe to waiting edges.
 *
 * @returns An unsubscribe function. Idempotent — calling it twice is harmless.
 */
export function onWaitingTransition(listener: WaitingTransitionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify subscribers, containing anything they throw. */
function emit(transition: WaitingTransition): void {
  for (const listener of listeners) {
    try {
      listener(transition);
    } catch (error) {
      logger.error('waiting-transition-listener-failed', {
        worktreeId: transition.worktreeId,
        cliToolId: transition.cliToolId,
        instanceId: transition.instanceId ?? transition.cliToolId,
        waiting: transition.waiting,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface ObserveWaitingEdgeParams {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  /** The composed verdict for this poll — scraper OR structured. */
  waiting: boolean;
  /** This poll's classification, or null. */
  kind?: WaitingKind | null;
  /**
   * The structured episode's own start, when one exists.
   *
   * Preferred over the observation time when an episode opens, because it is
   * when the human was actually blocked: the agent posts the event the moment
   * the dialog is drawn, while the scraper reads the pane through a 5 s capture
   * cache on a poll of its own. Only consulted at the edge — once an episode is
   * open its `since` is frozen.
   */
  structuredSince?: number | null;
  /** Epoch ms; defaults to now. */
  now?: number;
}

/**
 * Record this poll's waiting verdict and answer when the current wait began.
 *
 * The single writer of the edge, by design (Issue #1786). Idempotent for a
 * level that has not changed: repeated `waiting: true` polls return the same
 * `since` and emit nothing, so a listener hears one event per wait rather than
 * one per poll.
 *
 * @returns The episode's `since` while waiting, or null when it is not.
 */
export function observeWaitingEdge({
  worktreeId,
  cliToolId,
  instanceId,
  waiting,
  kind = null,
  structuredSince = null,
  now = Date.now(),
}: ObserveWaitingEdgeParams): number | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const existing = episodes.get(key);

  if (!waiting) {
    if (existing === undefined) return null;
    episodes.delete(key);
    emit({ worktreeId, cliToolId, instanceId, waiting: false, since: null, kind: null, at: now });
    return null;
  }

  if (existing !== undefined) {
    // A wait can change character without ending — a permission dialog answered
    // into a selection list is still one uninterrupted wait — so the kind is
    // refreshed while `since` stays put.
    existing.kind = kind;
    return existing.since;
  }

  const since = structuredSince ?? now;
  episodes.set(key, { since, kind });
  emit({ worktreeId, cliToolId, instanceId, waiting: true, since, kind, at: now });
  return since;
}

/**
 * @returns The wait in progress for this instance, or null when it is not
 *   waiting. Read-only: observing the edge is {@link observeWaitingEdge}'s job.
 */
export function getWaitingEpisode(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): WaitingEpisode | null {
  return episodes.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * Whether **any** instance in this worktree is still waiting (Issue #2001).
 *
 * The cross-device dismissal is keyed on the worktree, because that is what the
 * Service Worker `tag` names (`<worktreeId>:prompt`, `push-sender`): two agent
 * instances waiting in one worktree share a single notification card on the
 * phone. So one instance crossing the closing edge is not on its own a reason
 * to clear that card — the card is still telling the truth until the last of
 * them has been answered.
 *
 * The prefix test is exact rather than heuristic: `buildCompositeKey` puts the
 * worktree id first and rejects a worktree id containing
 * {@link COMPOSITE_KEY_SEPARATOR}, so no other worktree's key can start with
 * `<worktreeId>:`.
 */
export function hasOpenWaitingEpisode(worktreeId: string): boolean {
  const prefix = `${worktreeId}${COMPOSITE_KEY_SEPARATOR}`;
  for (const key of episodes.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Drop every episode. Test seam.
 *
 * CI runs with `fileParallelism: false`, so one process holds this map for the
 * whole suite: a test that opens an episode and does not clear it hands the next
 * file a session that is already waiting.
 */
export function clearWaitingEpisodes(): void {
  episodes.clear();
}

/** Drop every subscriber. Test seam, paired with {@link clearWaitingEpisodes}. */
export function clearWaitingTransitionListeners(): void {
  listeners.clear();
}
