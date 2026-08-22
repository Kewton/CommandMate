/**
 * Freeze the wall clock for a test that compares two payloads (Issue #1926).
 *
 * ## Why this exists
 *
 * `CurrentOutputPayload.lastKnownStatusAt` is `Date.now()` read at the moment of
 * the poll. Several suites assert that some action "changes nothing else in the
 * payload" by building the payload twice and comparing the two whole objects —
 * and two successive builds land on different milliseconds whenever the process
 * is loaded enough for the pair to straddle a tick. On a quiet laptop they
 * almost never do; in CI they do, and PR #1964 failed on a one-millisecond
 * difference. A time-dependent `toEqual` is not flaky, it is a test that will
 * certainly fail eventually.
 *
 * Freezing is preferred over excluding the field from the comparison. Those
 * assertions exist to prove the WHOLE payload is untouched, and a field dropped
 * from the equality is a field the case no longer checks — the same "vacuous
 * green" the suites themselves are written against. With the clock frozen the
 * field stays in, and its meaning is pinned separately by the range and
 * monotonicity cases in `tests/unit/session/status-contract-1926.test.ts`.
 *
 * ## Why `toFake: ['Date']`
 *
 * Only `Date` is replaced. `setTimeout` / `setInterval` / `queueMicrotask` stay
 * real, so a test that freezes the clock cannot deadlock on a timer nobody
 * advances — which is the usual cost of `vi.useFakeTimers()` and the reason
 * suites avoid it.
 *
 * Usage:
 *
 *   afterEach(() => unfreezeClock());
 *   it('…', async () => { freezeClock(); … });
 */

import { vi } from 'vitest';

/**
 * The instant tests freeze at, by default.
 *
 * A fixed epoch rather than "now", so a suite behaves the same on every machine
 * and in every year. Deliberately LATER than the `1_700_000_000_00x` literals
 * these suites record events at, by far more than
 * `STRUCTURED_STATE_MAX_AGE_MS` — those events are meant to read as stale, which
 * is what they already do against the real clock, and a frozen clock that made
 * them fresh would change verdicts rather than just stabilise timestamps.
 *
 * 2027-01-15T08:00:00Z.
 */
export const FROZEN_NOW_MS = 1_800_000_000_000;

/** Stop the wall clock at `atMs`. Pair with {@link unfreezeClock}. */
export function freezeClock(atMs: number = FROZEN_NOW_MS): void {
  vi.useFakeTimers({ now: atMs, toFake: ['Date'] });
}

/** Restore the real clock. Safe to call when it was never frozen. */
export function unfreezeClock(): void {
  vi.useRealTimers();
}
