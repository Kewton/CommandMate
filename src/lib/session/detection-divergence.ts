/**
 * How long the screen and the agent kept disagreeing (Issue #3311).
 *
 * `detection-divergence` (Issue #1723 §3) is written on every poll where the
 * scraper's status and the agent's own differ, and on no other. Joining those
 * lines cannot say how long one disagreement lasted: nothing marks the polls in
 * between where the two agreed again. So the server keeps, per target, when the
 * current disagreement began, and says once — `detection-divergence-resolved`,
 * written by the caller — when a poll finds the two agreeing again. One line
 * per disagreement, at its end; the per-poll line is left as it was.
 *
 * A disagreement whose target is never polled again (the session was killed,
 * nobody watches it) is never resolved and has no length. It stays in the map,
 * one small entry per target, until the next poll of that target.
 */

import { getOrInitGlobal } from '../global-state';

/** When one target's current disagreement began and how many polls saw it. */
interface DivergenceEpisode {
  startedAt: number;
  polls: number;
}

/** What a poll that ended a disagreement reports. */
export interface ResolvedDivergence {
  /** From the first diverging poll to this agreeing one. */
  durationMs: number;
  /** Diverging polls in the disagreement — each wrote one `detection-divergence`. */
  polls: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __detectionDivergenceEpisodes: Map<string, DivergenceEpisode> | undefined;
}

/**
 * On `globalThis` because the HTTP pull and the WebSocket push both build the
 * payload, and under `next dev` they are separate bundles: two maps would each
 * see half the polls.
 */
const episodes = getOrInitGlobal('__detectionDivergenceEpisodes', () => new Map<string, DivergenceEpisode>());

function targetKey(worktreeId: string, cliToolId: string, instanceId: string): string {
  return `${worktreeId}\u0000${cliToolId}\u0000${instanceId}`;
}

/**
 * Record one poll's verdict. Returns the disagreement that this poll ended, or
 * null — for a diverging poll, and for an agreeing one with nothing to end.
 *
 * @param diverging - Whether this poll wrote `detection-divergence`
 * @param now - Epoch ms; defaults to now
 */
export function trackDetectionDivergence(
  worktreeId: string,
  cliToolId: string,
  instanceId: string,
  diverging: boolean,
  now: number = Date.now()
): ResolvedDivergence | null {
  const key = targetKey(worktreeId, cliToolId, instanceId);
  const episode = episodes.get(key);
  if (diverging) {
    if (episode) episode.polls++;
    else episodes.set(key, { startedAt: now, polls: 1 });
    return null;
  }
  if (!episode) return null;
  episodes.delete(key);
  return { durationMs: Math.max(0, now - episode.startedAt), polls: episode.polls };
}

/** Forget every open disagreement. Test seam. */
export function resetDetectionDivergenceTracking(): void {
  episodes.clear();
}
