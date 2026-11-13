/**
 * Issue #4345 1c 再指示 2 (K1): the gate in the gateway itself (`@/lib/handoff/page-registration`
 * `assertHandoffPageRequestMayLeave`, through `@/lib/handoff/page-owner`, the `api-client`'s
 * `beforeFetch` and `@/lib/handoff/screen-client`).
 *
 * Invariant: a page's request that starts something new is fetched only while the registration of
 * its operation may start (`handoffPageMayStart`); otherwise `fetch` is called 0 times and the caller
 * gets "not sent" (`HandoffPageOperationRefusedError`, no status, not an `ApiError`). A record of what
 * was sent leaves — while expired too — only with the capability an allowed operation handed over.
 * Reads are never stopped.
 *
 * The rows of the enabler's table (enabler-return-4345-1c-cause.md §3) this file holds:
 * T1 (no expiry: the operation leaves), T2 (after a 401 taken: fetch 0, "not sent"), T5 (a record
 * with the capability leaves while expired), T6 (a record without one — the same URL, a method that
 * "looks like a record" — fetch 0), T7 (reads, MARP's POST included, leave while expired), T8 (pressed,
 * then the page made again: the press's registration decides — fetch 0), T9 (outside a page: as
 * before), and the api-client's retry (the gate before each attempt).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  beginHandoffPageOperationFor,
  beginHandoffPageRequest,
  handoffRegistrySnapshot,
  HandoffPageOperationRefusedError,
  isHandoffPageOperationRefused,
  registerHandoffPage,
  reportHandoffPageResponse,
  resetHandoffRegistryForTests,
  unregisterHandoffPage,
  type HandoffPageRegistration,
} from '@/lib/handoff/page-registration';
import {
  beginHandoffPageObserver,
  beginHandoffPageOperation,
  fetchForHandoffPage,
  handoffPageOperationOptions,
  NO_HANDOFF_PAGE_OWNER,
  sendMessageForHandoffPage,
  type HandoffPageOwner,
} from '@/lib/handoff/page-owner';
import { ApiError, fetchApiResponse, __resetApiReachabilityReporting } from '@/lib/api-client';

const { handoffApi } = await vi.importActual<typeof import('@/lib/handoff/screen-client')>('@/lib/handoff/screen-client');

let fetchMock: ReturnType<typeof vi.fn>;
let page: HandoffPageRegistration;
let owner: HandoffPageOwner;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const expire = (registration: HandoffPageRegistration = page) => reportHandoffPageResponse(beginHandoffPageRequest(registration), { status: 401 });
const settled = async (run: () => Promise<unknown>) => {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
};

beforeEach(() => {
  resetHandoffRegistryForTests();
  __resetApiReachabilityReporting();
  page = registerHandoffPage('wt-a');
  owner = { current: page };
  fetchMock = vi.fn(async () => json(200, { ok: true, id: 'm1', timestamp: '2026-11-14T00:00:00.000Z' }));
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  resetHandoffRegistryForTests();
  vi.restoreAllMocks();
});

/** Each way a page sends an operation (the gateway's four mouths). */
const OPERATIONS: Record<string, (o: HandoffPageOwner) => Promise<unknown>> = {
  'fetchForHandoffPage (POST)': (o) => fetchForHandoffPage(o, '/api/worktrees/wt-a/interrupt', { method: 'POST' }),
  'fetchForHandoffPage (DELETE)': (o) => fetchForHandoffPage(o, '/api/worktrees/wt-a/files/a.md', { method: 'DELETE' }),
  'api-client (sendMessage)': (o) => sendMessageForHandoffPage(o, 'wt-a', 'hi', { cliToolId: 'claude' }),
  'api-client (fetchApiResponse + beforeFetch)': (o) =>
    fetchApiResponse('/api/worktrees/wt-a/kill-session', { method: 'POST', ...beginHandoffPageObserver(o) }),
  'screen-client (decide)': (o) => handoffApi.decide('wt-a', 'r1', { ifVersion: 1, decisions: [] }, o.current),
  'screen-client (sendText)': (o) => handoffApi.sendText('wt-a', 'text', { cliToolId: 'claude', instanceId: 'claude' }, o.current),
};
const NAMES = Object.keys(OPERATIONS);
const refusedOf = (outcome: { value?: unknown; error?: unknown }) =>
  isHandoffPageOperationRefused(outcome.error) || (outcome.value as { refused?: unknown } | undefined)?.refused instanceof HandoffPageOperationRefusedError;

