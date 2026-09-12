/**
 * The client transport gets a deadline, a retry ladder and an offline
 * fail-fast (Issue #2499).
 *
 * The bug was not slowness. `fetch()` has no timeout, so a request whose
 * connection is nominally open but moving no bytes — a phone that walked out of
 * LTE mid-request, a Wi-Fi handover, a captive portal swallowing the SYN —
 * never settles and never rejects. Every caller in the app `await`s it, so the
 * promise that never settles is the spinner that never stops. That is what
 * these tests are about: the *upper bound*, not the speed.
 *
 * The deadline is driven with fake timers rather than stubbed, because "the
 * request is cut off" is the fix — a test that called an injected timeout
 * callback directly would pass against the very code this Issue replaced. The
 * `hangingFetch` stub below is the failure mode itself: a promise that settles
 * only when its `AbortSignal` fires, which is exactly what a stalled connection
 * looks like from JavaScript.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  fetchApiResponse,
  isAbortedError,
  isOfflineError,
  isTimeoutError,
  worktreeApi,
  __resetApiReachabilityReporting,
} from '@/lib/api-client';
import { subscribeServerReachability } from '@/hooks/useConnectivity';
import {
  API_GET_TIMEOUT_MS,
  API_MUTATION_TIMEOUT_MS,
  API_NO_TIMEOUT,
  API_POLL_TIMEOUT_MS,
  API_RETRY_BASE_DELAY_MS,
  API_RETRY_JITTER_RATIO,
  API_RETRY_MAX_RETRIES,
  API_RETRY_TOTAL_BUDGET_MS,
} from '@/config/api-timeout-config';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const URL_UNDER_TEST = '/api/worktrees/wt-2499';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: `http://localhost${URL_UNDER_TEST}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

/**
 * A request that never answers — the failure this Issue exists for.
 *
 * It settles only when the signal it was handed aborts, and then with the same
 * `AbortError` a real `fetch()` produces, so the normalization under test is
 * normalizing the real shape.
 */
function hangingFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
    });
}

/** What a phone with no signal actually produces. */
function transportFailure(): Error {
  return new TypeError('Failed to fetch');
}

/** Narrowest window a first retry can be scheduled in, from the constants. */
const FIRST_BACKOFF_MIN_MS = Math.floor(API_RETRY_BASE_DELAY_MS * (1 - API_RETRY_JITTER_RATIO));
const FIRST_BACKOFF_MAX_MS = Math.ceil(API_RETRY_BASE_DELAY_MS * (1 + API_RETRY_JITTER_RATIO));

/** Enough time for any retry ladder this policy can produce to run to its end. */
const PAST_EVERY_DEADLINE_MS = API_RETRY_TOTAL_BUDGET_MS + API_MUTATION_TIMEOUT_MS;

const mockFetch = vi.fn();

/** Track settlement without awaiting, so "still pending" is assertable. */
function watch<T>(promise: Promise<T>): { settled: () => boolean; promise: Promise<T> } {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled, promise };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  // Pinned rather than inherited: Node and jsdom disagree about whether
  // `navigator.onLine` exists at all, and every test but the offline ones needs
  // it to say "on a network".
  vi.stubGlobal('navigator', { onLine: true });
  __resetApiReachabilityReporting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

