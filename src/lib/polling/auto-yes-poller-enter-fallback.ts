/**
 * Auto-Yes poller: the Enter fallback's audit answer and per-session epoch
 * (Issue #3397) (Issue #3783: split out of `auto-yes-poller.ts`, which
 * re-exports the public names; the Enter itself — `tryEnterFallback` — and its
 * fresh-frame check stay there).
 *
 * Does not statically import `auto-yes-poller.ts` (no cycle outside the
 * baseline in `import-cycles-baseline-3482`, which does not count dynamic
 * `import()`).
 *
 * @module lib/polling/auto-yes-poller-enter-fallback
 */

import { getEnterFallbackSessionEpoch } from './auto-yes-enter-fallback';
import type { AutoYesPollerState } from './auto-yes-poller-state';

/**
 * The audit row's `answer` for the Enter (Issue #3397): not a digit, so the
 * History reads as "Auto-Yes pressed Enter" rather than as a chosen option.
 */
export const AUTO_YES_ENTER_FALLBACK_ANSWER = '[Enter]';

/**
 * Issue #3397: a session begun since the last tick (a relaunch the poller
 * outlived) starts with no screen that had its Enter.
 *
 * @returns The session epoch the tick reads under
 */
export function syncEnterFallbackEpoch(compositeKey: string, pollerState: AutoYesPollerState): number {
  const epoch = getEnterFallbackSessionEpoch(compositeKey);
  if ((pollerState.enterFallbackEpoch ?? 0) !== epoch) {
    pollerState.enterFallbackSentKey = null;
    pollerState.enterFallbackCandidateKey = null;
    pollerState.enterFallbackEpoch = epoch;
  }
  return epoch;
}
