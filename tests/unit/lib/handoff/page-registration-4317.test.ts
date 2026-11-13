/**
 * The pages' registrations for the hand-off dialog (Issue #4317 PR1, `@/lib/handoff/page-registration`).
 *
 * Invariants: a cleanup removes its own registration only; a registration removed is never live
 * again; the current one is the newest live one (none in a gap); the expiry is set and cleared by
 * the current registration only, and a registration's start or cleanup leaves it as it is.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  handoffPageCurrentFor,
  handoffPageMayStart,
  handoffRegistrySnapshot,
  isCurrentHandoffRegistration,
  reportHandoffRoute,
  registerHandoffPage,
  reportHandoffPageAuth,
  resetHandoffRegistryForTests,
  subscribeHandoffRegistry,
  unregisterHandoffPage,
} from '@/lib/handoff/page-registration';

beforeEach(() => resetHandoffRegistryForTests());

describe('[#4317 PR1] registrations', () => {
  it('the late cleanup of the page left (B) does not remove the page come to (A)', () => {
    const b = registerHandoffPage('wt-b');
    const a = registerHandoffPage('wt-a');
    unregisterHandoffPage(b);
    expect(isCurrentHandoffRegistration(a)).toBe(true);
    expect(handoffPageCurrentFor('wt-a')).toBe(true);
  });

  it('(negative control) the page’s own cleanup removes it: a gap, nothing is current', () => {
    const a = registerHandoffPage('wt-a');
    unregisterHandoffPage(a);
    expect(isCurrentHandoffRegistration(a)).toBe(false);
    expect(handoffPageCurrentFor('wt-a')).toBe(false);
  });

  it('StrictMode’s setup → cleanup → setup: two identities, the first never current again', () => {
    const first = registerHandoffPage('wt-a');
    unregisterHandoffPage(first);
    const second = registerHandoffPage('wt-a');
    unregisterHandoffPage(first);
    expect(second).not.toBe(first);
    expect(isCurrentHandoffRegistration(first)).toBe(false);
    expect(isCurrentHandoffRegistration(second)).toBe(true);
  });

  it('an overlap: the older is not current while the newer lives; current again once the newer goes', () => {
    const older = registerHandoffPage('wt-a');
    const newer = registerHandoffPage('wt-b');
    expect(isCurrentHandoffRegistration(older)).toBe(false);
    expect(handoffPageCurrentFor('wt-a')).toBe(false);
    unregisterHandoffPage(newer);
    expect(isCurrentHandoffRegistration(older)).toBe(true);
  });

  it('null (a page not registered yet) is never current', () => {
    registerHandoffPage('wt-a');
    expect(isCurrentHandoffRegistration(null)).toBe(false);
  });

  it('subscribers hear each change', () => {
    let heard = 0;
    const off = subscribeHandoffRegistry(() => heard++);
    const a = registerHandoffPage('wt-a');
    unregisterHandoffPage(a);
    unregisterHandoffPage(a);
    off();
    expect(heard).toBe(2);
  });
});

describe('[#4317 PR1] the expiry over the pages', () => {
  it('set by the current page’s 401; a new registration and the old one’s cleanup leave it set', () => {
    const old = registerHandoffPage('wt-a');
    reportHandoffPageAuth(old, 'expired', 1);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    unregisterHandoffPage(old);
    registerHandoffPage('wt-a');
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
  });

  it('an old page’s success does not recover; the current page’s authenticated read does', () => {
    const old = registerHandoffPage('wt-a');
    reportHandoffPageAuth(old, 'expired', 1);
    unregisterHandoffPage(old);
    const current = registerHandoffPage('wt-a');
    reportHandoffPageAuth(old, 'authenticated', 2);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    reportHandoffPageAuth(null, 'authenticated', 3);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    reportHandoffPageAuth(current, 'authenticated', 4);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });

  it('an old page’s 401 does not expire the current page', () => {
    const old = registerHandoffPage('wt-a');
    registerHandoffPage('wt-b');
    reportHandoffPageAuth(old, 'expired', 1);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });
});

describe('[#4317 PR1 再指示 2] the order of the answers within one registration', () => {
  it('② answers 401, then the older ① answers 200: still expired', () => {
    const a = registerHandoffPage('wt-a');
    reportHandoffPageAuth(a, 'expired', 2);
    reportHandoffPageAuth(a, 'authenticated', 1);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
  });

  it('② answers 200, then the older ① answers 401: still authenticated', () => {
    const a = registerHandoffPage('wt-a');
    reportHandoffPageAuth(a, 'expired', 1);
    reportHandoffPageAuth(a, 'authenticated', 3);
    reportHandoffPageAuth(a, 'expired', 2);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });

  it('(negative control) a newer read moves it either way', () => {
    const a = registerHandoffPage('wt-a');
    reportHandoffPageAuth(a, 'expired', 1);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    reportHandoffPageAuth(a, 'authenticated', 2);
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    reportHandoffPageAuth(a, 'expired', 3);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
  });

  it('a report that changes nothing is not heard (no drawing again on each poll)', () => {
    const a = registerHandoffPage('wt-a');
    let heard = 0;
    const off = subscribeHandoffRegistry(() => heard++);
    reportHandoffPageAuth(a, 'authenticated', 1);
    reportHandoffPageAuth(a, 'authenticated', 2);
    off();
    expect(heard).toBe(0);
  });
});

describe('[#4317 PR1 再指示 2] one condition starts anything new', () => {
  it('the current registration with the session expired may start nothing; once recovered it may', () => {
    const a = registerHandoffPage('wt-a');
    expect(handoffPageMayStart(a)).toBe(true);
    reportHandoffPageAuth(a, 'expired', 1);
    expect(handoffPageMayStart(a)).toBe(false);
    reportHandoffPageAuth(a, 'authenticated', 2);
    expect(handoffPageMayStart(a)).toBe(true);
  });

  it('a registration not current may start nothing, authenticated or not', () => {
    const a = registerHandoffPage('wt-a');
    registerHandoffPage('wt-a');
    expect(handoffPageMayStart(a)).toBe(false);
    expect(handoffPageMayStart(null)).toBe(false);
  });
});

describe('[#4317 PR2 再指示 1] the route takes part in the one condition', () => {
  it('once the host reported a route, the current registration may start only while it is the route’s', () => {
    const b = registerHandoffPage('wt-b');
    expect(handoffPageMayStart(b)).toBe(true);
    reportHandoffRoute('wt-b');
    expect(handoffPageMayStart(b)).toBe(true);
    reportHandoffRoute('wt-a');
    expect(handoffPageMayStart(b)).toBe(false);
    reportHandoffRoute(null);
    expect(handoffPageMayStart(b)).toBe(false);
    reportHandoffRoute('wt-b');
    expect(handoffPageMayStart(b)).toBe(true);
  });
});