describe('[#2499] a hung request is cut off', () => {
  it('rejects a stalled GET at API_GET_TIMEOUT_MS, having waited exactly that long', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const { settled, promise } = watch(fetchApiResponse(URL_UNDER_TEST, { retries: 0 }));

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    // The pre-#2499 behavior, and the whole complaint: still waiting.
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(settled()).toBe(true);
    await expect(promise).rejects.toBeInstanceOf(ApiError);
  });

  it('normalizes the AbortError into a timeout ApiError a caller can read', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const promise = fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const rejection = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS + 1);
    const error = await rejection;

    // A raw AbortError is a DOMException whose `name` is the only thing
    // distinguishing it — and it is indistinguishable from a caller's abort.
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).name).toBe('ApiError');
    expect((error as ApiError).kind).toBe('timeout');
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain(String(API_GET_TIMEOUT_MS));
    expect(isTimeoutError(error)).toBe(true);
    expect(isAbortedError(error)).toBe(false);
    expect(isOfflineError(error)).toBe(false);
  });

  it('actually cancels the request rather than only abandoning it', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const promise = fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    promise.catch(() => {});
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS + 1);

    // Without this the socket stays open and the phone keeps paying for it.
    expect(signal.aborted).toBe(true);
    await expect(promise).rejects.toThrow();
  });

  it('gives a write the longer budget, because cutting one off is not recoverable', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const { settled, promise } = watch(
      fetchApiResponse(URL_UNDER_TEST, { method: 'POST', body: '{}' }),
    );

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS + 1);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(API_MUTATION_TIMEOUT_MS);
    expect(settled()).toBe(true);
    await expect(promise).rejects.toBeInstanceOf(ApiError);
  });

  it('honours a call site that asks for the shorter polling budget', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const { settled, promise } = watch(
      fetchApiResponse(URL_UNDER_TEST, { timeoutMs: API_POLL_TIMEOUT_MS, retries: 0 }),
    );

    await vi.advanceTimersByTimeAsync(API_POLL_TIMEOUT_MS + 1);
    expect(settled()).toBe(true);
    await expect(promise).rejects.toBeInstanceOf(ApiError);
  });

  it('leaves a request unbounded when the call site opts out on purpose', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const { settled } = watch(
      fetchApiResponse(URL_UNDER_TEST, { timeoutMs: API_NO_TIMEOUT, retries: 0 }),
    );

    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);

    // The sentinel has to mean something, or "this one really can take minutes"
    // has nowhere to go but back to a bare fetch().
    expect(settled()).toBe(false);
    expect(mockFetch.mock.calls[0][1].signal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Offline fail-fast
// ---------------------------------------------------------------------------

describe('[#2499] navigator.onLine === false fails immediately', () => {
  it('never reaches fetch, and does not wait out the timeout to say so', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    mockFetch.mockImplementation(hangingFetch());

    const error = await fetchApiResponse(URL_UNDER_TEST).catch((e: unknown) => e);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(isOfflineError(error)).toBe(true);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).kind).toBe('offline');
  });

  it('resolves without any timer advancement at all', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    mockFetch.mockImplementation(hangingFetch());

    const { settled } = watch(fetchApiResponse(URL_UNDER_TEST).catch(() => null));
    // One microtask turn, no clock — "immediate" is the acceptance criterion.
    await Promise.resolve();
    await Promise.resolve();

    expect(settled()).toBe(true);
  });

  it('does not read navigator.onLine === true as permission to skip anything', async () => {
    // The asymmetry from useConnectivity: `true` is worth nothing, because a
    // captive portal reports it happily. It must not shortcut the request.
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    const response = await fetchApiResponse(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('survives an environment with no navigator at all', async () => {
    vi.stubGlobal('navigator', undefined);
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    await expect(fetchApiResponse(URL_UNDER_TEST)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe('[#2499] an idempotent GET is retried', () => {
  it('recovers from a single dropped request without the caller knowing', async () => {
    mockFetch
      .mockRejectedValueOnce(transportFailure())
      .mockResolvedValueOnce(jsonResponse({ id: 'wt-2499' }));

    const promise = fetchApiResponse(URL_UNDER_TEST);
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MAX_MS + 1);

    const response = await promise;
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('backs off before the retry instead of hammering the failing link', async () => {
    mockFetch.mockRejectedValue(transportFailure());

    const promise = fetchApiResponse(URL_UNDER_TEST);
    promise.catch(() => {});

    // Drain the first rejection without moving the clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MIN_MS - 1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MAX_MS - FIRST_BACKOFF_MIN_MS + 2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stops after API_RETRY_MAX_RETRIES and reports the failure it has', async () => {
    mockFetch.mockRejectedValue(transportFailure());

    const promise = fetchApiResponse(URL_UNDER_TEST);
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    const error = await rejection;

    expect(mockFetch).toHaveBeenCalledTimes(API_RETRY_MAX_RETRIES + 1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('network');
    expect((error as ApiError).message).toBe('Failed to fetch');
  });

  it('retries a timeout too, not only a transport error', async () => {
    mockFetch.mockImplementationOnce(hangingFetch()).mockResolvedValueOnce(jsonResponse({ ok: 1 }));

    const promise = fetchApiResponse(URL_UNDER_TEST, { timeoutMs: API_POLL_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(API_POLL_TIMEOUT_MS + FIRST_BACKOFF_MAX_MS + 1);

    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 — the shape a restarting server puts in front of a proxy', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'restarting' }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: 'wt-2499' }));

    const promise = fetchApiResponse(URL_UNDER_TEST);
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MAX_MS + 1);

    await expect(promise).resolves.toMatchObject({ status: 200 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a verdict about the request itself', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Not found' }, 404));

    const promise = fetchApiResponse(URL_UNDER_TEST);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);

    // The response is returned, not thrown: interpreting a status is fetchApi's
    // job, and a call site that wants the raw 404 gets it.
    await expect(promise).resolves.toMatchObject({ status: 404 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('honours retries: 0, which is how every polling call site opts out', async () => {
    mockFetch.mockRejectedValue(transportFailure());

    const promise = fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    await rejection;

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once API_RETRY_TOTAL_BUDGET_MS is spent, however many are left', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const promise = fetchApiResponse(URL_UNDER_TEST, {
      timeoutMs: API_RETRY_TOTAL_BUDGET_MS,
      retries: 5,
    });
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    const error = await rejection;

    // One attempt consumed the whole budget, so the five permitted retries are
    // not taken: a person who has waited this long wants an answer more than
    // they want another attempt.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(isTimeoutError(error)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The duplicate-send guard
// ---------------------------------------------------------------------------

describe('[#2499] a write is never repeated', () => {
  it('does not retry a POST that failed at the transport', async () => {
    mockFetch.mockRejectedValue(transportFailure());

    const promise = fetchApiResponse(URL_UNDER_TEST, { method: 'POST', body: '{}' });
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    await rejection;

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a POST even when the call site explicitly asks for retries', async () => {
    mockFetch.mockRejectedValue(transportFailure());

    const promise = fetchApiResponse(URL_UNDER_TEST, {
      method: 'POST',
      body: '{}',
      retries: 5,
    });
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    await rejection;

    // The hazard belongs to the method, not to the call site's confidence.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a POST that got a 503, where a GET would have', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'restarting' }, 503));

    const promise = fetchApiResponse(URL_UNDER_TEST, { method: 'POST', body: '{}' });
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);

    await expect(promise).resolves.toMatchObject({ status: 503 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends `POST /send` exactly once when the network is failing', async () => {
    mockFetch.mockRejectedValue(transportFailure());

    const promise = worktreeApi.sendMessage('wt-2499', 'hello');
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    const error = await rejection;

    // The user's own words: a timed-out send may well have been applied with
    // only the response lost, so a retry is a second message in their
    // conversation, not a second attempt at the first.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/worktrees/wt-2499/send');
    expect(error).toBeInstanceOf(ApiError);
  });

  it('sends `POST /send` exactly once when the server answers 503', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'restarting' }, 503));

    const promise = worktreeApi.sendMessage('wt-2499', 'hello');
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    const error = await rejection;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((error as ApiError).status).toBe(503);
  });

  it('applies the deadline to a send, so a hung one still fails', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const promise = worktreeApi.sendMessage('wt-2499', 'hello');
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(API_MUTATION_TIMEOUT_MS + 1);
    const error = await rejection;

    // Not retried, but not unbounded either: the composer has to be told.
    expect(error).toBeInstanceOf(ApiError);
    expect(isTimeoutError(error)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A caller's own abort
// ---------------------------------------------------------------------------

describe("[#2499] the caller's own abort is an instruction, not a fault", () => {
  it('ends the ladder immediately instead of retrying', async () => {
    mockFetch.mockImplementation(hangingFetch());
    const controller = new AbortController();

    const promise = fetchApiResponse(URL_UNDER_TEST, { signal: controller.signal });
    const rejection = promise.catch((e: unknown) => e);
    controller.abort();
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    const error = await rejection;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(isAbortedError(error)).toBe(true);
    expect(isTimeoutError(error)).toBe(false);
  });

  it('refuses before the request when the signal is already aborted', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    const controller = new AbortController();
    controller.abort();

    const error = await fetchApiResponse(URL_UNDER_TEST, {
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(isAbortedError(error)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reachability reporting (the #2501 seam)
// ---------------------------------------------------------------------------

describe('[#2499 × #2501] every request feeds the connection verdict', () => {
  let reports: boolean[];
  let unsubscribe: () => void;

  beforeEach(() => {
    reports = [];
    unsubscribe = subscribeServerReachability((reachable) => reports.push(reachable));
  });

  afterEach(() => {
    unsubscribe();
  });

  it('reports reachable on a success', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    await fetchApiResponse(URL_UNDER_TEST);

    expect(reports).toEqual([true]);
  });

  it('reports reachable on a 500 — the packet crossed the network and came back', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));

    const promise = fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    // "Reachable" is about the transport, not about the answer. Reporting
    // `false` here would blank the app's banner over a server-side bug.
    expect(reports).toEqual([true]);
  });

  it('reports unreachable on a transport failure', async () => {
    mockFetch.mockRejectedValue(transportFailure());

    const promise = fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const rejection = promise.catch(() => null);
    await vi.advanceTimersByTimeAsync(0);
    await rejection;

    expect(reports).toEqual([false]);
  });

  it('reports unreachable on a timeout', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const promise = fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const rejection = promise.catch(() => null);
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS + 1);
    await rejection;

    expect(reports).toEqual([false]);
  });

  it('says nothing from the offline fail-fast, which measured nothing', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    await fetchApiResponse(URL_UNDER_TEST).catch(() => null);

    // The device signal is `useConnectivity`'s own input; putting a *server*
    // verdict on the wire from it would be inventing evidence.
    expect(reports).toEqual([]);
  });

  it("says nothing about the server when the caller aborted", async () => {
    mockFetch.mockImplementation(hangingFetch());
    const controller = new AbortController();

    const promise = fetchApiResponse(URL_UNDER_TEST, { signal: controller.signal });
    const rejection = promise.catch(() => null);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await rejection;

    expect(reports).toEqual([]);
  });

  it('collapses a run of identical verdicts to the transition', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    for (let i = 0; i < 5; i++) {
      await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    }

    // The detail screen alone polls three endpoints every 2s; re-announcing
    // "still reachable" would re-render every connectivity surface for nothing.
    expect(reports).toEqual([true]);
  });

  it('reports both sides of a transition', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });

    mockFetch.mockRejectedValueOnce(transportFailure());
    await fetchApiResponse(URL_UNDER_TEST, { retries: 0 }).catch(() => null);

    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });

    expect(reports).toEqual([true, false, true]);
  });
});

// ---------------------------------------------------------------------------
// fetchApi inherits all of it
// ---------------------------------------------------------------------------

describe('[#2499] fetchApi call sites inherited the policy without changing', () => {
  it('surfaces a hung GET as an ApiError instead of hanging forever', async () => {
    mockFetch.mockImplementation(hangingFetch());

    const promise = worktreeApi.getById('wt-2499');
    const rejection = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PAST_EVERY_DEADLINE_MS);
    const error = await rejection;

    expect(error).toBeInstanceOf(ApiError);
    expect(isTimeoutError(error)).toBe(true);
  });

  it('still sets Content-Type and still parses the body on the happy path', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'wt-2499', name: 'detail' }));

    const worktree = await worktreeApi.getById('wt-2499');

    expect(worktree).toMatchObject({ id: 'wt-2499' });
    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('retries a GET through fetchApi and resolves from the retry', async () => {
    mockFetch
      .mockRejectedValueOnce(transportFailure())
      .mockResolvedValueOnce(jsonResponse({ id: 'wt-2499' }));

    const promise = worktreeApi.getById('wt-2499');
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MAX_MS + 1);

    await expect(promise).resolves.toMatchObject({ id: 'wt-2499' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
