/**
 * A response whose headers arrive and whose body then stops is cut off at the
 * request's deadline (Issue #4034, the web-side counterpart of #3983).
 *
 * `fetchOnce` clears its timer when the headers arrive, so `fetchApi`'s
 * `response.json()` and the error-body read had no bound. Positive controls:
 * the stalled body rejects with `ApiError(kind: 'timeout')` at the instant the
 * deadline falls, on the success path and on the error path. Negative controls:
 * a body that arrives within the deadline resolves as before.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, worktreeApi, isTimeoutError, __resetApiReachabilityReporting } from '@/lib/api-client';
import { API_GET_TIMEOUT_MS } from '@/config/api-timeout-config';

const mockFetch = vi.fn();

/** Headers now; the body never arrives. */
function stalledBody(status: number): Response {
  const never = new Promise<never>(() => {});
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => never,
    text: () => never,
  } as unknown as Response;
}

/** Headers now; the body after `ms`. */
function slowBody(status: number, body: unknown, ms: number): Response {
  const later = new Promise<unknown>((resolve) => setTimeout(() => resolve(body), ms));
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => later,
    text: () => later.then((value) => JSON.stringify(value)),
  } as unknown as Response;
}

function watch<T>(promise: Promise<T>): { settled: () => boolean; error: () => unknown; value: () => T | undefined } {
  let settled = false;
  let error: unknown;
  let value: T | undefined;
  promise.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e: unknown) => {
      settled = true;
      error = e;
    },
  );
  return { settled: () => settled, error: () => error, value: () => value };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  vi.stubGlobal('navigator', { onLine: true });
  __resetApiReachabilityReporting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('[#4034] the body read is inside the deadline', () => {
  it('positive: a 200 whose body stalls rejects with a timeout at the deadline', async () => {
    mockFetch.mockResolvedValue(stalledBody(200));

    const w = watch(worktreeApi.getById('wt1'));

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    expect(w.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(w.settled()).toBe(true);
    expect(w.error()).toBeInstanceOf(ApiError);
    expect(isTimeoutError(w.error())).toBe(true);
  });

  it('positive: an error response whose body stalls rejects with a timeout too', async () => {
    mockFetch.mockResolvedValue(stalledBody(400));

    const w = watch(worktreeApi.getById('wt1'));
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS + 1);

    expect(w.settled()).toBe(true);
    expect(isTimeoutError(w.error())).toBe(true);
  });

  it('positive: the time the headers took is not given to the body again', async () => {
    const headersAfter = 4_000;
    mockFetch.mockImplementation(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(stalledBody(200)), headersAfter)),
    );

    const w = watch(worktreeApi.getById('wt1'));
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    expect(w.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    expect(isTimeoutError(w.error())).toBe(true);
  });

  it('negative: a body that arrives within the deadline resolves as before', async () => {
    mockFetch.mockResolvedValue(slowBody(200, { id: 'wt1' }, API_GET_TIMEOUT_MS - 1_000));

    const w = watch(worktreeApi.getById('wt1'));
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS);

    expect(w.error()).toBeUndefined();
    expect(w.value()).toEqual({ id: 'wt1' });
    // No timer is left to fire later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('negative: an error body that arrives within the deadline is still the server\'s message', async () => {
    mockFetch.mockResolvedValue(slowBody(404, { error: 'not here' }, 1_000));

    const w = watch(worktreeApi.getById('wt1'));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(w.error()).toBeInstanceOf(ApiError);
    expect((w.error() as ApiError).message).toBe('not here');
    expect(isTimeoutError(w.error())).toBe(false);
  });
});
