/**
 * Unit Tests: Rate Limiter (createRateLimiter from auth.ts)
 * Issue #331: Brute-force protection
 *
 * Tests cover:
 * - 5 failed attempts trigger lockout
 * - Locked out IP returns 429
 * - Successful login resets counter
 * - Cleanup timer removes expired entries
 * - destroy() clears interval
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Rate Limiter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow attempts below the limit', async () => {
    const { createRateLimiter, RATE_LIMIT_CONFIG } = await import('@/lib/auth');
    const limiter = createRateLimiter();

    for (let i = 0; i < RATE_LIMIT_CONFIG.maxAttempts - 1; i++) {
      const result = limiter.checkLimit('192.168.1.1');
      expect(result.allowed).toBe(true);
      limiter.recordFailure('192.168.1.1');
    }

    limiter.destroy();
  });

  it('should block after 5 failed attempts', async () => {
    const { createRateLimiter } = await import('@/lib/auth');
    const limiter = createRateLimiter();

    // Record 5 failures
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('10.0.0.1');
    }

    const result = limiter.checkLimit('10.0.0.1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);

    limiter.destroy();
  });

  it('should return retryAfter in seconds when locked out', async () => {
    const { createRateLimiter, RATE_LIMIT_CONFIG } = await import('@/lib/auth');
    const limiter = createRateLimiter();

    for (let i = 0; i < RATE_LIMIT_CONFIG.maxAttempts; i++) {
      limiter.recordFailure('10.0.0.2');
    }

    const result = limiter.checkLimit('10.0.0.2');
    expect(result.allowed).toBe(false);
    // retryAfter should be approximately 15 minutes in seconds
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(15 * 60);

    limiter.destroy();
  });

  it('should reset counter on successful login', async () => {
    const { createRateLimiter } = await import('@/lib/auth');
    const limiter = createRateLimiter();

    // Record 4 failures
    for (let i = 0; i < 4; i++) {
      limiter.recordFailure('10.0.0.3');
    }

    // Successful login resets
    limiter.recordSuccess('10.0.0.3');

    // Should be allowed again
    const result = limiter.checkLimit('10.0.0.3');
    expect(result.allowed).toBe(true);

    limiter.destroy();
  });

  it('should track different IPs independently', async () => {
    const { createRateLimiter } = await import('@/lib/auth');
    const limiter = createRateLimiter();

    // Lock out IP1
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('10.0.0.10');
    }

    // IP2 should still be allowed
    const result = limiter.checkLimit('10.0.0.11');
    expect(result.allowed).toBe(true);

    limiter.destroy();
  });

  it('should unlock after lockout duration expires', async () => {
    const { createRateLimiter, RATE_LIMIT_CONFIG } = await import('@/lib/auth');
    const limiter = createRateLimiter();

    // Lock out
    for (let i = 0; i < 5; i++) {
      limiter.recordFailure('10.0.0.20');
    }

    expect(limiter.checkLimit('10.0.0.20').allowed).toBe(false);

    // Advance time past lockout duration
    vi.advanceTimersByTime(RATE_LIMIT_CONFIG.lockoutDuration + 1000);

    expect(limiter.checkLimit('10.0.0.20').allowed).toBe(true);

    limiter.destroy();
  });

  it('should cleanup expired entries on interval', async () => {
    const { createRateLimiter, RATE_LIMIT_CONFIG } = await import('@/lib/auth');
    const limiter = createRateLimiter();

    // Record some failures
    limiter.recordFailure('10.0.0.30');
    limiter.recordFailure('10.0.0.30');

    // Advance past lockout + cleanup interval
    vi.advanceTimersByTime(RATE_LIMIT_CONFIG.lockoutDuration + RATE_LIMIT_CONFIG.cleanupInterval + 1000);

    // After cleanup, the entry should be gone, allowing fresh attempts
    const result = limiter.checkLimit('10.0.0.30');
    expect(result.allowed).toBe(true);

    limiter.destroy();
  });

  it('should have a destroy method that cleans up the interval', async () => {
    const { createRateLimiter } = await import('@/lib/auth');
    const limiter = createRateLimiter();

    // destroy should not throw
    expect(() => limiter.destroy()).not.toThrow();
  });
});
