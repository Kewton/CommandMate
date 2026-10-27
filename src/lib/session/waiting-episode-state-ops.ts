/**
 * The low-level episode writes: open / close / replace / rebind / updateKind
 * (Issue #3798). Each one emits through the store's listeners.
 */

import type { WaitingKind } from '@/lib/session/waiting-kind';
import {
  bumpVersion,
  emit,
  episodes,
  keyOf,
  lastClosed,
  metaOf,
  metas,
  nextEpisodeId,
} from '@/lib/session/waiting-episode-state-store';
import type {
  EpisodeBinding,
  EpisodeKeyParts,
  NewEpisode,
  WaitingCloseReason,
  WaitingEpisode,
  WaitingEpisodeId,
  WaitingEpisodeMeta,
  WaitingEpisodeRecord,
} from '@/lib/session/waiting-episode-state-types';

/**
 * Open an episode (Issue #3798). Low-level: the caller has decided there is
 * none open and what it is bound to. Emits the opening edge.
 */
export function openEpisode(parts: EpisodeKeyParts, next: NewEpisode, at: number): WaitingEpisodeRecord {
  const key = keyOf(parts);
  const view: WaitingEpisode = { since: next.since, kind: next.kind };
  const meta: WaitingEpisodeMeta = {
    episodeId: nextEpisodeId(),
    openedAt: at,
    boundAt: at,
    binding: next.binding,
    openedBy: next.openedBy,
    promptScreenKey: next.promptScreenKey ?? null,
  };
  episodes.set(key, view);
  metas.set(view, meta);
  bumpVersion(key);
  emit({
    worktreeId: parts.worktreeId,
    cliToolId: parts.cliToolId,
    instanceId: parts.instanceId,
    waiting: true,
    since: view.since,
    kind: view.kind,
    at,
    cause: 'opened',
    episodeId: meta.episodeId,
    previousEpisodeId: null,
    closeReason: null,
  });
  return { ...view, ...meta };
}

/**
 * Close the open episode when it is still `expectedId` (Issue #3798). A closer
 * that names the episode it decided about cannot close a later one.
 *
 * @returns Whether an episode was closed
 */
export function closeEpisode(
  parts: EpisodeKeyParts,
  expectedId: WaitingEpisodeId,
  reason: WaitingCloseReason,
  at: number
): boolean {
  const key = keyOf(parts);
  const view = episodes.get(key);
  if (view === undefined) return false;
  const meta = metaOf(view);
  if (meta.episodeId !== expectedId) return false;
  episodes.delete(key);
  lastClosed.set(key, { at, promptScreenKey: meta.promptScreenKey });
  bumpVersion(key);
  emit({
    worktreeId: parts.worktreeId,
    cliToolId: parts.cliToolId,
    instanceId: parts.instanceId,
    waiting: false,
    since: null,
    kind: null,
    at,
    cause: 'closed',
    episodeId: null,
    previousEpisodeId: meta.episodeId,
    closeReason: reason,
  });
  return true;
}

/**
 * Put a new episode in place of `expectedId` as one operation (Issue #3798):
 * listeners hear a single opening edge for the new wait and no closing one
 * in between, so nothing reports "nobody is waiting" mid-swap.
 *
 * @returns The new episode, or null when `expectedId` is no longer open
 */
export function replaceEpisode(
  parts: EpisodeKeyParts,
  expectedId: WaitingEpisodeId,
  next: NewEpisode,
  reason: WaitingCloseReason,
  at: number
): WaitingEpisodeRecord | null {
  const key = keyOf(parts);
  const old = episodes.get(key);
  if (old === undefined) return null;
  const oldMeta = metaOf(old);
  if (oldMeta.episodeId !== expectedId) return null;
  lastClosed.set(key, { at, promptScreenKey: oldMeta.promptScreenKey });
  const view: WaitingEpisode = { since: next.since, kind: next.kind };
  const meta: WaitingEpisodeMeta = {
    episodeId: nextEpisodeId(),
    openedAt: at,
    boundAt: at,
    binding: next.binding,
    openedBy: next.openedBy,
    promptScreenKey: next.promptScreenKey ?? null,
  };
  episodes.set(key, view);
  metas.set(view, meta);
  bumpVersion(key);
  emit({
    worktreeId: parts.worktreeId,
    cliToolId: parts.cliToolId,
    instanceId: parts.instanceId,
    waiting: true,
    since: view.since,
    kind: view.kind,
    at,
    cause: 'replaced',
    episodeId: meta.episodeId,
    previousEpisodeId: oldMeta.episodeId,
    closeReason: reason,
  });
  return { ...view, ...meta };
}

/**
 * Change what the open episode `expectedId` is bound to (Issue #3798). Not an
 * edge: the wait goes on, so nothing is emitted and `since` stays.
 *
 * @returns Whether the episode was rebound
 */
export function rebindEpisode(
  parts: EpisodeKeyParts,
  expectedId: WaitingEpisodeId,
  binding: EpisodeBinding,
  at: number
): boolean {
  const key = keyOf(parts);
  const view = episodes.get(key);
  if (view === undefined) return false;
  const meta = metaOf(view);
  if (meta.episodeId !== expectedId) return false;
  meta.binding = binding;
  meta.boundAt = at;
  bumpVersion(key);
  return true;
}

/**
 * Refresh the kind of the open episode `expectedId` (Issue #3798, I10). The
 * wait goes on: no edge, and the version does not move.
 *
 * @returns Whether the episode was still open
 */
export function updateEpisodeKind(
  parts: EpisodeKeyParts,
  expectedId: WaitingEpisodeId,
  kind: WaitingKind | null
): boolean {
  const view = episodes.get(keyOf(parts));
  if (view === undefined || metaOf(view).episodeId !== expectedId) return false;
  view.kind = kind;
  return true;
}
