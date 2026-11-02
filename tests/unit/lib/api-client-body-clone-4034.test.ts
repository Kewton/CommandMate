/**
 * `Response.clone()` keeps the promise of the body deadline (Issue #4034).
 *
 * The clock runs only while someone waits on a read, so an unread body is never
 * cut off. A native clone tees the stream, and the tee reads ahead on its own,
 * which started the clock on a body nobody had asked for.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  fetchApiResponse,
  isAbortedError,
  isTimeoutError,
  __resetApiReachabilityReporting,
} from '@/lib/api-client';
import { API_GET_TIMEOUT_MS } from '@/config/api-timeout-config';

const URL_UNDER_TEST = '/api/worktrees/wt-4034';
const encoder = new TextEncoder();
const mockFetch = vi.fn();

function feedableResponse() {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel,
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    send: (text: string) => streamController.enqueue(encoder.encode(text)),
    end: () => streamController.close(),
    cancel,
  };
}

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

function connectionSignal(): AbortSignal {
  return mockFetch.mock.calls[0][1].signal as AbortSignal;
}

async function fetched(fixture: ReturnType<typeof feedableResponse>, init: RequestInit = {}): Promise<Response> {
  mockFetch.mockResolvedValue(fixture.response);
  return fetchApiResponse(URL_UNDER_TEST, { ...init, retries: 0 });
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

describe('[#4034] a clone nobody reads', () => {
  it('starts no clock and leaves the connection alone', async () => {
    const received = await fetched(feedableResponse());

    const copy = received.clone();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS * 3);
    expect(connectionSignal().aborted).toBe(false);
    expect(received.bodyUsed).toBe(false);
    expect(copy.bodyUsed).toBe(false);
  });

  it('can still be read late, both sides, without being punished for it', async () => {
    const fixture = feedableResponse();
    const received = await fetched(fixture);
    const copy = received.clone();
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS * 3);

    const original = watch(received.json());
    const cloned = watch(copy.json());
    fixture.send('{"late":true}');
    fixture.end();
    await vi.advanceTimersByTimeAsync(0);

    await expect(original.outcome).resolves.toEqual({ late: true });
    await expect(cloned.outcome).resolves.toEqual({ late: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('[#4034] reading both sides of a clone', () => {
  it('turns a stall into a timeout on both, at the deadline, and aborts once', async () => {
    const fixture = feedableResponse();
    const received = await fetched(fixture);
    const copy = received.clone();

    const original = watch(received.json());
    const cloned = watch(copy.text());
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    expect(original.settled()).toBe(false);
    expect(cloned.settled()).toBe(false);
    expect(connectionSignal().aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const errors = [await original.outcome, await cloned.outcome];
    for (const error of errors) {
      expect(error).toBeInstanceOf(ApiError);
      expect(isTimeoutError(error)).toBe(true);
    }
    expect(connectionSignal().aborted).toBe(true);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not cut either off while bytes keep coming', async () => {
    const fixture = feedableResponse();
    const received = await fetched(fixture);
    const copy = received.clone();

    const original = watch(received.text());
    const cloned = watch(copy.text());
    const pieces = 10;
    for (let i = 0; i < pieces; i++) {
      await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
      fixture.send('x');
    }
    fixture.end();
    await vi.advanceTimersByTimeAsync(0);

    await expect(original.outcome).resolves.toBe('x'.repeat(pieces));
    await expect(cloned.outcome).resolves.toBe('x'.repeat(pieces));
  });

  it('gives a side that reads later everything the first side already took', async () => {
    const fixture = feedableResponse();
    const received = await fetched(fixture);
    const copy = received.clone();

    const original = watch(received.text());
    fixture.send('first,');
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS - 1);
    fixture.send('second');
    fixture.end();
    await expect(original.outcome).resolves.toBe('first,second');

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS * 3);
    await expect(copy.text()).resolves.toBe('first,second');
    expect(connectionSignal().aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies to a clone of a clone, including what is buffered for the side it copies', async () => {
    const fixture = feedableResponse();
    const received = await fetched(fixture);
    const copy = received.clone();

    const original = watch(received.text());
    fixture.send('buffered,');
    await vi.advanceTimersByTimeAsync(0);
    const second = copy.clone();
    fixture.send('rest');
    fixture.end();
    await expect(original.outcome).resolves.toBe('buffered,rest');

    await expect(copy.text()).resolves.toBe('buffered,rest');
    await expect(second.text()).resolves.toBe('buffered,rest');
  });
});

describe('[#4034] the edges of a clone', () => {
  it('refuses to clone a body already being read, as the platform does', async () => {
    const received = await fetched(feedableResponse());
    const reading = watch(received.text());

    expect(() => received.clone()).toThrow(TypeError);

    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS);
    await reading.outcome;
  });

  it('stops the clock when the only side waiting gives up, while the other stays unread', async () => {
    const fixture = feedableResponse();
    const received = await fetched(fixture);
    const copy = received.clone();

    const reader = received.body!.getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);

    await reader.cancel();
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(API_GET_TIMEOUT_MS * 3);
    expect(connectionSignal().aborted).toBe(false);
    expect(fixture.cancel).not.toHaveBeenCalled();

    // The copy is still whole, and restarts the clock when it is read.
    const late = watch(copy.text());
    fixture.send('whole');
    fixture.end();
    await vi.advanceTimersByTimeAsync(0);
    await expect(late.outcome).resolves.toBe('whole');
  });

  it('closes the source only once both sides have let go', async () => {
    const fixture = feedableResponse();
    const received = await fetched(fixture);
    const copy = received.clone();

    await received.body!.cancel();
    expect(fixture.cancel).not.toHaveBeenCalled();
    await copy.body!.cancel();
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends both sides as aborted on the caller's abort, read or not", async () => {
    const controller = new AbortController();
    const received = await fetched(feedableResponse(), { signal: controller.signal });
    const copy = received.clone();

    const reading = watch(received.json());
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(isAbortedError(await reading.outcome)).toBe(true);
    expect(isAbortedError(await copy.json().catch((e: unknown) => e))).toBe(true);
    expect(connectionSignal().aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the status and headers on the copy', async () => {
    const copy = (await fetched(feedableResponse())).clone();

    expect(copy.status).toBe(200);
    expect(copy.headers.get('content-type')).toBe('application/json');
  });
});