describe('[#4345 1c 再指示 2] T1・T2: an operation leaves only while the page may start', () => {
  it.each(NAMES)('T1 %s, no expiry: fetched once', async (name) => {
    await settled(() => OPERATIONS[name](owner));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(NAMES)('T2 %s after a 401 taken: fetch 0, "not sent"', async (name) => {
    expire();
    const outcome = await settled(() => OPERATIONS[name](owner));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refusedOf(outcome)).toBe(true);
  });

  it.each(NAMES)('T2 %s with no registration held in the page: fetch 0', async (name) => {
    const outcome = await settled(() => OPERATIONS[name]({ current: null }));
    // screen-client takes the registration itself: `null` is a page without one.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refusedOf(outcome)).toBe(true);
  });

  it('"not sent" carries no status and is not an ApiError (passed through fetchApi untouched)', async () => {
    expire();
    const { error } = await settled(() => sendMessageForHandoffPage(owner, 'wt-a', 'hi', { cliToolId: 'claude' }));
    expect(error).toBeInstanceOf(HandoffPageOperationRefusedError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as { status?: unknown }).status).toBeUndefined();
  });

  it('the api-client checks before each attempt of a retry (a GET named an operation: only those retry)', async () => {
    let attempts = 0;
    global.fetch = vi.fn(async () => {
      attempts += 1;
      // The first attempt answers 503 (retried); the 401 of another entry is taken in between.
      if (attempts === 1) {
        expire();
        return json(503, {});
      }
      return json(200, {});
    }) as unknown as typeof fetch;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const outcome = await settled(() => fetchApiResponse('/x', { retries: 2, ...beginHandoffPageObserver(owner, { kind: 'operation' }) }));
      expect(isHandoffPageOperationRefused(outcome.error)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(attempts).toBe(1);
  });
});

describe('[#4345 1c 再指示 2] T5・T6: records', () => {
  it('T5 the records of an allowed send (sent / send-failed) and of an allowed end (observe) leave while expired', async () => {
    const operation = beginHandoffPageOperationFor(page);
    await handoffApi.sendText('wt-a', 'text', { cliToolId: 'claude', instanceId: 'claude' }, operation);
    const end = beginHandoffPageOperationFor(page);
    await handoffApi.end('wt-a', 'r1', { ifVersion: 1 }, end);
    expire();
    fetchMock.mockClear();
    const results = [
      await handoffApi.sent('wt-a', 'r1', operation.record()),
      await handoffApi.sendFailed('wt-a', 'r1', operation.record()),
      await handoffApi.observe('wt-a', 'r1', 'tok', end.record()),
    ];
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(results.every((result) => !result.refused)).toBe(true);
  });

  it('T5 a record still reports its 401 under the registration of its operation', async () => {
    const operation = beginHandoffPageOperationFor(page);
    await handoffApi.sendText('wt-a', 'text', { cliToolId: 'claude', instanceId: 'claude' }, operation);
    fetchMock.mockImplementationOnce(async () => json(401, {}));
    await handoffApi.sent('wt-a', 'r1', operation.record());
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
  });

  it('T6 a record without the capability — the registration itself, an operation never allowed — is gated: fetch 0', async () => {
    const refusedAtPress = beginHandoffPageOperationFor(page);
    expire();
    const notAllowed = await handoffApi.sendText('wt-a', 'text', { cliToolId: 'claude', instanceId: 'claude' }, refusedAtPress);
    expect(notAllowed.refused).toBeInstanceOf(HandoffPageOperationRefusedError);
    expect(refusedAtPress.record()).toBeNull();
    const byRegistration = await handoffApi.sent('wt-a', 'r1', page);
    const byNull = await handoffApi.observe('wt-a', 'r1', 'tok', refusedAtPress.record());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(byRegistration.refused).toBeInstanceOf(HandoffPageOperationRefusedError);
    expect(byNull.refused).toBeInstanceOf(HandoffPageOperationRefusedError);
  });

  it('T6 "record" named on the same URL by method alone does not pass (the page-owner mouth)', async () => {
    expire();
    const outcome = await settled(() =>
      fetchForHandoffPage(owner, '/api/worktrees/wt-a/mem/handoff/requests/r1/sent', { method: 'POST' }, { kind: 'record' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isHandoffPageOperationRefused(outcome.error)).toBe(true);
  });
});

describe('[#4345 1c 再指示 2] T7・T8・T9', () => {
  it('T7 reads leave while expired: GET, MARP’s POST named read, the dialog’s read', async () => {
    expire();
    await fetchForHandoffPage(owner, '/api/worktrees/wt-a/messages');
    await fetchForHandoffPage(owner, '/api/worktrees/wt-a/marp-render', { method: 'POST' }, { kind: 'read' });
    await handoffApi.read('wt-a', 'r1', page);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('T8 pressed, then the page made again: the press’s registration decides — fetch 0', async () => {
    const operation = beginHandoffPageOperation(owner);
    // The page is made again: the holder now names a new, current registration.
    unregisterHandoffPage(page);
    owner = { current: registerHandoffPage('wt-a') };
    const outcome = await settled(() => fetchForHandoffPage(owner, '/api/worktrees/wt-a/interrupt', { method: 'POST' }, handoffPageOperationOptions(operation)));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isHandoffPageOperationRefused(outcome.error)).toBe(true);
  });

  it('T8 (negative control) with no press the registration held as it leaves decides: fetched', async () => {
    unregisterHandoffPage(page);
    owner = { current: registerHandoffPage('wt-a') };
    await fetchForHandoffPage(owner, '/api/worktrees/wt-a/interrupt', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(NAMES.filter((name) => !name.startsWith('screen-client')))('T9 %s outside a page: fetched as before, even while a page is expired', async (name) => {
    expire();
    await settled(() => OPERATIONS[name](NO_HANDOFF_PAGE_OWNER));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T9 the dialog drawn without a page (no registration given): fetched as before', async () => {
    expire();
    await handoffApi.decide('wt-a', 'r1', { ifVersion: 1, decisions: [] }, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
