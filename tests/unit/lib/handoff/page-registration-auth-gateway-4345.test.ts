/**
 * Issue #4345 1a: the one gateway of a page's requests to the session's expiry
 * (`@/lib/handoff/page-registration` invariant 7).
 *
 * The owner and the order are fixed when a request leaves (`beginHandoffPageRequest`): one count per
 * registration across every entry. A 401 (or the redirect to /login) is the expiry; a 403, a 409, a
 * 5xx are nothing; the recovery is the detail read's reported success only. Taking a report is apart
 * from `handoffPageMayStart` (a read that left while expired or off the route still counts).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginHandoffPageRequest,
  handoffPageMayStart,
  handoffRegistrySnapshot,
  isHandoffAuthExpiry,
  registerHandoffPage,
  reportHandoffPageAuthenticated,
  reportHandoffPageResponse,
  reportHandoffRoute,
  resetHandoffRegistryForTests,
  unregisterHandoffPage,
} from '@/lib/handoff/page-registration';

const expired = () => handoffRegistrySnapshot().authExpired;
const res = (status: number, extra: Partial<Response> = {}) => ({ status, ...extra });

beforeEach(() => resetHandoffRegistryForTests());

describe('[#4345 1a] the gateway', () => {
  it('numbers the requests of one registration in one order across entries', () => {
    const id = registerHandoffPage('wt-a');
    expect([beginHandoffPageRequest(id).seq, beginHandoffPageRequest(id).seq, beginHandoffPageRequest(id).seq]).toEqual([1, 2, 3]);
    const other = registerHandoffPage('wt-a');
    expect(beginHandoffPageRequest(other).seq).toBe(1);
  });

  it('a 401, and a redirect to /login, expire the session; the answer says so', () => {
    const id = registerHandoffPage('wt-a');
    expect(reportHandoffPageResponse(beginHandoffPageRequest(id), res(401))).toBe(true);
    expect(expired()).toBe(true);
    reportHandoffPageAuthenticated(beginHandoffPageRequest(id));
    expect(expired()).toBe(false);
    expect(reportHandoffPageResponse(beginHandoffPageRequest(id), res(200, { redirected: true, url: 'http://x/login?next=/' }))).toBe(true);
    expect(expired()).toBe(true);
  });

  it.each([200, 204, 304, 403, 409, 500, 503])('(negative control) %s expires nothing and recovers nothing', (status) => {
    const id = registerHandoffPage('wt-a');
    expect(reportHandoffPageResponse(beginHandoffPageRequest(id), res(status))).toBe(false);
    expect(expired()).toBe(false);
    reportHandoffPageResponse(beginHandoffPageRequest(id), res(401));
    expect(reportHandoffPageResponse(beginHandoffPageRequest(id), res(status))).toBe(false);
    expect(expired()).toBe(true);
  });

  it('(negative control) a redirect elsewhere is not the expiry', () => {
    expect(isHandoffAuthExpiry(res(200, { redirected: true, url: 'http://x/worktrees/a' }))).toBe(false);
  });

  it('reads nothing of the body', async () => {
    const id = registerHandoffPage('wt-a');
    const response = new Response('not json', { status: 401 });
    reportHandoffPageResponse(beginHandoffPageRequest(id), response);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('not json');
  });

  it('① 200 held, ② 401, ① released: still expired; the reverse: still authenticated', () => {
    const id = registerHandoffPage('wt-a');
    const one = beginHandoffPageRequest(id);
    const two = beginHandoffPageRequest(id);
    reportHandoffPageResponse(two, res(401));
    reportHandoffPageAuthenticated(one);
    expect(expired()).toBe(true);
    const three = beginHandoffPageRequest(id);
    const four = beginHandoffPageRequest(id);
    reportHandoffPageAuthenticated(four);
    reportHandoffPageResponse(three, res(401));
    expect(expired()).toBe(false);
  });

  it('再指示 1: the answer is whether the expiry was taken — a 401 older than an answer taken says false', () => {
    const id = registerHandoffPage('wt-a');
    const older = beginHandoffPageRequest(id);
    reportHandoffPageAuthenticated(beginHandoffPageRequest(id));
    expect(reportHandoffPageResponse(older, res(401))).toBe(false);
    expect(expired()).toBe(false);
    expect(reportHandoffPageResponse(beginHandoffPageRequest(id), res(401))).toBe(true);
    expect(expired()).toBe(true);
  });

  it('an older registration’s 401 and a request with no owner expire nothing of the current one', () => {
    const old = registerHandoffPage('wt-a');
    const oldRequest = beginHandoffPageRequest(old);
    unregisterHandoffPage(old);
    registerHandoffPage('wt-a');
    expect(reportHandoffPageResponse(oldRequest, res(401))).toBe(false);
    expect(expired()).toBe(false);
    expect(reportHandoffPageResponse(beginHandoffPageRequest(null), res(401))).toBe(false);
    expect(expired()).toBe(false);
  });

  it('is not gated by handoffPageMayStart: a read that left while expired recovers, a 401 off the route expires', () => {
    const id = registerHandoffPage('wt-a');
    reportHandoffPageResponse(beginHandoffPageRequest(id), res(401));
    expect(handoffPageMayStart(id)).toBe(false);
    reportHandoffPageAuthenticated(beginHandoffPageRequest(id));
    expect(expired()).toBe(false);
    reportHandoffRoute('wt-b');
    expect(handoffPageMayStart(id)).toBe(false);
    reportHandoffPageResponse(beginHandoffPageRequest(id), res(401));
    expect(expired()).toBe(true);
  });
});
