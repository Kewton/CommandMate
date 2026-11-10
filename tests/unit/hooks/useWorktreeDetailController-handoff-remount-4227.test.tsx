/**
 * G10 (Issue #4227, the UAT of G-PR1+G-PR2; design `mem-ui-4227.md` §4.1.1): the page made again
 * takes the store's live opening back, so the hand-off dialog is drawn open without a person's press.
 *
 * The difference between the unit model and the real page: the component test "path 6 — the dialog
 * drawn again" remounts the dialog only, under the same page. On the real page the PC ↔ phone switch
 * remounts the whole page — `AppShell` draws its children under another parent per layout — so this
 * hook mounts anew and its `handoffTarget` (React state) starts at null: the dialog's `isOpen` is
 * false although the store keeps the opening and its unknown unit. Here the hook is unmounted and
 * mounted again, as the layout switch does.
 *
 * Positive control: without the taking back (the `[worktreeId]` effect asking the switch only, the
 * code before G10) the first three cases fail (the target stays null).
 * Negative controls: a closed opening (the person closed it) is not taken back; another worktree's
 * opening is not taken back unless it holds a decide being sent or unknown (the invariant's units)
 * — one holding nothing, or only a cancel waiting for its answer, is left as before G10, and the
 * page opens its own hand-off.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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
import {
  beginHandoffOpening,
  closeHandoffOpening,
  handoffStoreSnapshot,
  handoffUnitsOf,
  resetHandoffStoreForTests,
  settleHandoffDecide,
  startHandoffCancel,
  listenHandoffRefusal,
  startHandoffDecide,
} from '@/lib/handoff/close-rule';

const A = 'wt-a';
const B = 'wt-b';
const TARGET: SessionKillTarget = { cliToolId: 'codex', instanceId: 'codex-2', label: 'Review agent' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function install(): void {
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/mem/mode')) return Promise.resolve(reply(200, ATTENDED));
    if (url.includes('/current-output')) return Promise.resolve(reply(200, { isRunning: false }));
    if (url.includes('/messages')) return Promise.resolve(reply(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(reply(200, { instances: {} }));
    const detail = /\/api\/worktrees\/([^/?]+)$/.exec(url);
    if (detail) {
      return Promise.resolve(
        reply(200, { id: detail[1], name: detail[1], path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} })
      );
    }
    return Promise.resolve(reply(404, {}));
  }) as unknown as typeof fetch;
}

async function mount(worktreeId: string, reactStrictMode = false) {
  const hook = renderHook(({ id }) => useWorktreeDetailController({ worktreeId: id }), { initialProps: { id: worktreeId }, reactStrictMode });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
  return hook;
}

/** A decide sent and its result unknown (the dialog's ⑤ with no answer). */
function unknownDecide(worktreeId: string) {
  const sending = startHandoffDecide({ worktreeId, requestId: 'req-1', ifVersion: 1, decisions: [] });
  expect(sending).not.toBeNull();
  settleHandoffDecide(sending!, 'unknown');
  expect(handoffUnitsOf(worktreeId).pending).toBe(sending);
  return sending!;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetHandoffStoreForTests();
});

