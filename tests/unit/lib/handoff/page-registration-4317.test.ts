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
  handoffRegistrySnapshot,
  isCurrentHandoffRegistration,
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
    reportHandoffPageAuth(old, 'expired');
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    unregisterHandoffPage(old);
    registerHandoffPage('wt-a');
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
  });

  it('an old page’s success does not recover; the current page’s authenticated read does', () => {
    const old = registerHandoffPage('wt-a');
    reportHandoffPageAuth(old, 'expired');
    unregisterHandoffPage(old);
    const current = registerHandoffPage('wt-a');
    reportHandoffPageAuth(old, 'authenticated');
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    reportHandoffPageAuth(null, 'authenticated');
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    reportHandoffPageAuth(current, 'authenticated');
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });

  it('an old page’s 401 does not expire the current page', () => {
    const old = registerHandoffPage('wt-a');
    registerHandoffPage('wt-b');
    reportHandoffPageAuth(old, 'expired');
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
  });
});
