/**
 * The one timer of mem's evaluation (Issue #4222, design §7). A caller stops waiting
 * at its own deadline; the timer is cleared in `finally`, so an evaluation leaves no
 * timer behind whichever way it ends. Nothing else under `src/lib/mem/` may call
 * `setTimeout` (`tests/unit/guards/mem-no-resident-4222.test.ts`).
 *
 * @module lib/mem/eval-deadline
 */

export type DeadlineOutcome<T> = { ok: true; value: T } | { ok: false };

/** Wait for `promise` at most `ms`. `ms <= 0` answers at once without a timer. */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
  if (ms <= 0) return { ok: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value): DeadlineOutcome<T> => ({ ok: true, value })), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