describe('[#4227 G10] the page made again (PC ↔ phone, Loading) draws the hand-off open from the store', () => {
  it('an unknown unit: the page mounted again takes the same opening back (no new opening, the unit kept)', async () => {
    resetHandoffStoreForTests();
    install();
    const first = await mount(A);
    await act(async () => {
      await first.result.current.openEnd(TARGET);
    });
    const own = handoffStoreSnapshot().opening!;
    const pending = unknownDecide(A);
    first.unmount();

    const again = await mount(A);
    expect(again.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening).toBe(own);
    expect(handoffUnitsOf(A).pending).toBe(pending);
    // The page's closes still ask the rule for that opening: refused while the unit is there.
    act(() => {
      again.result.current.closeHandoff();
    });
    expect(again.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('no unit yet (waiting for the agent): taken back too, so the person need not press "end" again', async () => {
    resetHandoffStoreForTests();
    install();
    const first = await mount(A);
    await act(async () => {
      await first.result.current.openEnd(TARGET);
    });
    const own = handoffStoreSnapshot().opening!;
    first.unmount();
    const again = await mount(A);
    expect(again.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening).toBe(own);
    // Nothing held: the person's close closes that very opening.
    act(() => {
      again.result.current.closeHandoff();
    });
    expect(again.result.current.handoffTarget).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(true);
  });

  it('a switch of worktree (the page made again on B, Next keys it by [id]) with A’s unknown unit: shown as A’s (kept by the rule)', async () => {
    resetHandoffStoreForTests();
    install();
    const own = beginHandoffOpening(A, TARGET);
    unknownDecide(A);
    const onB = await mount(B);
    expect(onB.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening).toBe(own);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('(negative control) a closed opening is not taken back', async () => {
    resetHandoffStoreForTests();
    install();
    const own = beginHandoffOpening(A, TARGET);
    expect(closeHandoffOpening(own.token, 'person')).toBeNull();
    const again = await mount(A);
    expect(again.result.current.handoffTarget).toBeNull();
  });

  it('(negative control) another worktree’s opening holding nothing: not taken back, left as it was (the code before G10)', async () => {
    resetHandoffStoreForTests();
    install();
    const own = beginHandoffOpening(A, TARGET);
    const onB = await mount(B);
    expect(onB.result.current.handoffTarget).toBeNull();
    expect(handoffStoreSnapshot().opening).toBe(own);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('(negative control) another worktree’s cancel waiting for its answer: not taken back — B’s page opens its own (pr2f)', async () => {
    resetHandoffStoreForTests();
    install();
    beginHandoffOpening(A, TARGET);
    expect(startHandoffCancel(A)).toBe(true);
    const onB = await mount(B);
    expect(onB.result.current.handoffTarget).toBeNull();
    await act(async () => {
      await onB.result.current.openEnd(TARGET);
    });
    expect(onB.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening?.worktreeId).toBe(B);
  });
});

/**
 * pr3c (review B P2-1, PM return 1): `next.config.js` sets `reactStrictMode: true`, so in dev (the
 * e2e's `npm run dev`) React runs a new mount's effects twice. The second run of the taking back
 * must not close what the first took back, nor ask a switch nobody made (the refusal's alert).
 * Positive control: before pr3c, the second run fell to `closeHandoffBy('worktree-switch')` and the
 * opening without a unit was closed (the case "no unit" fails).
 */
describe('[#4227 G10 pr3c] the same under React StrictMode (effects run twice on mount)', () => {
  function refusals(): Array<[string, string]> {
    const told: Array<[string, string]> = [];
    const stop = listenHandoffRefusal((path, block) => told.push([path, block]));
    afterEachStops.push(stop);
    return told;
  }
  const afterEachStops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of afterEachStops.splice(0)) stop();
  });

  it('no unit yet (waiting for the agent): taken back and left open', async () => {
    resetHandoffStoreForTests();
    install();
    const first = await mount(A, true);
    await act(async () => {
      await first.result.current.openEnd(TARGET);
    });
    const own = handoffStoreSnapshot().opening!;
    first.unmount();
    const again = await mount(A, true);
    expect(again.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening).toBe(own);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('an unknown unit: taken back, kept, and no refusal is told (nobody pressed anything)', async () => {
    resetHandoffStoreForTests();
    install();
    const first = await mount(A, true);
    await act(async () => {
      await first.result.current.openEnd(TARGET);
    });
    const own = handoffStoreSnapshot().opening!;
    const pending = unknownDecide(A);
    first.unmount();
    const told = refusals();
    const again = await mount(A, true);
    expect(again.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening).toBe(own);
    expect(handoffUnitsOf(A).pending).toBe(pending);
    expect(told).toEqual([]);
  });

  it('another worktree’s unknown unit (the page made again on B): shown as A’s, kept, no refusal told', async () => {
    resetHandoffStoreForTests();
    install();
    const own = beginHandoffOpening(A, TARGET);
    unknownDecide(A);
    const told = refusals();
    const onB = await mount(B, true);
    expect(onB.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening).toBe(own);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(told).toEqual([]);
  });

  it('(negative control) a real switch of worktree on the same page still asks the rule: nothing held → closed', async () => {
    resetHandoffStoreForTests();
    install();
    const hook = await mount(A, true);
    await act(async () => {
      await hook.result.current.openEnd(TARGET);
    });
    const own = handoffStoreSnapshot().opening!;
    hook.rerender({ id: B });
    await waitFor(() => expect(hook.result.current.handoffTarget).toBeNull());
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(true);
  });

  it('(negative control) a real switch with A’s unknown unit: kept by the rule, the refusal told', async () => {
    resetHandoffStoreForTests();
    install();
    const hook = await mount(A, true);
    await act(async () => {
      await hook.result.current.openEnd(TARGET);
    });
    unknownDecide(A);
    const told = refusals();
    hook.rerender({ id: B });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(hook.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(told).toContainEqual(['worktree-switch', 'unknown']);
  });
});
