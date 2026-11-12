/**
 * The page's "end" answers to its registration (Issue #4317 PR1, `@/lib/handoff/page-registration`):
 * `openEnd` checks the page's registration when pressed and again after the mode's read, before the
 * opening is made. The worktree id alone (`startedFor`) does not tell an old page made again with
 * the same id from the page now registered.
 *
 * Positive controls (the code before #4317 PR1): the cases marked "lapsed" open the hand-off from a
 * page whose registration is gone or not current. Negative controls: the current page opens it, and
 * the late cleanup of an older page leaves the newer page's "end" working.
 *
 * 再指示 1 (the consistency review's P2): a read's answer reports the session's state for the
 * registration it started under, taken only while that one is still the current one. Under
 * StrictMode (setup → cleanup → setup, two registrations of one page and two first reads), the first
 * setup's read answering 200 after the second's answered 401 does not clear the expiry — the dialog
 * the page draws stays undrawn. Positive control: 3c4f092 (the answer read the registration current
 * when it answered) clears it and draws the dialog. Negative control: the second setup's read
 * answering 200 clears it.
 *
 * 再指示 2: the dialog is hidden by the registry's expiry alone — the old registration's 401 while
 * the current one's read is held leaves it drawn (64dc4b6, `isAuthExpired ||`, hid it) — and within
 * one registration the answers are taken in the order the reads left: ② 401 then ① 200 stays
 * expired (64dc4b6 cleared it); the pair ② 200 then ① 401 stays authenticated.
 *
 * @vitest-environment jsdom
 */
