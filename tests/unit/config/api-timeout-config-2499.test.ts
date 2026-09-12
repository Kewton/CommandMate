/**
 * The client's HTTP timeout / retry policy (Issue #2499).
 *
 * These are the decisions `fetchApiResponse` delegates rather than hard-codes,
 * so they can be asserted without a network: whether a method may be repeated,
 * whether a status is worth repeating for, and what the backoff between
 * attempts comes to. The transport tests in
 * `tests/unit/lib/api-client-timeout-retry-2499.test.ts` cover the behavior
 * built on top of them.
 *
 * The relationships between the constants are pinned as well as the constants
 * themselves. A timeout and a retry count are a single budget — the product is
 * what the user waits through — and the coherence assertions below are there so
 * that raising one of the factors without looking at the others fails here
 * instead of in somebody's hands on a train.
 */

import { describe, it, expect } from 'vitest';
import {
  API_GET_TIMEOUT_MS,
  API_IDEMPOTENT_METHODS,
  API_MUTATION_TIMEOUT_MS,
  API_NO_TIMEOUT,
  API_POLL_TIMEOUT_MS,
  API_REACHABILITY_REPORT_INTERVAL_MS,
  API_RETRYABLE_STATUS_CODES,
  API_RETRY_BACKOFF_FACTOR,
  API_RETRY_BASE_DELAY_MS,
  API_RETRY_JITTER_RATIO,
  API_RETRY_MAX_DELAY_MS,
  API_RETRY_MAX_RETRIES,
  API_RETRY_TOTAL_BUDGET_MS,
  computeRetryDelayMs,
  isIdempotentMethod,
  isRetryableStatus,
  resolveDefaultTimeoutMs,
} from '@/config/api-timeout-config';

