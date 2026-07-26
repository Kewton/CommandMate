/**
 * Fixed-window request rate limiter (Issue #1517).
 *
 * Distinct from `createRateLimiter()` in auth.ts, which counts *failed* login
 * attempts and locks out for 15 minutes. Directory browsing needs a cap on
 * successful requests too, because each one costs a readdir on the operator's
 * filesystem.
 */

interface WindowEntry {
  count: number;
  windowStartedAt: number;
}

export interface RequestRateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets. Only set when `allowed` is false. */
  retryAfter?: number;
}

export interface RequestRateLimiter {
  check(key: string): RequestRateLimitResult;
}

export interface RequestRateLimiterOptions {
  /** Maximum requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export function createRequestRateLimiter(
  options: RequestRateLimiterOptions
): RequestRateLimiter {
  const { limit, windowMs } = options;
  const entries = new Map<string, WindowEntry>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now - entry.windowStartedAt > windowMs) {
        entries.delete(key);
      }
    }
  }, windowMs);
  cleanupTimer.unref?.();

  return {
    check(key: string): RequestRateLimitResult {
      const now = Date.now();
      const entry = entries.get(key);

      if (!entry || now - entry.windowStartedAt >= windowMs) {
        entries.set(key, { count: 1, windowStartedAt: now });
        return { allowed: true };
      }

      entry.count++;
      if (entry.count > limit) {
        return {
          allowed: false,
          retryAfter: Math.max(
            1,
            Math.ceil((entry.windowStartedAt + windowMs - now) / 1000)
          ),
        };
      }

      return { allowed: true };
    },
  };
}
