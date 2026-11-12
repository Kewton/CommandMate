/**
 * The one host of the hand-off dialog beside the shell (Issue #4317 PR2; the pre-review
 * `prereview-4317-reply.md` 2・3).
 *
 * - The table of what the host draws (`handoffHostView`): the detail route's own page → 1 with its
 *   registration; the session expired, any other path (the list, login / offline / proxy, the
 *   terminal and files screens) or none → 0; no page of the route registered (the route's Loading,
 *   the page being left still registered) → what the route's page will take back, inert (no
 *   registration, no page's callback); another worktree's opening without a unit → 0.
 * - The control of the cause: under the host, the page is taken out and the route's Suspense
 *   fallback is committed; a MutationObserver from before counts 1 dialog in every notification and
 *   the same DOM node. Positive control: the host inside the page (as before PR2) counts 0 there.
 * - Negative controls: a late cleanup of the page left, the expiry over a page made again, a round
 *   trip away from the detail route (the opening stays open), the opening swapped (the person's
 *   choices are per opening), the items' lock kept by the store while nothing is drawn.
 *
 * The page here is a stand-in that registers and publishes as `useWorktreeDetailController` does
 * (the real page is driven in `WorktreeDetailRefactored-handoff-*` and the e2e).
 *
 * @vitest-environment jsdom
 */
import React, { Suspense, useEffect, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ path: '/worktrees/wt-a' as string | null }));

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

import { HandoffDialogHost, handoffHostView, handoffHostWorktreeOf } from '@/components/mem/HandoffDialogHost';
import {
  beginHandoffOpening,
  closeHandoffOpening,
  handoffStoreSnapshot,
  handoffUnitsLock,
  patchHandoffOpening,
  resetHandoffStoreForTests,
  settleHandoffDecide,
  startHandoffDecide,
  type HandoffOpening,
  type SessionStopResult,
} from '@/lib/handoff/close-rule';
import {
  handoffRegistrySnapshot,
  publishHandoffPageView,
  registerHandoffPage,
  reportHandoffPageAuth,
  resetHandoffRegistryForTests,
  unregisterHandoffPage,
  type HandoffPageRegistration,
} from '@/lib/handoff/page-registration';
import type { HandoffReadResponse } from '@/lib/handoff/types';

const A = 'wt-a';
const B = 'wt-b';
const TARGET = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' } as const;

const reviewing = (worktreeId: string): HandoffReadResponse =>
  ({
    ok: true,
    request: {
      id: 'r1', worktreeId, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
      state: 'reviewing', sendState: 'sent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
      agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
      agentDoneAt: '2026-11-10T00:01:00.000Z', endedAt: null, agentTimedOut: false, version: 3,
    },
    proposals: [
      {
        id: 'p1', op: 'add', itemId: null, kind: 'note', baseVersion: null, revision: 1, fingerprint: 'fp-p1',
        state: 'proposed', stateReason: null, payload: { text: 'text of p1' }, current: null, appliedItemId: null, appliedVersion: null,
      },
    ],
    direct: [],
  }) as unknown as HandoffReadResponse;

/** An opening of `worktreeId` already made and read (the dialog makes nothing for it). */
function openingOn(worktreeId: string): HandoffOpening {
  const opening = beginHandoffOpening(worktreeId, TARGET);
  patchHandoffOpening(opening.token, { created: 'done', view: reviewing(worktreeId), text: 'the request text' });
  return opening;
}

/** A decide of `worktreeId` whose result is unknown (a unit). */
function unknownUnitOn(worktreeId: string): void {
  const sending = startHandoffDecide({ worktreeId, requestId: 'r1', ifVersion: 3, decisions: [] });
  settleHandoffDecide(sending!, 'unknown');
}

let closes: string[];
const stop = async (): Promise<SessionStopResult> => 'stopped';

/** A page as `useWorktreeDetailController` registers and publishes (its target: the opening's). */
function StandInPage({ id, target = TARGET, withHost = false }: { id: string; target?: typeof TARGET | null; withHost?: boolean }) {
  const [, setRegistration] = useState<HandoffPageRegistration | null>(null);
  useEffect(() => {
    const registration = registerHandoffPage(id);
    setRegistration(registration);
    publishHandoffPageView(registration, { target, onClose: () => closes.push(id), onStop: stop });
    return () => unregisterHandoffPage(registration);
  }, [id, target]);
  return (
    <div data-testid={`page-${id}`}>
      {/* Positive control: the host inside the page (inside the route), as before PR2. */}
      {withHost && <HandoffDialogHost />}
    </div>
  );
}