describe('[#2499] timeouts', () => {
  it('bounds every default — the bug was an unbounded wait', () => {
    for (const value of [API_GET_TIMEOUT_MS, API_MUTATION_TIMEOUT_MS, API_POLL_TIMEOUT_MS]) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('gives a poll less patience than a one-shot read', () => {
    // A poll's next attempt is already scheduled, so a stalled tick that waits
    // the full read budget stacks in-flight requests against the cadence.
    expect(API_POLL_TIMEOUT_MS).toBeLessThan(API_GET_TIMEOUT_MS);
  });

  it('gives a write more patience than a read, because a write is not retried', () => {
    expect(API_MUTATION_TIMEOUT_MS).toBeGreaterThan(API_GET_TIMEOUT_MS);
  });

  it('leaves enough room above a slow-link round trip to not cut off successes', () => {
    // 2G-class latency on a cold TLS handshake is ~3-5s for a small JSON body.
    expect(API_GET_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
  });

  it('treats API_NO_TIMEOUT as the "unbounded" sentinel the transport tests for', () => {
    expect(API_NO_TIMEOUT).toBe(0);
  });

  it('resolves the default from the method', () => {
    expect(resolveDefaultTimeoutMs()).toBe(API_GET_TIMEOUT_MS);
    expect(resolveDefaultTimeoutMs('GET')).toBe(API_GET_TIMEOUT_MS);
    expect(resolveDefaultTimeoutMs('HEAD')).toBe(API_GET_TIMEOUT_MS);
    expect(resolveDefaultTimeoutMs('POST')).toBe(API_MUTATION_TIMEOUT_MS);
    expect(resolveDefaultTimeoutMs('PATCH')).toBe(API_MUTATION_TIMEOUT_MS);
    expect(resolveDefaultTimeoutMs('DELETE')).toBe(API_MUTATION_TIMEOUT_MS);
  });
});

describe('[#2499] isIdempotentMethod — the guard behind "a send is never duplicated"', () => {
  it('admits the read methods', () => {
    expect(isIdempotentMethod('GET')).toBe(true);
    expect(isIdempotentMethod('HEAD')).toBe(true);
    expect(isIdempotentMethod('OPTIONS')).toBe(true);
  });

  it('is case-insensitive, and reads an absent method as GET like fetch() does', () => {
    expect(isIdempotentMethod('get')).toBe(true);
    expect(isIdempotentMethod(undefined)).toBe(true);
    expect(isIdempotentMethod(null)).toBe(true);
  });

  it('refuses every method that writes', () => {
    // POST is the one this Issue's acceptance criterion names: a timed-out
    // `POST /send` may well have been applied with only the response lost, so a
    // retry is a second message in the user's conversation, not a second try.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'patch']) {
      expect(isIdempotentMethod(method)).toBe(false);
    }
  });

  it('never lists a writing method, whatever else is added to the set', () => {
    for (const method of API_IDEMPOTENT_METHODS) {
      expect(['GET', 'HEAD', 'OPTIONS']).toContain(method);
    }
  });
});

describe('[#2499] isRetryableStatus', () => {
  it('accepts the "not now" statuses', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('refuses a success, so a 200 or a 304 is never repeated', () => {
    for (const status of [200, 201, 204, 304]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('refuses a verdict about the request itself', () => {
    // Repeating these produces the same answer at the cost of a round trip —
    // and for 401 it would mean re-walking the auth redirect three times.
    for (const status of [400, 401, 403, 404, 409, 422, 501]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('lists only statuses, never a bare 0', () => {
    // 0 is how a transport failure is represented in ApiError; it is handled on
    // the rejection path and must not double as a "retryable status".
    expect(API_RETRYABLE_STATUS_CODES).not.toContain(0);
  });
});

describe('[#2499] computeRetryDelayMs', () => {
  it('grows exponentially from the base at the midpoint of the jitter', () => {
    // random = 0.5 maps to zero jitter, exposing the nominal delay.
    expect(computeRetryDelayMs(0, 0.5)).toBe(API_RETRY_BASE_DELAY_MS);
    expect(computeRetryDelayMs(1, 0.5)).toBe(API_RETRY_BASE_DELAY_MS * API_RETRY_BACKOFF_FACTOR);
    expect(computeRetryDelayMs(2, 0.5)).toBe(
      API_RETRY_BASE_DELAY_MS * API_RETRY_BACKOFF_FACTOR ** 2,
    );
  });

  it('spreads symmetrically around the nominal delay, so a retry can come sooner', () => {
    const nominal = API_RETRY_BASE_DELAY_MS;
    const earliest = computeRetryDelayMs(0, 0);
    const latest = computeRetryDelayMs(0, 0.999999);

    expect(earliest).toBeLessThan(nominal);
    expect(latest).toBeGreaterThan(nominal);
    expect(earliest).toBe(Math.round(nominal * (1 - API_RETRY_JITTER_RATIO)));
  });

  it('never exceeds the nominal delay by more than the jitter ratio', () => {
    for (let attempt = 0; attempt <= 6; attempt++) {
      for (const random of [0, 0.25, 0.5, 0.75, 0.999999]) {
        const nominal = Math.min(
          API_RETRY_BASE_DELAY_MS * API_RETRY_BACKOFF_FACTOR ** attempt,
          API_RETRY_MAX_DELAY_MS,
        );
        const delay = computeRetryDelayMs(attempt, random);
        expect(delay).toBeGreaterThanOrEqual(Math.floor(nominal * (1 - API_RETRY_JITTER_RATIO)));
        expect(delay).toBeLessThanOrEqual(Math.ceil(nominal * (1 + API_RETRY_JITTER_RATIO)));
      }
    }
  });

  it('caps the growth, so a high attempt number cannot produce a minute-long wait', () => {
    expect(computeRetryDelayMs(20, 0.5)).toBe(API_RETRY_MAX_DELAY_MS);
  });

  it('is never negative, whatever it is handed', () => {
    for (const attempt of [-5, -1, 0, Number.NaN, 3]) {
      for (const random of [0, 0.5, 1]) {
        expect(computeRetryDelayMs(attempt, random)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('defaults to real randomness without one being supplied', () => {
    const samples = new Set(Array.from({ length: 40 }, () => computeRetryDelayMs(1)));
    // Every client polls on the same cadence, so a server blip fails them all at
    // once; identical delays would reproduce the spike on a schedule.
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('[#2499] the budget the constants add up to', () => {
  it('retries few enough times that a down network is not hammered', () => {
    expect(API_RETRY_MAX_RETRIES).toBeGreaterThanOrEqual(1);
    expect(API_RETRY_MAX_RETRIES).toBeLessThanOrEqual(3);
  });

  it('caps one logical request well short of the sum of its parts', () => {
    // Without the budget the worst case is every timeout plus every backoff —
    // ~32s for a default GET, by which point the user has decided the app is
    // broken. The ceiling has to be shorter than that sum to mean anything.
    const worstCaseWithoutBudget =
      API_GET_TIMEOUT_MS * (API_RETRY_MAX_RETRIES + 1) +
      API_RETRY_MAX_DELAY_MS * API_RETRY_MAX_RETRIES;
    expect(API_RETRY_TOTAL_BUDGET_MS).toBeLessThan(worstCaseWithoutBudget);
    // ...and long enough to fit more than the first attempt, or retry is dead code.
    expect(API_RETRY_TOTAL_BUDGET_MS).toBeGreaterThan(API_GET_TIMEOUT_MS);
  });

  it('throttles reachability reports over a window longer than a poll cadence', () => {
    // The point of the throttle is that a 2s poll does not push an identical
    // verdict through every connectivity surface 30 times a minute.
    expect(API_REACHABILITY_REPORT_INTERVAL_MS).toBeGreaterThan(API_POLL_TIMEOUT_MS);
  });
});
