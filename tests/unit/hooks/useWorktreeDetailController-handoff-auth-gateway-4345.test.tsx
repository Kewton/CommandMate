/**
 * Issue #4345 1a: the page's requests report the session's expiry through one gateway
 * (`beginHandoffPageRequest` → `reportHandoffPageResponse` / `reportHandoffPageAuthenticated` in
 * `@/lib/handoff/page-registration`), owned by the registration the request left under and ordered
 * by one count across the entries. This PR moves the detail read and the end's mode read onto it.
 *
 * Drawn with the one host (`HandoffDialogHost`, the path `/worktrees/wt-a`) beside the page, so the
 * dialog's hiding and its return are seen, not a call count.
 *
 * Positive controls (fail on the code before 1a, where the mode read's 401 fell back to the plain
 * confirmation and never reached the registry):
 * - the mode read answers 401: the registry is expired, neither the plain confirmation nor the
 *   hand-off opens (the intended change), the host draws nothing, the unit and the opening stay;
 *   the next detail read's success brings the same opening back.
 * - ① a detail read answering 200 is held, ② the mode read answers 401, ① is released: still expired.
 * Negative controls (green before and after): the mode read's 500, 403, 409 and no response (status
 * 0) still fall back to the plain confirmation and expire nothing; ① the mode read's 401 held, ② a
 * detail read answers 200, ① released: not expired (and the unadopted 401 falls back as before); a
 * mode read that left under an older registration expires nothing of the current one.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, waitFor, act, cleanup } from '@testing-library/react';
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
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import { beginHandoffOpening, handoffStoreSnapshot, patchHandoffOpening, resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import type { HandoffReadResponse } from '@/lib/handoff/types';
import { handoffRegistrySnapshot, registerHandoffPage, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';

const A = 'wt-a';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

/** The mode read's answer: a status, or `0` for no response (the fetch rejects). */
let modeStatus: number;
let modeQueued: boolean;
let modeQueue: Array<() => void>;
let detailQueued: boolean;
let detailQueue: Array<(status: number) => void>;
/** 再指示 1: when set, the mode read's response is in hand but its body is held until released. */
let modeBodyHeld: boolean;
let modeBodyQueue: Array<() => void>;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const detailBody = { id: A, name: A, path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} };

