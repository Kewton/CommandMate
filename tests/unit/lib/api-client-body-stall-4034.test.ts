/**
 * The body of a response is inside the deadline too (Issue #4034).
 *
 * `fetchOnce` drops its deadline when the headers arrive, so a server that sends
 * headers and then stops left `response.json()` pending for the life of the tab.
 * The deadline here counts from the last byte received, not from the start of the
 * attempt: a form that counted from the start was withdrawn because it cut off a
 * large log that was still arriving over a slow tunnel.
 *
 * These use real `Response` objects over a stream the test feeds by hand, and the
 * clock is fake, because "a body that stops" is the failure itself.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  detectAuthRedirect,
  fetchApiResponse,
  isAbortedError,
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
} from '@/config/api-timeout-config';

const URL_UNDER_TEST = '/api/worktrees/wt-4034';
const encoder = new TextEncoder();
const JSON_HEADERS = { 'content-type': 'application/json' };

/** A body the test feeds by hand; it moves only when told to. */
function feedableResponse(status = 200, headers: HeadersInit = JSON_HEADERS) {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel,
  });
  return {
    response: new Response(body, { status, headers }),
    send: (text: string) => streamController.enqueue(encoder.encode(text)),
    end: () => streamController.close(),
    breakConnection: (error: Error) => streamController.error(error),
    cancel,
  };
}

const mockFetch = vi.fn();

function watch<T>(promise: Promise<T>): { settled: () => boolean; outcome: Promise<unknown> } {
  let settled = false;
  const outcome = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  return { settled: () => settled, outcome };
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

describe('[#4034] a body that stops arriving', () => {
  it('control: the fixture really does stall when nothing bounds it', async () => {
    const { response } = feedableResponse();

    const { settled } = watch(response.json());
    await vi.advanceTimersByTimeAsync(API_MUTATION_TIMEOUT_MS * 10);

    expect(settled()).toBe(false);
  });

  it('becomes a timeout ApiError at the deadline, not before', async () => {
    const { response } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const { settled, outcome } = watch(received.json());

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled()).toBe(true);
    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    expect(isTimeoutError(error)).toBe(true);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain(String(API_GET_TIMEOUT_MS));
  });

  it.each([
    ['a poll', { timeoutMs: API_POLL_TIMEOUT_MS, retries: 0 }, API_POLL_TIMEOUT_MS],
    ['a write', { method: 'POST', body: '{}' }, API_MUTATION_TIMEOUT_MS],
    ['a call site with its own budget', { timeoutMs: 1234, retries: 0 }, 1234],
  ])('gives %s the same budget as the wait for its headers', async (_label, options, budget) => {
    mockFetch.mockResolvedValue(feedableResponse().response);

    const received = await fetchApiResponse(URL_UNDER_TEST, options);
    const { settled } = watch(received.json());

    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled()).toBe(true);
  });

  it('aborts the connection underneath when it cuts the body off', async () => {
    const { response, cancel } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const signal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    const { outcome } = watch(received.json());

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts from the last byte, so a stop after some bytes is still caught', async () => {
    const { response, send } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const { settled, outcome } = watch(received.text());

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    send('partial');
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(isTimeoutError(await outcome)).toBe(true);
  });

  it('does not retry from the middle of a body', async () => {
    mockFetch.mockResolvedValue(feedableResponse().response);

    const received = await fetchApiResponse(URL_UNDER_TEST);
    const { outcome } = watch(received.json());
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS);
    await outcome;
    await vi.advanceTimersByTimeAsync(API_MUTATION_TIMEOUT_MS);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the kind on a browser that hands back a TypeError for any errored stream', async () => {
    // WebKit's body readers reduce a stream's error to a TypeError with its
    // message. The phone is the reason this Issue exists, so the kind has to
    // survive that, not only what Node and Chromium do.
    const realJson = Response.prototype.json;
    vi.spyOn(Response.prototype, 'json').mockImplementation(function (this: Response) {
      return realJson.call(this).catch((e: Error) => {
        throw new TypeError(e.message);
      });
    });
    mockFetch.mockResolvedValue(feedableResponse().response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const { outcome } = watch(received.json());
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS);

    expect(isTimeoutError(await outcome)).toBe(true);
  });

  it('reports a connection that broke mid-body as a network ApiError', async () => {
    const { response, breakConnection } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const { outcome } = watch(received.json());
    breakConnection(new TypeError('terminated'));
    await vi.advanceTimersByTimeAsync(0);

    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('network');
    expect((error as ApiError).message).toBe('terminated');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says nothing new to the connection verdict: the server did answer', async () => {
    const reports: boolean[] = [];
    const unsubscribe = subscribeServerReachability((reachable) => reports.push(reachable));
    mockFetch.mockResolvedValue(feedableResponse().response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const { outcome } = watch(received.json());
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS);
    await outcome;
    unsubscribe();

    // Reporting `false` here would flip the banner on and off every poll, since
    // each tick's headers report `true` first.
    expect(reports).toEqual([true]);
  });
});

