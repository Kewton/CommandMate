/**
 * The waiting-episode store's state tables, its listeners and the reads
 * (Issue #1786 / #3798). The single place that initialises each `globalThis` slot.
 */

import { buildCompositeKey, COMPOSITE_KEY_SEPARATOR } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { getOrInitGlobal } from '../global-state';
import type {
  EpisodeBinding,
  EpisodeKeyParts,
  LastClosedEpisode,
  WaitingEpisode,
  WaitingEpisodeId,
  WaitingEpisodeMeta,
  WaitingEpisodeRecord,
  WaitingEpisodeTransition,
  WaitingEpisodeTransitionListener,
  WaitingTransition,
  WaitingTransitionListener,
} from '@/lib/session/waiting-episode-state-types';

const logger = createLogger('waiting-episode-state');

/** compositeKey -> the wait currently in progress for that instance. */
export const episodes = getOrInitGlobal('__sessionWaitingEpisodes', () => new Map<string, WaitingEpisode>());

/** Subscribers to the edge. See the module docblock. */
const listeners = getOrInitGlobal('__sessionWaitingTransitionListeners', () => new Set<WaitingTransitionListener>());

export const metas = getOrInitGlobal('__sessionWaitingEpisodeMeta', () => new WeakMap<WaitingEpisode, WaitingEpisodeMeta>());
const versions = getOrInitGlobal('__sessionWaitingEpisodeVersions', () => new Map<string, number>());
export const lastClosed = getOrInitGlobal('__sessionWaitingEpisodeLastClosed', () => new Map<string, LastClosedEpisode>());
const episodeSeq = getOrInitGlobal('__sessionWaitingEpisodeSeq', () => ({
  value: 0,
  nonce: Math.random().toString(36).slice(2, 10),
}));
const episodeListeners = getOrInitGlobal(
  '__sessionWaitingEpisodeListeners',
  () => new Set<WaitingEpisodeTransitionListener>()
);

/** The binding used when no resolver is registered: nothing is known. */
export const UNKNOWN_BINDING: EpisodeBinding = {
  kind: 'unattributed',
  generation: { kind: 'none' },
  lastClosedTurnId: null,
};

export function nextEpisodeId(): WaitingEpisodeId {
  episodeSeq.value += 1;
  return `wep-${episodeSeq.nonce}-${episodeSeq.value}`;
}

export function keyOf(parts: EpisodeKeyParts): string {
  return buildCompositeKey(parts.worktreeId, parts.cliToolId, parts.instanceId);
}

export function bumpVersion(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1);
}

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

/**
 * Subscribe to waiting edges with the episode's identity (Issue #3798).
 *
 * The same crossings `onWaitingTransition` delivers, in the same order, with
 * the cause, the episode ids and the close reason added.
 */
export function onWaitingEpisodeTransition(listener: WaitingEpisodeTransitionListener): () => void {
  episodeListeners.add(listener);
  return () => {
    episodeListeners.delete(listener);
  };
}

/** Notify subscribers, containing anything they throw. */
export function emit(transition: WaitingEpisodeTransition): void {
  const { cause: _cause, episodeId: _id, previousEpisodeId: _prev, closeReason: _reason, ...plain } = transition;
  for (const listener of listeners) {
    try {
      listener(plain);
    } catch (error) {
      logListenerFailure(transition, error);
    }
  }
  for (const listener of episodeListeners) {
    try {
      listener(transition);
    } catch (error) {
      logListenerFailure(transition, error);
    }
  }
}

function logListenerFailure(transition: WaitingTransition, error: unknown): void {
  logger.error('waiting-transition-listener-failed', {
    worktreeId: transition.worktreeId,
    cliToolId: transition.cliToolId,
    instanceId: transition.instanceId ?? transition.cliToolId,
    waiting: transition.waiting,
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * The meta of an episode in the map. An episode put there without one (a test
 * that wrote the map directly) is given an unattributed identity on first read.
 */
export function metaOf(view: WaitingEpisode): WaitingEpisodeMeta {
  let meta = metas.get(view);
  if (meta === undefined) {
    meta = {
      episodeId: nextEpisodeId(),
      openedAt: view.since,
      boundAt: view.since,
      binding: UNKNOWN_BINDING,
      openedBy: 'legacy-edge',
      promptScreenKey: null,
    };
    metas.set(view, meta);
  }
  return meta;
}

/** The open episode with its identity and binding, or null (Issue #3798). */
export function getWaitingEpisodeRecord(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): WaitingEpisodeRecord | null {
  const view = episodes.get(buildCompositeKey(worktreeId, cliToolId, instanceId));
  if (view === undefined) return null;
  const meta = metaOf(view);
  return { since: view.since, kind: view.kind, ...meta, binding: meta.binding };
}

/** The instance's episode version: it moves on every open, close, replacement and rebind. */
export function getEpisodeVersion(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): number {
  return versions.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? 0;
}

/**
 * Every instance version of one worktree, as of now (Issue #3798): the status
 * probe fixes them before it lists the tmux sessions. An instance missing from
 * the map is at version 0.
 */
export function snapshotEpisodeVersions(worktreeId: string): Map<string, number> {
  const prefix = `${worktreeId}${COMPOSITE_KEY_SEPARATOR}`;
  const snapshot = new Map<string, number>();
  for (const [key, version] of versions) {
    if (key.startsWith(prefix)) snapshot.set(key, version);
  }
  return snapshot;
}

/** The last episode that ended for this instance, or null. */
export function getLastClosedEpisode(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): LastClosedEpisode | null {
  return lastClosed.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
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
  versions.clear();
  lastClosed.clear();
}

/** Drop every subscriber. Test seam, paired with {@link clearWaitingEpisodes}. */
export function clearWaitingTransitionListeners(): void {
  listeners.clear();
  episodeListeners.clear();
}