import React, { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { SessionKillTarget } from '@/types/terminal-split-pane';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({ worktrees: [], repositories: [], isLoading: false, error: null, refresh: vi.fn() }),
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { SessionHandoffDialog } from '@/components/mem/SessionHandoffDialog';
import {
  beginHandoffOpening,
  handoffStoreSnapshot,
  patchHandoffOpening,
  resetHandoffStoreForTests,
} from '@/lib/handoff/close-rule';
import type { HandoffReadResponse } from '@/lib/handoff/types';
import {
  handoffRegistrySnapshot,
  isCurrentHandoffRegistration,
  reportHandoffPageAuth,
  registerHandoffPage,
  resetHandoffRegistryForTests,
  unregisterHandoffPage,
} from '@/lib/handoff/page-registration';

const A = 'wt-a';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

let heldModes: Array<() => void>;
let holdMode: boolean;
/** 再指示 1: each detail read held in order, answered with the status its release names. */
let detailQueued: boolean;
let detailQueue: Array<(status: number) => void>;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  heldModes = [];
  holdMode = false;
  detailQueued = false;
  detailQueue = [];
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/mem/mode')) {
      if (holdMode) return new Promise<Response>((resolve) => heldModes.push(() => resolve(reply(200, ATTENDED))));
      return Promise.resolve(reply(200, ATTENDED));
    }
    if (url.includes('/current-output')) return Promise.resolve(reply(200, { isRunning: false }));
    if (url.includes('/messages')) return Promise.resolve(reply(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(reply(200, { instances: {} }));
    const detail = /\/api\/worktrees\/([^/?]+)$/.exec(url);
    if (detail && detailQueued) {
      return new Promise<Response>((resolve) =>
        detailQueue.push((status) =>
          resolve(status === 401 ? reply(401, { error: 'unauthorized' }) : reply(200, { id: detail[1], name: detail[1], path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} })),
        ),
      );
    }
    if (detail) {
      return Promise.resolve(reply(200, { id: detail[1], name: detail[1], path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} }));
    }
    return Promise.resolve(reply(404, {}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const release of heldModes.splice(0)) release();
  for (const release of detailQueue.splice(0)) release(200);
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

async function mounted() {
  const hook = renderHook(() => useWorktreeDetailController({ worktreeId: A }));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe('[#4317 PR1] openEnd and the page’s registration', () => {
  it('the page registers once mounted, with an identity of its own', async () => {
    const hook = await mounted();
    expect(hook.result.current.handoffRegistration).not.toBeNull();
    expect(isCurrentHandoffRegistration(hook.result.current.handoffRegistration)).toBe(true);
  });

  it.each(['overlap', 'gap'] as const)('lapsed (%s) during the mode’s read: no opening is made, no target is set', async (how) => {
    const hook = await mounted();
    holdMode = true;
    let pressed: Promise<void> | null = null;
    act(() => {
      pressed = hook.result.current.openEnd(TARGET);
    });
    await waitFor(() => expect(heldModes).toHaveLength(1));
    act(() => {
      if (how === 'overlap') registerHandoffPage(A);
      else unregisterHandoffPage(hook.result.current.handoffRegistration!);
    });
    await act(async () => {
      heldModes[0]();
      await pressed;
    });
    expect(handoffStoreSnapshot().opening).toBeNull();
    expect(hook.result.current.handoffTarget).toBeNull();
    expect(hook.result.current.killTarget).toBeNull();
  });

  it('(negative control) the registration current through the read: the hand-off opens', async () => {
    const hook = await mounted();
    holdMode = true;
    let pressed: Promise<void> | null = null;
    act(() => {
      pressed = hook.result.current.openEnd(TARGET);
    });
    await waitFor(() => expect(heldModes).toHaveLength(1));
    await act(async () => {
      heldModes[0]();
      await pressed;
    });
    expect(hook.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening?.target.instanceId).toBe('claude');
  });

  it('lapsed before the press (a newer page registered): the press opens nothing', async () => {
    const hook = await mounted();
    act(() => {
      registerHandoffPage(A);
    });
    await act(async () => {
      await hook.result.current.openEnd(TARGET);
    });
    expect(handoffStoreSnapshot().opening).toBeNull();
  });

  it('an older page’s late cleanup does not remove the newer page’s registration: the newer page’s "end" opens', async () => {
    const older = await mounted();
    const newer = await mounted();
    older.unmount();
    expect(isCurrentHandoffRegistration(newer.result.current.handoffRegistration)).toBe(true);
    await act(async () => {
      await newer.result.current.openEnd(TARGET);
    });
    expect(newer.result.current.handoffTarget).toEqual(TARGET);
  });
});

describe('[#4317 PR1 再指示 1] a read reports for the registration it started under', () => {
  let page: ReturnType<typeof useWorktreeDetailController>;
  /** The page's host as `WorktreeDetailRefactored` draws it (undrawn while `handoffAuthExpired`). */
  function Page() {
    page = useWorktreeDetailController({ worktreeId: A });
    return page.handoffAuthExpired ? null : (
      <SessionHandoffDialog
        isOpen={page.handoffTarget !== null}
        worktreeId={A}
        target={page.handoffTarget}
        onClose={page.closeHandoff}
        onStop={page.stopForHandoff}
        registration={page.handoffRegistration}
      />
    );
  }
  const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

  /** A's opening taken back by the page (its first render), with its request read. */
  function openingOfA(): void {
    const own = beginHandoffOpening(A, TARGET);
    patchHandoffOpening(own.token, {
      created: 'done',
      view: {
        ok: true,
        request: {
          id: 'r1', worktreeId: A, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
          state: 'awaiting_agent', sendState: 'sent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
          agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
          agentDoneAt: null, endedAt: null, agentTimedOut: false, version: 1,
        },
        proposals: [],
        direct: [],
      } as unknown as HandoffReadResponse,
    });
  }

  /** The page under StrictMode with its first reads held: one per setup (and per registration). */
  async function strictPage(): Promise<[(status: number) => void, (status: number) => void]> {
    detailQueued = true;
    render(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
    await settle();
    expect(detailQueue.length).toBeGreaterThanOrEqual(2);
    const [first, second] = detailQueue.splice(0, 2);
    return [first, second];
  }

  it('the first setup’s read answers 200 after the second setup’s read answered 401: the expiry stays, the dialog is not drawn', async () => {
    openingOfA();
    const [first, second] = await strictPage();
    await act(async () => second(401));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    await act(async () => first(200));
    await settle();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('(negative control) expired before; the second setup’s read answers 200: the expiry is cleared, the dialog is drawn', async () => {
    openingOfA();
    const earlier = registerHandoffPage(A);
    reportHandoffPageAuth(earlier, 'expired', 1);
    unregisterHandoffPage(earlier);
    const [, second] = await strictPage();
    expect(document.querySelector('[data-testid="handoff-dialog"]')).toBeNull();
    await act(async () => second(200));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    await waitFor(() => expect(document.querySelector('[data-testid="handoff-dialog"]')).not.toBeNull());
  });

  describe('[#4317 PR1 再指示 2] the dialog is hidden by the registry alone, the answers taken in order', () => {
    const dialog = () => document.querySelector('[data-testid="handoff-dialog"]');

    it('the old registration’s 401 while the current one’s read is held: the dialog stays drawn', async () => {
      openingOfA();
      const [first, second] = await strictPage();
      await waitFor(() => expect(dialog()).not.toBeNull());
      await act(async () => first(401));
      await settle();
      expect(handoffRegistrySnapshot().authExpired).toBe(false);
      expect(dialog()).not.toBeNull();
      await act(async () => second(200));
      await settle();
      expect(dialog()).not.toBeNull();
      expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    });

    /** The page (no StrictMode) with its first read answered 200, then two reads ① ② held. */
    async function twoReads(): Promise<[(status: number) => void, (status: number) => void]> {
      openingOfA();
      detailQueued = true;
      render(<Page />);
      await waitFor(() => expect(detailQueue).toHaveLength(1));
      await act(async () => detailQueue.shift()!(200));
      await waitFor(() => expect(dialog()).not.toBeNull());
      act(() => {
        void page.handleRetry();
      });
      act(() => {
        void page.handleRetry();
      });
      await waitFor(() => expect(detailQueue).toHaveLength(2));
      const [one, two] = detailQueue.splice(0, 2);
      return [one, two];
    }

    it('one registration: ② answers 401, then the older ① answers 200 — still expired, the dialog not drawn', async () => {
      const [one, two] = await twoReads();
      await act(async () => two(401));
      await settle();
      expect(dialog()).toBeNull();
      await act(async () => one(200));
      await settle();
      expect(handoffRegistrySnapshot().authExpired).toBe(true);
      expect(dialog()).toBeNull();
      expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    });

    it('(the pair) one registration: ② answers 200, then the older ① answers 401 — not expired, the dialog drawn', async () => {
      const [one, two] = await twoReads();
      await act(async () => two(200));
      await settle();
      await act(async () => one(401));
      await settle();
      expect(handoffRegistrySnapshot().authExpired).toBe(false);
      expect(dialog()).not.toBeNull();
    });
  });
});