describe('[#4034] a body that keeps arriving', () => {
  it('reads as before when it finishes inside the deadline', async () => {
    const { response, send, end } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const { outcome } = watch(received.json());
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    send('{"id":"wt-4034"}');
    end();
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toEqual({ id: 'wt-4034' });
    expect(vi.getTimerCount()).toBe(0);
    expect((mockFetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
  });

  it('is not cut off however long the whole transfer takes, while bytes keep coming', async () => {
    const { response, send, end } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    const { settled, outcome } = watch(received.text());

    const pieces = 20;
    for (let i = 0; i < pieces; i++) {
      await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
      expect(settled()).toBe(false);
      send('x');
    }
    end();
    await vi.advanceTimersByTimeAsync(0);

    // Far past what a deadline from the start of the attempt would have allowed.
    await expect(outcome).resolves.toBe('x'.repeat(pieces));
  });

  it('keeps url, redirected, type, status and headers from the real response', async () => {
    const { response } = feedableResponse(200, { 'content-type': 'text/html', 'last-modified': 'then' });
    Object.defineProperty(response, 'url', { value: 'http://localhost/login' });
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'type', { value: 'basic' });
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });

    expect(received.url).toBe('http://localhost/login');
    expect(received.redirected).toBe(true);
    expect(received.type).toBe('basic');
    expect(received.status).toBe(200);
    expect(received.headers.get('last-modified')).toBe('then');
    // The expired-login rule reads those two: losing them would parse the page.
    expect(detectAuthRedirect(received)?.status).toBe(401);
    expect(received.clone().url).toBe('http://localhost/login');
  });
});

describe('[#4034] the shapes that must not change', () => {
  it('leaves a response with no body alone (304): no wrapping, no timer', async () => {
    const notModified = new Response(null, { status: 304, headers: { 'last-modified': 'then' } });
    mockFetch.mockResolvedValue(notModified);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });

    expect(received).toBe(notModified);
    expect(received.status).toBe(304);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a request that opted out of the deadline unbounded in its body too', async () => {
    const { response } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { timeoutMs: API_NO_TIMEOUT, retries: 0 });
    const { settled } = watch(received.json());
    await vi.advanceTimersByTimeAsync(API_MUTATION_TIMEOUT_MS * 10);

    expect(received).toBe(response);
    expect(settled()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind for a caller that never reads the body', async () => {
    const { response } = feedableResponse(401);
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(received.status).toBe(401);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(API_MUTATION_TIMEOUT_MS * 2);
    expect((mockFetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
  });

  it('starts the clock when the read starts, so a late reader is not cut off for being late', async () => {
    const { response, send, end } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { retries: 0 });
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS * 3);
    const { outcome } = watch(received.json());
    send('{"late":true}');
    end();
    await vi.advanceTimersByTimeAsync(0);

    await expect(outcome).resolves.toEqual({ late: true });
  });

  it('passes a stub with no real stream through untouched', async () => {
    const stub = { ok: true, status: 200, headers: new Headers(), json: async () => ({}) };
    mockFetch.mockResolvedValue(stub);

    await expect(fetchApiResponse(URL_UNDER_TEST, { retries: 0 })).resolves.toBe(stub);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases a retried response instead of leaving its body open', async () => {
    const unavailable = feedableResponse(503);
    mockFetch
      .mockResolvedValueOnce(unavailable.response)
      .mockResolvedValueOnce(new Response('{}', { status: 200, headers: JSON_HEADERS }));

    const pending = fetchApiResponse(URL_UNDER_TEST);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(unavailable.cancel).toHaveBeenCalled();
  });
});

describe("[#4034] the caller's own abort during the body", () => {
  it('stays aborted, not timeout, and takes the connection with it', async () => {
    const controller = new AbortController();
    const { response } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { signal: controller.signal, retries: 0 });
    const { outcome } = watch(received.json());
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    const error = await outcome;
    expect(isAbortedError(error)).toBe(true);
    expect(isTimeoutError(error)).toBe(false);
    expect((mockFetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays aborted on an error body too', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValue(feedableResponse(500).response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { signal: controller.signal, retries: 0 });
    const { outcome } = watch(received.json());
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(isAbortedError(await outcome)).toBe(true);
  });

  it('lets go of the caller signal once the body is finished', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const { response, send, end } = feedableResponse();
    mockFetch.mockResolvedValue(response);

    const received = await fetchApiResponse(URL_UNDER_TEST, { signal: controller.signal, retries: 0 });
    const { outcome } = watch(received.json());
    send('{}');
    end();
    await vi.advanceTimersByTimeAsync(0);
    await outcome;

    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    // Too late to mean anything: the body was already delivered.
    controller.abort();
    expect((mockFetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
  });
});

describe('[#4034] fetchApi call sites inherit it', () => {
  it('turns a stalled 200 body into a timeout', async () => {
    mockFetch.mockImplementation(async () => feedableResponse().response);

    const { outcome } = watch(worktreeApi.getById('wt-4034'));
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS);

    expect(isTimeoutError(await outcome)).toBe(true);
  });

  it('keeps the 401 when the error body stalls, so re-login can still branch on it', async () => {
    mockFetch.mockImplementation(async () => feedableResponse(401).response);

    const { settled, outcome } = watch(worktreeApi.getById('wt-4034'));
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).kind).toBe('http');
    expect(mockFetch.mock.calls.at(-1)![1].signal.aborted).toBe(true);
  });

  it('still reads a complete error body', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope' }), { status: 404, headers: JSON_HEADERS }),
    );

    const error = await worktreeApi.getById('wt-4034').catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toBe('nope');
  });
});
