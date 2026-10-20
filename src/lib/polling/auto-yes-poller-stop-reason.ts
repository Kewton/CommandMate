/**
 * The reason a poller stop is made for, when the stop function is called
 * without one (Issue #3730).
 *
 * `stopAutoYesPolling(compositeKey, reason)` takes the reason as an argument,
 * and every direct caller passes it. The lifecycle table
 * (`lib/auto-yes-lifecycle`) cannot: it reaches the poller through the
 * `auto-yes-manager` barrel, whose callers' tests mock it and pin the exact
 * arguments (`stopAutoYesPolling(key)`, `stopAutoYesPollingByWorktree(id)`).
 * So the table names its event here, around the call, and the poller reads it
 * when no argument came. Synchronous only: the scope ends when `fn` returns.
 *
 * A module of its own, not part of the barrel, so mocking the barrel never
 * mocks this away.
 *
 * @module lib/polling/auto-yes-poller-stop-reason
 */

import type { AutoYesPollerStopReason } from '@/config/auto-yes-config';

let scopedReason: AutoYesPollerStopReason | null = null;

/**
 * Run `fn` with `reason` as the reason of every poller stop it makes that
 * names none itself.
 *
 * @param reason - Why the pollers are being stopped
 * @param fn - The synchronous stop call(s)
 * @returns What `fn` returns
 */
export function withPollerStopReason<T>(reason: AutoYesPollerStopReason, fn: () => T): T {
  const previous = scopedReason;
  scopedReason = reason;
  try {
    return fn();
  } finally {
    scopedReason = previous;
  }
}

/**
 * The reason to log for a stop: the explicit one, else the scope's, else
 * `fallback`.
 *
 * @param explicit - The reason the caller passed, if any
 * @param fallback - What to answer when neither says
 */
export function resolvePollerStopReason(
  explicit: AutoYesPollerStopReason | undefined,
  fallback: AutoYesPollerStopReason,
): AutoYesPollerStopReason {
  return explicit ?? scopedReason ?? fallback;
}