/** A route whose page is not ready: it suspends for ever (the route's `loading.tsx` is shown). */
const never = new Promise<never>(() => undefined);
function NotReady(): React.ReactElement {
  throw never;
}

/**
 * The root layout: the route and the host beside it. As Next's layout router, the route's Suspense
 * boundary is keyed by the segment (a new segment is a new boundary: the page left is taken out and
 * the fallback committed, rather than the old page hidden under a boundary that suspends again).
 */
function Root({ page, hostBeside = true }: { page: React.ReactElement; hostBeside?: boolean }) {
  return (
    <>
      <Suspense key={String(page.key)} fallback={<div data-testid="route-loading" />}>
        {page}
      </Suspense>
      {hostBeside && <HandoffDialogHost />}
    </>
  );
}

const dialogs = () => document.querySelectorAll('[data-testid="handoff-dialog"]');
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

beforeEach(() => {
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
  nav.path = `/worktrees/${A}`;
  closes = [];
  global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => {
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
  vi.restoreAllMocks();
});

describe('[#4317 PR2] the detail route, read from the path', () => {
  it.each([
    ['/worktrees/wt-a', 'wt-a'],
    ['/worktrees/wt-a/', 'wt-a'],
    ['/worktrees/wt%20a', 'wt a'],
    ['/worktrees/wt-a/terminal', null],
    ['/worktrees/wt-a/files/src/x.ts', null],
    ['/', null],
    ['/worktrees', null],
    ['/sessions', null],
    ['/login', null],
    ['/offline', null],
    ['/proxy/wt-a', null],
    ['/worktrees/%E0%A4%A', null],
    ['', null],
    [null, null],
  ])('%s → %s', (pathname, expected) => {
    expect(handoffHostWorktreeOf(pathname)).toBe(expected);
  });
});

describe('[#4317 PR2] the host’s table (handoffHostView)', () => {
  it('the route’s own page with a target: drawn with that page’s registration and callbacks', () => {
    openingOn(A);
    const registration = registerHandoffPage(A);
    const onClose = () => undefined;
    publishHandoffPageView(registration, { target: TARGET, onClose, onStop: stop });
    const view = handoffHostView(`/worktrees/${A}`, handoffRegistrySnapshot(), handoffStoreSnapshot());
    expect(view).toMatchObject({ worktreeId: A, registration, target: TARGET });
    expect(view?.onClose).toBe(onClose);
    expect(view?.onStop).toBe(stop);
  });

  it('the page’s target null (nothing open): 0', () => {
    openingOn(A);
    publishHandoffPageView(registerHandoffPage(A), { target: null, onClose: () => undefined, onStop: stop });
    expect(handoffHostView(`/worktrees/${A}`, handoffRegistrySnapshot(), handoffStoreSnapshot())).toBeNull();
  });

  it.each(['/', '/sessions', '/login', '/offline', '/proxy/x', `/worktrees/${A}/terminal`, `/worktrees/${A}/files/a.ts`, null])(
    'not a detail route (%s): 0, though the page is registered with a target (shouldRenderShell is not the permission)',
    (pathname) => {
      openingOn(A);
      publishHandoffPageView(registerHandoffPage(A), { target: TARGET, onClose: () => undefined, onStop: stop });
      expect(handoffHostView(pathname, handoffRegistrySnapshot(), handoffStoreSnapshot())).toBeNull();
    }
  );

  it('the session expired: 0 (the opening and the unit stay in the store)', () => {
    const opening = openingOn(A);
    unknownUnitOn(A);
    const registration = registerHandoffPage(A);
    publishHandoffPageView(registration, { target: TARGET, onClose: () => undefined, onStop: stop });
    reportHandoffPageAuth(registration, 'expired', 1);
    expect(handoffHostView(`/worktrees/${A}`, handoffRegistrySnapshot(), handoffStoreSnapshot())).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(opening.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    // The items' lock is the store's: kept while nothing is drawn (MemItemsPanel reads it).
    expect(handoffUnitsLock(handoffStoreSnapshot())).toBe('unknown');
  });

  it('no page registered (the route’s Loading): the route’s own opening, inert — no registration, no page’s callback', async () => {
    openingOn(A);
    const left = registerHandoffPage(A);
    publishHandoffPageView(left, { target: TARGET, onClose: () => closes.push('left'), onStop: stop });
    unregisterHandoffPage(left);
    const view = handoffHostView(`/worktrees/${A}`, handoffRegistrySnapshot(), handoffStoreSnapshot());
    expect(view).toMatchObject({ worktreeId: A, registration: null, target: TARGET });
    view?.onClose();
    expect(closes).toEqual([]);
    expect(await view?.onStop()).toBe('refused');
  });

  it('the page being left still registered (another worktree’s): not the route’s page — the take-back rule instead', () => {
    openingOn(A);
    publishHandoffPageView(registerHandoffPage(B), { target: null, onClose: () => undefined, onStop: stop });
    expect(handoffHostView(`/worktrees/${A}`, handoffRegistrySnapshot(), handoffStoreSnapshot())).toMatchObject({ worktreeId: A, registration: null });
  });

  it('another worktree’s opening: without a unit not adopted (0); with an unknown unit shown as its (foreign), inert', () => {
    openingOn(A);
    expect(handoffHostView(`/worktrees/${B}`, handoffRegistrySnapshot(), handoffStoreSnapshot())).toBeNull();
    unknownUnitOn(A);
    expect(handoffHostView(`/worktrees/${B}`, handoffRegistrySnapshot(), handoffStoreSnapshot())).toMatchObject({ worktreeId: B, registration: null, target: TARGET });
  });

  it('no live opening: 0', () => {
    const opening = openingOn(A);
    closeHandoffOpening(opening.token, 'person');
    expect(handoffHostView(`/worktrees/${A}`, handoffRegistrySnapshot(), handoffStoreSnapshot())).toBeNull();
  });
});

/** Counts the dialogs in every notification of a MutationObserver, from before `change`. */
async function observe(change: () => void): Promise<{ start: number; notes: number[]; sameNode: boolean; final: number }> {
  const startNode = document.querySelector('[data-testid="handoff-dialog"]');
  const start = dialogs().length;
  const notes: number[] = [];
  let sameNode = true;
  const look = () => {
    const found = dialogs();
    notes.push(found.length);
    if (found.length !== 1 || found[0] !== startNode) sameNode = false;
  };
  const observer = new MutationObserver(look);
  try {
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    change();
    await settle();
    if (observer.takeRecords().length > 0) look();
  } finally {
    observer.disconnect();
  }
  const final = dialogs().length;
  if (final !== 1 || dialogs()[0] !== startNode) sameNode = false;
  return { start, notes, sameNode, final };
}

describe('[#4317 PR2] the page taken out and the route’s Suspense fallback committed, under the host', () => {
  it('A → the route’s Loading → A: one dialog in every notification, the same node; inert in the Loading', async () => {
    openingOn(A);
    unknownUnitOn(A);
    const view = render(<Root page={<StandInPage key={A} id={A} />} />);
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(screen.getByTestId('handoff-pending-resend')).not.toBeDisabled();

    const toLoading = await observe(() => view.rerender(<Root page={<NotReady key="loading" />} />));
    expect(screen.getByTestId('route-loading')).toBeTruthy();
    expect(screen.queryByTestId(`page-${A}`)).toBeNull();
    expect(handoffRegistrySnapshot().live).toHaveLength(0);
    expect(toLoading.start).toBe(1);
    expect(toLoading.notes.length).toBeGreaterThan(0);
    expect(toLoading.notes.filter((n) => n !== 1)).toEqual([]);
    expect(toLoading.final).toBe(1);
    expect(toLoading.sameNode).toBe(true);
    // No page registered: drawn, nothing starts (the resend disabled).
    expect(screen.getByTestId('handoff-pending-resend')).toBeDisabled();

    const back = await observe(() => view.rerender(<Root page={<StandInPage key={`${A}-again`} id={A} />} />));
    expect(back.notes.filter((n) => n !== 1)).toEqual([]);
    expect(back.sameNode).toBe(true);
    expect(screen.getByTestId('handoff-pending-resend')).not.toBeDisabled();
  });

  it('(positive control) the host inside the page, as before PR2: the Loading counts 0 dialogs', async () => {
    openingOn(A);
    unknownUnitOn(A);
    const view = render(<Root hostBeside={false} page={<StandInPage key={A} id={A} withHost />} />);
    await settle();
    expect(dialogs()).toHaveLength(1);
    const toLoading = await observe(() => view.rerender(<Root hostBeside={false} page={<NotReady key="loading" />} />));
    expect(screen.getByTestId('route-loading')).toBeTruthy();
    expect(toLoading.notes).toContain(0);
    expect(toLoading.final).toBe(0);
  });

  it('B shows A’s unit (foreign); B → Loading → A: one dialog all along, foreign then A’s own', async () => {
    openingOn(A);
    unknownUnitOn(A);
    nav.path = `/worktrees/${B}`;
    const view = render(<Root page={<StandInPage key={B} id={B} />} />);
    await settle();
    expect(screen.getByTestId('handoff-foreign')).toBeTruthy();
    const run = await observe(() => {
      nav.path = `/worktrees/${A}`;
      view.rerender(<Root page={<NotReady key="loading" />} />);
    });
    expect(run.notes.filter((n) => n !== 1)).toEqual([]);
    expect(run.sameNode).toBe(true);
    const back = await observe(() => view.rerender(<Root page={<StandInPage key={A} id={A} />} />));
    expect(back.notes.filter((n) => n !== 1)).toEqual([]);
    expect(back.sameNode).toBe(true);
    expect(screen.queryByTestId('handoff-foreign')).toBeNull();
    expect(screen.getByTestId('handoff-pending-resend')).not.toBeDisabled();
  });
});

describe('[#4317 PR2] negative controls', () => {
  it('a late cleanup of the page left does not take the page come to away', async () => {
    openingOn(A);
    const left = registerHandoffPage(B);
    render(<Root page={<StandInPage key={A} id={A} />} />);
    await settle();
    act(() => unregisterHandoffPage(left));
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(screen.getByTestId('handoff-cancel')).not.toBeDisabled();
  });

  it('expired: 0 dialogs (no modal over the re-login), a page made again does not bring it back; the current page’s read does, the same opening', async () => {
    const opening = openingOn(A);
    unknownUnitOn(A);
    const view = render(<Root page={<StandInPage key={A} id={A} />} />);
    await settle();
    act(() => reportHandoffPageAuth(handoffRegistrySnapshot().live[0].id, 'expired', 1));
    await settle();
    expect(dialogs()).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    view.rerender(<Root page={<StandInPage key={`${A}-again`} id={A} />} />);
    await settle();
    expect(dialogs()).toHaveLength(0);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    act(() => reportHandoffPageAuth(handoffRegistrySnapshot().live[0].id, 'authenticated', 1));
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(handoffStoreSnapshot().opening?.token).toBe(opening.token);
    expect(screen.getByTestId('handoff-pending')).toBeTruthy();
  });

  it('away from the detail route and back: 0 away (not hidden: the opening stays open), 1 back', async () => {
    const opening = openingOn(A);
    const view = render(<Root page={<StandInPage key={A} id={A} />} />);
    await settle();
    nav.path = '/sessions';
    view.rerender(<Root page={<div data-testid="sessions" />} />);
    await settle();
    expect(dialogs()).toHaveLength(0);
    expect(handoffStoreSnapshot().opening?.token).toBe(opening.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    nav.path = `/worktrees/${A}`;
    view.rerender(<Root page={<StandInPage key={`${A}-back`} id={A} />} />);
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(closes).toEqual([]);
  });

  it('the opening swapped: the person’s choices are per opening (kept over the route, not carried to the next)', async () => {
    const first = openingOn(A);
    const view = render(<Root page={<StandInPage key={A} id={A} />} />);
    await settle();
    fireEvent.click(screen.getByTestId('handoff-approve-p1'));
    expect(screen.getByTestId('handoff-approve-p1')).toHaveAttribute('aria-pressed', 'true');
    // The same opening over the route's Loading and back: kept.
    view.rerender(<Root page={<NotReady key="loading" />} />);
    await settle();
    view.rerender(<Root page={<StandInPage key={`${A}-again`} id={A} />} />);
    await settle();
    expect(screen.getByTestId('handoff-approve-p1')).toHaveAttribute('aria-pressed', 'true');
    // Another opening: afresh.
    act(() => {
      closeHandoffOpening(first.token, 'person');
      openingOn(A);
    });
    await settle();
    expect(screen.getByTestId('handoff-approve-p1')).toHaveAttribute('aria-pressed', 'false');
  });
});