function modeAnswer(): Promise<Response> {
  if (modeStatus === 0) return Promise.reject(new TypeError('Failed to fetch'));
  if (modeBodyHeld) {
    const status = modeStatus;
    const held = reply(status, status === 200 ? ATTENDED : { error: String(status) });
    held.json = () => new Promise((resolve) => modeBodyQueue.push(() => resolve(status === 200 ? ATTENDED : { error: String(status) })));
    return Promise.resolve(held);
  }
  return Promise.resolve(modeStatus === 200 ? reply(200, ATTENDED) : reply(modeStatus, { error: String(modeStatus) }));
}

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  modeStatus = 200;
  modeQueued = false;
  modeQueue = [];
  detailQueued = false;
  detailQueue = [];
  modeBodyHeld = false;
  modeBodyQueue = [];
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/mem/mode')) {
      if (modeQueued) return new Promise<Response>((resolve, reject) => modeQueue.push(() => void modeAnswer().then(resolve, reject)));
      return modeAnswer();
    }
    if (url.includes('/current-output')) return Promise.resolve(reply(200, { isRunning: false }));
    if (url.includes('/messages')) return Promise.resolve(reply(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(reply(200, { instances: {} }));
    if (/\/api\/worktrees\/[^/?]+$/.test(url)) {
      if (detailQueued) {
        return new Promise<Response>((resolve) => detailQueue.push((status) => resolve(status === 200 ? reply(200, detailBody) : reply(status, { error: 'x' }))));
      }
      return Promise.resolve(reply(200, detailBody));
    }
    return Promise.resolve(reply(404, {}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const release of modeQueue.splice(0)) release();
  for (const release of modeBodyQueue.splice(0)) release();
  for (const release of detailQueue.splice(0)) release(200);
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

let page: ReturnType<typeof useWorktreeDetailController>;
function Page() {
  page = useWorktreeDetailController({ worktreeId: A });
  return null;
}
const dialog = () => document.querySelector('[data-testid="handoff-dialog"]');
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

/** A's opening, its request read (taken back by the page on its first render). */
function openingOfA() {
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
  return own.token;
}

async function mounted(): Promise<void> {
  render(
    <>
      <Page />
      <HandoffDialogHost />
    </>,
  );
  await waitFor(() => expect(page.loading).toBe(false));
  await settle();
}

async function pressEnd(): Promise<void> {
  await act(async () => {
    await page.openEnd(TARGET);
  });
  await settle();
}

describe('[#4345 1a] the end’s mode read reports through the gateway', () => {
  it('the mode read answers 401: expired, no plain confirmation and no hand-off (intended), nothing drawn', async () => {
    await mounted();
    modeStatus = 401;
    await pressEnd();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(page.handoffAuthExpired).toBe(true);
    expect(page.killTarget).toBeNull();
    expect(page.handoffTarget).toBeNull();
    expect(handoffStoreSnapshot().opening).toBeNull();
    expect(dialog()).toBeNull();
  });

  it('with the host: the mode read’s 401 hides the dialog and keeps its opening; the next detail read’s success brings the same opening back', async () => {
    const token = openingOfA();
    await mounted();
    await waitFor(() => expect(dialog()).not.toBeNull());
    modeStatus = 401;
    await pressEnd();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(page.handoffTarget).toEqual(TARGET);
    expect(page.killTarget).toBeNull();
    // Hidden until a new detail read succeeds.
    detailQueued = true;
    act(() => {
      void page.handleRetry();
    });
    await waitFor(() => expect(detailQueue).toHaveLength(1));
    expect(dialog()).toBeNull();
    await act(async () => detailQueue.shift()!(200));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('① a detail read answering 200 held, ② the mode read answers 401, ① released: still expired, nothing drawn', async () => {
    const token = openingOfA();
    await mounted();
    detailQueued = true;
    act(() => {
      void page.handleRetry();
    });
    await waitFor(() => expect(detailQueue).toHaveLength(1));
    modeStatus = 401;
    await pressEnd();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    await act(async () => detailQueue.shift()!(200));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('(negative control, the reverse) ① the mode read’s 401 held, ② a detail read answers 200, ① released: not expired; the older 401 is not taken and falls back as before', async () => {
    await mounted();
    modeQueued = true;
    modeStatus = 401;
    let pressed: Promise<void> | null = null;
    act(() => {
      pressed = page.openEnd(TARGET);
    });
    await waitFor(() => expect(modeQueue).toHaveLength(1));
    detailQueued = true;
    act(() => {
      void page.handleRetry();
    });
    await waitFor(() => expect(detailQueue).toHaveLength(1));
    await act(async () => detailQueue.shift()!(200));
    await settle();
    await act(async () => {
      modeQueue.shift()!();
      await pressed;
    });
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(page.killTarget).toEqual(TARGET);
  });

  it('再指示 1: the mode read’s 401 taken, its body held, a detail read’s success recovers meanwhile: that press still opens nothing; a new press opens as usual', async () => {
    await mounted();
    modeStatus = 401;
    modeBodyHeld = true;
    let pressed: Promise<void> | null = null;
    act(() => {
      pressed = page.openEnd(TARGET);
    });
    await waitFor(() => expect(modeBodyQueue).toHaveLength(1));
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    // A newer detail read succeeds while the press's body is still being read: recovered.
    detailQueued = true;
    act(() => {
      void page.handleRetry();
    });
    await waitFor(() => expect(detailQueue).toHaveLength(1));
    await act(async () => detailQueue.shift()!(200));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    await act(async () => {
      modeBodyQueue.shift()!();
      await pressed;
    });
    await settle();
    // The press whose 401 was taken ends there: no plain confirmation, no hand-off.
    expect(page.killTarget).toBeNull();
    expect(page.handoffTarget).toBeNull();
    // (negative control) a press after the recovery opens as usual.
    modeBodyHeld = false;
    modeStatus = 500;
    await pressEnd();
    expect(page.killTarget).toEqual(TARGET);
  });

  it.each([500, 403, 409, 0])('(negative control) the mode read answers %s: not expired, the plain confirmation opens as before', async (status) => {
    await mounted();
    modeStatus = status;
    await pressEnd();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(page.killTarget).toEqual(TARGET);
    expect(page.handoffTarget).toBeNull();
  });

  it('(negative control) the mode read answers 200 attended: the hand-off opens, nothing expired', async () => {
    await mounted();
    await pressEnd();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(page.handoffTarget).toEqual(TARGET);
    await waitFor(() => expect(dialog()).not.toBeNull());
  });

  it('(negative control) a mode read that left under an older registration answers 401: the current registration is not expired', async () => {
    await mounted();
    modeQueued = true;
    modeStatus = 401;
    let pressed: Promise<void> | null = null;
    act(() => {
      pressed = page.openEnd(TARGET);
    });
    await waitFor(() => expect(modeQueue).toHaveLength(1));
    act(() => {
      registerHandoffPage(A);
    });
    await act(async () => {
      modeQueue.shift()!();
      await pressed;
    });
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(page.killTarget).toBeNull();
  });
});

describe('[#4345 1a] the detail read reports through the gateway', () => {
  it('the detail read answers 401: expired, the dialog hidden, its opening kept; a new detail read’s success brings it back', async () => {
    const token = openingOfA();
    await mounted();
    await waitFor(() => expect(dialog()).not.toBeNull());
    detailQueued = true;
    act(() => {
      void page.handleRetry();
    });
    await waitFor(() => expect(detailQueue).toHaveLength(1));
    await act(async () => detailQueue.shift()!(401));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    act(() => {
      void page.handleRetry();
    });
    await waitFor(() => expect(detailQueue).toHaveLength(1));
    await act(async () => detailQueue.shift()!(200));
    await settle();
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(handoffStoreSnapshot().opening?.token).toBe(token);
  });

  it.each([403, 409, 500])('(negative control) the detail read answers %s: not expired, the dialog stays', async (status) => {
    openingOfA();
    await mounted();
    await waitFor(() => expect(dialog()).not.toBeNull());
    detailQueued = true;
    act(() => {
      void page.handleRetry();
    });
    await waitFor(() => expect(detailQueue).toHaveLength(1));
    await act(async () => detailQueue.shift()!(status));
    await settle();
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    expect(dialog()).not.toBeNull();
  });
});
