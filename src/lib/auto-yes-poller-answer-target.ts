/**
 * Auto-Yes poller: the wait an answer goes to, and what a tick fixed for its
 * waiting-episode observations (Issue #3798) (Issue #3893: split out of
 * `auto-yes-poller.ts`).
 *
 * Does not import `auto-yes-poller.ts` (no cycle).
 *
 * @module lib/auto-yes-poller-answer-target
 */

import type { CLIToolType } from './cli-tools/types';
import type { CapturedFrameTime, ObservationStart } from './session/waiting-episode-binding';
import { getEpisodeVersion, getWaitingEpisodeRecord } from './session/waiting-episode-state';

/**
 * The wait an answer goes to, fixed in the synchronous step the send begins in
 * (Issue #3798): the episode open then, or none and the version it was at.
 */
export interface AnswerTarget {
  episodeId: string | null;
  version: number;
}

export function fixAnswerTarget(worktreeId: string, cliToolId: CLIToolType, instanceId: string | undefined): AnswerTarget {
  return {
    episodeId: getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId)?.episodeId ?? null,
    version: getEpisodeVersion(worktreeId, cliToolId, instanceId),
  };
}

/**
 * Whether the wait is still the one the answer was sent to: the same episode
 * open, as it was when the send began (the version has not moved) or rebound
 * since to a binding the answer may still be for — the hook of the turn the
 * answer resumed may have landed during the send — but not to a `screen`: a
 * survey or a picker another observer saw during the send is newer than the
 * prompt these keys answered, and re-observing that prompt would turn the
 * person's screen back into a wait Auto-Yes answered. When none was open,
 * none opened or closed since.
 */
export function answerTargetHolds(
  target: AnswerTarget,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined
): boolean {
  if (target.episodeId === null) return getEpisodeVersion(worktreeId, cliToolId, instanceId) === target.version;
  const episode = getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId);
  if (episode?.episodeId !== target.episodeId) return false;
  return getEpisodeVersion(worktreeId, cliToolId, instanceId) === target.version || episode.binding.kind !== 'screen';
}

/** What a tick fixed for its waiting-episode observations (Issue #3798). */
export interface TickObservation {
  start: ObservationStart;
  frameTime: CapturedFrameTime;
}
