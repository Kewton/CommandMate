/**
 * Issue #4345 1c: the page's remaining requests reach the gateway (`beginHandoffPageRequest` →
 * `reportHandoffPageResponse`) through one owner — the page's registration holder
 * (`@/lib/handoff/page-owner`) — and, for the `api-client` calls that read the body before they
 * throw, through `ApiRequestOptions.onResponse` (`fetchApiResponse`, `worktreeApi.sendMessage`,
 * `worktreeApi.uploadImageFile`).
 *
 * Positive controls (red before 1c: none of these reported anything): a 401, the redirect to /login,
 * a 401 whose body is not JSON or never ends — expired for the registration held when the request
 * left. Negative controls: 403, 409, 500, no response (status 0), an abort, no owner, a registration
 * that is not the current one; a 200 recovers nothing; the call is the same call (the same `fetch`
 * arguments) and the existing error / result is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  beginHandoffPageObserver,
  beginHandoffPageResponseReport,
  fetchForHandoffPage,
  NO_HANDOFF_PAGE_OWNER,
  type HandoffPageOwner,
} from '@/lib/handoff/page-owner';
import {
  beginHandoffPageRequest,
  handoffRegistrySnapshot,
  registerHandoffPage,
  reportHandoffPageAuthenticated,
  reportHandoffPageResponse,
  resetHandoffRegistryForTests,
  unregisterHandoffPage,
} from '@/lib/handoff/page-registration';
import { ApiError, fetchApiResponse, worktreeApi, __resetApiReachabilityReporting } from '@/lib/api-client';

type Shape = number | 'redirect' | 'bad-body' | 'stalled-body' | 'abort';

let shape: Shape;
let stalled: Array<() => void>;
const expired = () => handoffRegistrySnapshot().authExpired;

function respond(): Promise<Response> {
  if (shape === 0) return Promise.reject(new TypeError('Failed to fetch'));
  if (shape === 'abort') return Promise.reject(new DOMException('aborted', 'AbortError'));
  if (shape === 'redirect') {
    const response = new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', { value: 'http://localhost/login?next=%2F' });
    return Promise.resolve(response);
  }
  if (shape === 'bad-body') return Promise.resolve(new Response('<html/>', { status: 401, headers: { 'content-type': 'text/html' } }));
  if (shape === 'stalled-body') {
    const response = new Response('{"error":"x"}', { status: 401, headers: { 'content-type': 'application/json' } });
    const never = () => new Promise<never>((_resolve, reject) => stalled.push(() => reject(new Error('released'))));
    response.json = never;
    response.text = never;
    return Promise.resolve(response);
  }
  const body = shape >= 200 && shape < 300 ? { id: 'm1', timestamp: '2026-11-14T00:00:00.000Z', path: 'p', filename: 'f' } : { error: `e${shape}` };
  return Promise.resolve(new Response(JSON.stringify(body), { status: shape, headers: { 'content-type': 'application/json' } }));
}

beforeEach(() => {
  resetHandoffRegistryForTests();
  __resetApiReachabilityReporting();
  shape = 401;
  stalled = [];
  global.fetch = vi.fn(() => respond()) as unknown as typeof fetch;
});
afterEach(() => {
  for (const release of stalled.splice(0)) release();
  resetHandoffRegistryForTests();
  vi.restoreAllMocks();
});

const holderOf = (registration = registerHandoffPage('wt-a')): HandoffPageOwner => ({ current: registration });
const settled = async (run: () => Promise<unknown>) => {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
};

/** Each way 1c's entries send, for `owner`. */
const ENTRIES: Record<string, (owner: HandoffPageOwner) => Promise<unknown>> = {
  fetchForHandoffPage: (owner) => fetchForHandoffPage(owner, '/api/worktrees/wt-a/current-output?cliTool=claude&instance=claude'),
  fetchApiResponse: (owner) => {
    const report = beginHandoffPageResponseReport(owner);
    return fetchApiResponse('/api/worktrees/wt-a/messages', { retries: 0 }).then((response) => {
      report?.(response);
      return response;
    });
  },
  onResponse: (owner) => fetchApiResponse('/api/worktrees/wt-a/auto-yes', { retries: 0, ...beginHandoffPageObserver(owner) }),
  sendMessage: (owner) => worktreeApi.sendMessage('wt-a', 'hi', { cliToolId: 'claude' }, beginHandoffPageObserver(owner)),
  uploadImageFile: (owner) => worktreeApi.uploadImageFile('wt-a', new File(['x'], 'a.png', { type: 'image/png' }), beginHandoffPageObserver(owner)),
};
const NAMES = Object.keys(ENTRIES);

