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

/** The longest delay `setTimeout` honours (2^31-1 ms, ~24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Thrown by {@link readWithinDeadlines} when `--timeout` or `--stall-timeout`
 * ends a read (Issue #3974). Not an `ApiError` and not a failed poll: the poll
 * loop goes back to its deadline check, which ends the wait with exit 124.
 */
export class DeadlineReached extends Error {
  constructor() {
    super('--timeout/--stall-timeout reached during a read');
    this.name = 'DeadlineReached';
  }
}

/**
 * Runs one read of a poll bounded by `--timeout` / `--stall-timeout`
 * (Issue #3974): the read gets an `AbortSignal` that fires when the sooner of
 * the two runs out ({@link msBeforeDeadlines}). With neither set, `read` gets no
 * signal and runs as before (also when the time left is more than a timer can
 * hold). With no time left, no read is started.
 *
 * A read that was aborted — whether it threw (`ApiClient.get`) or swallowed the
 * failure (`readNewestPromptAt`) — throws {@link DeadlineReached}, so a ledger
 * that did not answer is a timeout, not "unreadable". Any other failure is
 * rethrown as it came.
 */
export async function readWithinDeadlines<T>(
  options: WaitOptions,
  startTime: number,
  lastActivityTime: number,
  read: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const budgetMs = msBeforeDeadlines(options, startTime, lastActivityTime, Date.now());
  // Beyond what a timer can hold (setTimeout fires at once past 2^31-1 ms) the
  // read is left unbounded, as with no deadline; a later poll is bounded.
  if (budgetMs > MAX_TIMER_MS) return read();
  if (budgetMs <= 0) throw new DeadlineReached();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const result = await read(controller.signal);
    if (controller.signal.aborted) throw new DeadlineReached();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new DeadlineReached();
    throw error;
  } finally {
    clearTimeout(abortTimer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
