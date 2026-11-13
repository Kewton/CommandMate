/**
 * Issue #4345 1b: `@/lib/handoff/screen-client` reports each request's answer through the gateway
 * of `@/lib/handoff/page-registration` for the registration it is handed (`owner`), before the body
 * is read and before the status is folded into a result or `null` (start-preview).
 *
 * Positive controls (red before 1b: nothing here reported): every `handoffApi` call and
 * `fetchStartPreview` answering 401 — or the redirect to /login, or a 401 whose body is not JSON or
 * never ends — expires the session for its owner (the registry's own state, read back).
 * Negative controls: 403, 409, 500, no response (status 0), an abort, no owner, an owner that is
 * not the current registration, and a 200 of these entries (no recovery: only the detail read
 * recovers) leave the session as it is; the results are what they were.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handoffApi, type HandoffRequestOwner } from '@/lib/handoff/screen-client';
import {
  handoffRegistrySnapshot,
  registerHandoffPage,
  reportHandoffPageAuth,
  resetHandoffRegistryForTests,
  type HandoffPageRegistration,
} from '@/lib/handoff/page-registration';

// `tests/setup.ts` replaces `fetchStartPreview` for the composer's tests; the real one is taken here.
const { fetchStartPreview } = await vi.importActual<typeof import('@/lib/handoff/screen-client')>('@/lib/handoff/screen-client');

type Shape = number | 'redirect' | 'bad-body' | 'stalled-body' | 'abort';

let shape: Shape;
let stalled: Array<() => void>;

function respond(): Promise<Response> {
  if (shape === 0) return Promise.reject(new TypeError('Failed to fetch'));
  if (shape === 'abort') return Promise.reject(new DOMException('aborted', 'AbortError'));
  if (shape === 'redirect') {
    const response = new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', { value: 'http://localhost/login' });
    return Promise.resolve(response);
  }
  if (shape === 'bad-body') return Promise.resolve(new Response('<html/>', { status: 401, headers: { 'content-type': 'text/html' } }));
  if (shape === 'stalled-body') {
    const response = new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    response.json = () => new Promise((resolve) => stalled.push(() => resolve({})));
    return Promise.resolve(response);
  }
  const body = shape === 200 ? { ok: true, show: false, attended: false } : { ok: false, code: 'x' };
  return Promise.resolve(new Response(JSON.stringify(body), { status: shape, headers: { 'content-type': 'application/json' } }));
}

beforeEach(() => {
  resetHandoffRegistryForTests();
  shape = 401;
  stalled = [];
  global.fetch = vi.fn(() => respond()) as unknown as typeof fetch;
});
afterEach(() => {
  for (const release of stalled.splice(0)) release();
  resetHandoffRegistryForTests();
  vi.restoreAllMocks();
});

/** Every entry of this PR, called for `owner`. */
const ENTRIES: Record<string, (owner: HandoffRequestOwner) => Promise<unknown>> = {
  create: (owner) => handoffApi.create('wt-a', 'claude', owner),
  read: (owner) => handoffApi.read('wt-a', 'r1', owner),
  sendText: (owner) => handoffApi.sendText('wt-a', 'text', { cliToolId: 'claude', instanceId: 'claude' }, owner),
  sent: (owner) => handoffApi.sent('wt-a', 'r1', owner),
  sendFailed: (owner) => handoffApi.sendFailed('wt-a', 'r1', owner),
  decide: (owner) => handoffApi.decide('wt-a', 'r1', { ifVersion: 1, decisions: [] }, owner),
  extend: (owner) => handoffApi.extend('wt-a', 'r1', 1, owner),
  rebase: (owner) => handoffApi.rebase('wt-a', 'r1', 'p1', { ifVersion: 1, fingerprint: 'fp' }, owner),
  cancel: (owner) => handoffApi.cancel('wt-a', 'r1', owner),
  end: (owner) => handoffApi.end('wt-a', 'r1', { ifVersion: 1 }, owner),
  observe: (owner) => handoffApi.observe('wt-a', 'r1', 'tok', owner),
  startPreview: (owner) => fetchStartPreview('wt-a', 'claude', owner),
};
const NAMES = Object.keys(ENTRIES);

describe('[#4345 1b] each entry’s 401 reaches the registry for its owner', () => {
  it.each(NAMES)('%s answers 401: expired', async (name) => {
    const owner = registerHandoffPage('wt-a');
    const result = await ENTRIES[name](owner);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    if (name === 'startPreview') expect(result).toBeNull();
    else expect(result).toMatchObject({ ok: false, status: 401, expired: true });
  });

  it.each(NAMES)('%s answers the redirect to /login: expired, never a success', async (name) => {
    shape = 'redirect';
    const owner = registerHandoffPage('wt-a');
    const result = await ENTRIES[name](owner);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    if (name === 'startPreview') expect(result).toBeNull();
    else expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it.each(NAMES)('%s answers 401 with a body that is not JSON: expired', async (name) => {
    shape = 'bad-body';
    const owner = registerHandoffPage('wt-a');
    await ENTRIES[name](owner);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
  });

  it.each(NAMES.filter((name) => name !== 'startPreview'))('%s answers 401 and its body never ends: expired before the body is read', async (name) => {
    shape = 'stalled-body';
    const owner = registerHandoffPage('wt-a');
    const pending = ENTRIES[name](owner);
    await vi.waitFor(() => expect(stalled).toHaveLength(1));
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    stalled.splice(0).forEach((release) => release());
    await pending;
  });
});

describe('[#4345 1b] negative controls: not the expiry, or not this registration’s', () => {
  it.each(NAMES.flatMap((name) => [403, 409, 500, 0, 'abort'].map((status) => [name, status] as const)))('%s answers %s: not expired', async (name, status) => {
    shape = status as Shape;
    const owner = registerHandoffPage('wt-a');
    await ENTRIES[name](owner);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });

  it.each(NAMES)('%s answers 401 with no owner (undefined / null): nothing reported', async (name) => {
    registerHandoffPage('wt-a');
    await ENTRIES[name](undefined);
    await ENTRIES[name](null);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });

  it.each(NAMES)('%s answers 401 for an owner that is not the current registration: the current one is not expired', async (name) => {
    const old: HandoffPageRegistration = registerHandoffPage('wt-a');
    registerHandoffPage('wt-a');
    await ENTRIES[name](old);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });

  it.each(NAMES)('%s answers 200 while expired: no recovery (only the detail read recovers)', async (name) => {
    const owner = registerHandoffPage('wt-a');
    reportHandoffPageAuth(owner, 'expired', Number.MAX_SAFE_INTEGER - 1);
    shape = 200;
    await ENTRIES[name](owner);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
  });

  it('the redirect for an owner not current: not expired, still not a success', async () => {
    shape = 'redirect';
    const old = registerHandoffPage('wt-a');
    registerHandoffPage('wt-a');
    const result = await handoffApi.read('wt-a', 'r1', old);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result).not.toHaveProperty('expired', true);
  });
});
