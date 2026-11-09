/**
 * One deadline from the start of a build, and what is left of it for each stage
 * (Issue #4223, design §5.5). Stages do not add fixed timeouts up: each one takes
 * from what the earlier ones left, so a slow membership leaves less to the rest.
 *
 * @module lib/brief/deadline
 */

export class BriefDeadlineExpiredError extends Error {
  constructor(stage: string) {
    super(`brief deadline passed (${stage})`);
  }
}

export interface BriefDeadline {
  readonly at: number;
  remaining(): number;
  expired(): boolean;
}

export function createBriefDeadline(now: () => number, totalMs: number): BriefDeadline {
  const at = now() + totalMs;
  return {
    at,
    remaining: () => at - now(),
    expired: () => now() >= at,
  };
}

const TIMED_OUT = Symbol('timed-out');

/**
 * `promise`, or `onTimeout()` once `ms` passed. The promise is not stopped (it cannot
 * be); its late answer is dropped.
 */
export async function withinMs<T, F>(promise: Promise<T>, ms: number, onTimeout: () => F): Promise<T | F> {
  if (ms <= 0) {
    promise.catch(() => undefined);
    return onTimeout();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const winner = await Promise.race([promise, timeout]);
    if (winner === TIMED_OUT) {
      promise.catch(() => undefined);
      return onTimeout();
    }
    return winner as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
