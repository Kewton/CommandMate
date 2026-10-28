/**
 * wait Command - poll interval and the deadline arithmetic of a poll
 * Issue #3964: split out of wait.ts; wait.ts re-exports what it exported.
 */

import type { WaitOptions } from '../types';

/** [IA3-02] Polling interval 5 seconds (matches tmux-capture-cache TTL=2s) */
export const POLL_INTERVAL_MS = 5000;

/**
 * Whether one more poll interval still lands inside `--timeout` and
 * `--stall-timeout` (Issue #2463).
 *
 * The Auto-Yes hold asks before it sleeps. Otherwise a caller whose deadline
 * lapses during the hold would hear 124 about a prompt it used to hear 10 about:
 * the hold is there to give Auto-Yes a chance to answer, not to turn an open
 * prompt into a timeout. The same two checks the top of {@link pollWorktree}'s
 * loop makes, one interval ahead.
 */
export function nextPollWithinDeadlines(
  options: WaitOptions,
  startTime: number,
  lastActivityTime: number,
  now: number,
): boolean {
  const nextPollAt = now + POLL_INTERVAL_MS;
  if (options.timeout && nextPollAt - startTime >= options.timeout * 1000) return false;
  if (options.stallTimeout && nextPollAt - lastActivityTime >= options.stallTimeout * 1000) {
    return false;
  }
  return true;
}

/**
 * Milliseconds left before `--timeout` or `--stall-timeout` would end the wait,
 * whichever is sooner; `Infinity` when neither is set (Issue #3956).
 */
export function msBeforeDeadlines(
  options: WaitOptions,
  startTime: number,
  lastActivityTime: number,
  now: number,
): number {
  let remaining = Infinity;
  if (options.timeout) remaining = Math.min(remaining, startTime + options.timeout * 1000 - now);
  if (options.stallTimeout) {
    remaining = Math.min(remaining, lastActivityTime + options.stallTimeout * 1000 - now);
  }
  return remaining;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
