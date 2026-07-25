/**
 * Unit tests for the fixed-window request rate limiter (Issue #1517).
 *
 * `/api/fs/browse` needs a cap on *successful* requests — each one costs a
 * readdir on the operator's filesystem — which the failed-login limiter in
 * auth.ts does not provide.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequestRateLimiter } from '@/lib/security/request-rate-limiter';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRequestRateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = createRequestRateLimiter({ limit: 3, windowMs: 60_000 });

    for (let i = 0; i < 3; i++) {
      expect(limiter.check('10.0.0.1').allowed).toBe(true);
    }
  });

  it('rejects the request past the limit with a retryAfter', () => {
    const limiter = createRequestRateLimiter({ limit: 2, windowMs: 60_000 });

    limiter.check('10.0.0.1');
    limiter.check('10.0.0.1');
    const blocked = limiter.check('10.0.0.1');

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
  });

  it('counts each key independently', () => {
    const limiter = createRequestRateLimiter({ limit: 1, windowMs: 60_000 });

    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    expect(limiter.check('10.0.0.1').allowed).toBe(false);
    expect(limiter.check('10.0.0.2').allowed).toBe(true);
  });

  it('starts a fresh window once the previous one elapses', () => {
    const limiter = createRequestRateLimiter({ limit: 1, windowMs: 1_000 });

    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    expect(limiter.check('10.0.0.1').allowed).toBe(false);

    vi.advanceTimersByTime(1_000);

    expect(limiter.check('10.0.0.1').allowed).toBe(true);
  });

  it('does not keep the process alive via its cleanup timer', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    createRequestRateLimiter({ limit: 1, windowMs: 1_000 });

    expect(unref).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});
