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
 * {@link onWaitingTransition}. The observers are `worktree-status-helper`, on
 * the list API's per-instance probe — it passes the *composed* verdict (scraper
 * OR structured), so a wait that only the agent's own events can see opens an
 * episode exactly like one the screen scraper read — and `response-checker`
 * (#1790), which opens the episode for a prompt it saved and closes it when it
 * records a reply.
 *
 * Issue #3798 added the agent's own turn transitions as closers: a `stop` that
 * ended the turn an episode belongs to closes it in the same synchronous step
 * that records the stop (`waiting-episode-binding`), so a tool whose reply
 * arrives on a hook closes its wait with no browser open. That needs each
 * episode to carry an identity and the turn it belongs to; see "identity and
 * attribution" below. The screen observers — the status probe, the response
 * poller and now the Auto-Yes poller — go through the same module's
 * observation tables (`observeWaiting`), which refuse a reading made against an
 * episode that has moved since the observer started; {@link observeWaitingEdge}
 * stays for the callers and suites written against #1786.
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

import { createLogger } from '@/lib/logger';
import { closeEpisode, openEpisode } from '@/lib/session/waiting-episode-state-ops';
import { episodes, keyOf, metaOf, UNKNOWN_BINDING } from '@/lib/session/waiting-episode-state-store';
import type {
  EpisodeBinding,
  EpisodeBindingResolver,
  EpisodeKeyParts,
  LastClosedEpisode,
  ObserveWaitingEdgeParams,
  WaitingEpisode,
  WaitingEpisodeMeta,
  WaitingEpisodeTransitionListener,
  WaitingTransitionListener,
} from '@/lib/session/waiting-episode-state-types';

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
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeMeta: WeakMap<WaitingEpisode, WaitingEpisodeMeta> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeVersions: Map<string, number> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeLastClosed: Map<string, LastClosedEpisode> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeSeq: { value: number; nonce: string } | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeListeners: Set<WaitingEpisodeTransitionListener> | undefined;
  // eslint-disable-next-line no-var
  var __sessionWaitingEpisodeBindingResolver: EpisodeBindingResolver | undefined;
}

export type {
  EpisodeBinding,
  EpisodeBindingResolver,
  EpisodeKeyParts,
  GenerationRef,
  LastClosedEpisode,
  NewEpisode,
  ObserveWaitingEdgeParams,
  WaitingCloseReason,
  WaitingEpisode,
  WaitingEpisodeId,
  WaitingEpisodeRecord,
  WaitingEpisodeTransition,
  WaitingEpisodeTransitionListener,
  WaitingObserver,
  WaitingTransition,
  WaitingTransitionListener,
} from '@/lib/session/waiting-episode-state-types';
export {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getEpisodeVersion,
  getLastClosedEpisode,
  getWaitingEpisode,
  getWaitingEpisodeRecord,
  hasOpenWaitingEpisode,
  onWaitingEpisodeTransition,
  onWaitingTransition,
  snapshotEpisodeVersions,
} from '@/lib/session/waiting-episode-state-store';
export {
  closeEpisode,
  openEpisode,
  rebindEpisode,
  replaceEpisode,
  updateEpisodeKind,
} from '@/lib/session/waiting-episode-state-ops';

const logger = createLogger('waiting-episode-state');

/** Install the binding resolver `observeWaitingEdge` uses. The last one wins. */
export function registerEpisodeBindingResolver(resolver: EpisodeBindingResolver): void {
  globalThis.__sessionWaitingEpisodeBindingResolver = resolver;
}

function resolveBinding(parts: EpisodeKeyParts, at: number): EpisodeBinding {
  const resolver = globalThis.__sessionWaitingEpisodeBindingResolver;
  if (resolver === undefined) return UNKNOWN_BINDING;
  try {
    return resolver(parts, at);
  } catch (error) {
    logger.warn('waiting-episode-binding-resolve-failed', {
      worktreeId: parts.worktreeId,
      cliToolId: parts.cliToolId,
      instanceId: parts.instanceId ?? parts.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return UNKNOWN_BINDING;
  }
}


/**
 * Record this poll's waiting verdict and answer when the current wait began.
 *
 * The single writer of the edge, by design (Issue #1786). Idempotent for a
 * level that has not changed: repeated `waiting: true` polls return the same
 * `since` and emit nothing, so a listener hears one event per wait rather than
 * one per poll.
 *
 * Issue #3798: an episode opened here is bound by the registered resolver
 * (`waiting-episode-binding`), so the turn transitions can end it. The
 * production observers no longer call it: they go through
 * `waiting-episode-binding`'s `observeWaiting`, which also checks that the
 * episode has not moved since they started and that the frame does not
 * predate the close of what it shows.
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
  const parts: EpisodeKeyParts = { worktreeId, cliToolId, instanceId };
  const key = keyOf(parts);
  const existing = episodes.get(key);

  if (!waiting) {
    if (existing === undefined) return null;
    closeEpisode(parts, metaOf(existing).episodeId, 'screen-cleared', now);
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
  openEpisode(parts, { since, kind, binding: resolveBinding(parts, now), openedBy: 'legacy-edge' }, now);
  return since;
}