describe('[#4345 1c] each way of sending reports the 401 for the registration held when it left', () => {
  it.each(NAMES)('%s answers 401: expired', async (name) => {
    await settled(() => ENTRIES[name](holderOf()));
    expect(expired()).toBe(true);
  });

  it.each(NAMES)('%s answers the redirect to /login: expired', async (name) => {
    shape = 'redirect';
    await settled(() => ENTRIES[name](holderOf()));
    expect(expired()).toBe(true);
  });

  it.each(NAMES)('%s answers a 401 whose body is not JSON: expired', async (name) => {
    shape = 'bad-body';
    await settled(() => ENTRIES[name](holderOf()));
    expect(expired()).toBe(true);
  });

  it.each(NAMES)('%s answers a 401 whose body never ends: expired before the body', async (name) => {
    shape = 'stalled-body';
    const pending = settled(() => ENTRIES[name](holderOf()));
    await vi.waitFor(() => expect(expired()).toBe(true));
    for (const release of stalled.splice(0)) release();
    await pending;
  });

  it.each(NAMES)('%s: the registration is the one held when it left, not when it answers', async (name) => {
    const first = registerHandoffPage('wt-a');
    const holder = { current: first as ReturnType<typeof registerHandoffPage> | null };
    let release!: () => void;
    global.fetch = vi.fn(() => new Promise<Response>((resolve) => (release = () => void respond().then(resolve)))) as unknown as typeof fetch;
    const pending = settled(() => ENTRIES[name](holder));
    await vi.waitFor(() => expect(release).toBeDefined());
    // The page is made again: the holder now names a new registration, the current one.
    unregisterHandoffPage(first);
    holder.current = registerHandoffPage('wt-a');
    release();
    await pending;
    expect(expired()).toBe(false);
  });
});

describe('[#4345 1c] (negative controls) nothing else expires or recovers', () => {
  it.each(NAMES.flatMap((name) => [403, 409, 500, 0, 'abort'].map((s) => [name, s] as const)))('%s answering %s leaves the session as it is', async (name, s) => {
    shape = s as Shape;
    await settled(() => ENTRIES[name](holderOf()));
    expect(expired()).toBe(false);
  });

  it.each(NAMES)('%s with no owner reports nothing (and is the same call)', async (name) => {
    const calls: unknown[][] = [];
    global.fetch = vi.fn((...args: unknown[]) => {
      calls.push(args);
      return respond();
    }) as unknown as typeof fetch;
    registerHandoffPage('wt-a');
    await settled(() => ENTRIES[name](NO_HANDOFF_PAGE_OWNER));
    expect(expired()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each(NAMES)('%s owned by a registration that is not the current one expires nothing', async (name) => {
    const old = registerHandoffPage('wt-a');
    registerHandoffPage('wt-a');
    await settled(() => ENTRIES[name]({ current: old }));
    expect(expired()).toBe(false);
  });

  it.each(NAMES)('%s answering 200 recovers nothing (only the detail read does)', async (name) => {
    const holder = holderOf();
    // Expired by another entry's 401 (through the gateway itself).
    reportHandoffPageResponse(beginHandoffPageRequest(holder.current), { status: 401 });
    expect(expired()).toBe(true);
    shape = 200;
    await settled(() => ENTRIES[name](holder));
    expect(expired()).toBe(true);
    reportHandoffPageAuthenticated(beginHandoffPageRequest(holder.current));
    expect(expired()).toBe(false);
  });
});

describe('[#4345 1c] (negative controls) the call and its result are what they were', () => {
  it('fetchForHandoffPage passes fetch the same arguments (no init when none was given)', async () => {
    shape = 200;
    const holder = holderOf();
    await fetchForHandoffPage(holder, '/a');
    await fetchForHandoffPage(holder, '/b', { method: 'POST' });
    expect(vi.mocked(global.fetch).mock.calls).toEqual([['/a'], ['/b', { method: 'POST' }]]);
  });

  it('fetchForHandoffPage returns the response unread', async () => {
    shape = 'bad-body';
    const response = await fetchForHandoffPage(holderOf(), '/a');
    expect(response.bodyUsed).toBe(false);
    expect(response.status).toBe(401);
  });

  it('a rejection rejects as before', async () => {
    shape = 0;
    await expect(fetchForHandoffPage(holderOf(), '/a')).rejects.toThrow('Failed to fetch');
  });

  it('fetch is not handed onResponse', async () => {
    shape = 200;
    await fetchApiResponse('/x', { retries: 0, onResponse: () => undefined });
    const init = vi.mocked(global.fetch).mock.calls[0][1] as Record<string, unknown>;
    expect(init).not.toHaveProperty('onResponse');
  });

  it('onResponse is not called for a response retried, only for the one returned', async () => {
    let n = 0;
    global.fetch = vi.fn(() => {
      n += 1;
      return Promise.resolve(new Response('{}', { status: n === 1 ? 503 : 401, headers: { 'content-type': 'application/json' } }));
    }) as unknown as typeof fetch;
    const seen: number[] = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const response = await fetchApiResponse('/x', { retries: 1, onResponse: (r) => seen.push(r.status) });
      expect(response.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    expect(seen).toEqual([401]);
  });

  it('sendMessage throws the same ApiError (401, its message) and resolves the same row', async () => {
    const error = (await settled(() => worktreeApi.sendMessage('wt-a', 'hi', { cliToolId: 'claude' }, beginHandoffPageObserver(holderOf())))).error;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('e401');
    resetHandoffRegistryForTests();
    shape = 201;
    const row = await worktreeApi.sendMessage('wt-a', 'hi', { cliToolId: 'claude' }, beginHandoffPageObserver(holderOf()));
    expect(row.id).toBe('m1');
    expect(row.timestamp).toBeInstanceOf(Date);
    expect(expired()).toBe(false);
  });

  it('uploadImageFile throws the same Error on a 401', async () => {
    shape = 401;
    const error = (await settled(() => worktreeApi.uploadImageFile('wt-a', new File(['x'], 'a.png'), beginHandoffPageObserver(holderOf())))).error;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Upload failed (HTTP 401)');
  });
});
