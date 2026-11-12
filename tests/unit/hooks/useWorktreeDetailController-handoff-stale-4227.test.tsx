/**
 * The page's close of the hand-off when its opening is stale (Issue #4227 G-PR2 pr2g, PM Claude
 * pr2f P3-2; design `mem-ui-4227.md` §4.1.1). `closeHandoffBy` names the opening its "end" began;
 * when another opening began since (another page — the PC split and the phone, another tab of the
 * same store), the store answers `stale`: this page's target goes, and the other opening and the
 * worktree's units are not touched (no rule asked for them, nothing closed, nothing dropped).
 *
 * Positive control: the branch turned the other way (stale keeps the target: `answer !== null`)
 * leaves the page's dialog shown for an opening that is over — the first case fails. A branch
 * that closed the current opening instead fails the second assertion of each case.
 * Negative control: the page's own opening holding a unit is refused as before (the target stays).
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
  handoffStoreSnapshot,
  handoffUnitsOf,
  resetHandoffStoreForTests,
  startHandoffDecide,
} from '@/lib/handoff/close-rule';

const A = 'wt-a';
const B = 'wt-b';
const TARGET: SessionKillTarget = { cliToolId: 'codex', instanceId: 'codex-2', label: 'Review agent' };

type ModeAnswer = { status: number; body: unknown } | 'reject' | 'stall' | 'hold';

interface Server {
  mode: ModeAnswer;
  modeReads: string[];
  kills: string[];
  heldModes: Array<() => void>;
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ATTENDED = { status: 200, body: { ok: true, mode: 'on', features: { popup: true } } };

function install(mode: ModeAnswer): Server {
  const server: Server = { mode, modeReads: [], kills: [], heldModes: [] };
  global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/mem/mode')) {
      server.modeReads.push(url);
      const answer = server.mode;
      if (answer === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
      if (answer === 'stall') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      if (answer === 'hold') {
        return new Promise<Response>((resolve) => server.heldModes.push(() => resolve(reply(ATTENDED.status, ATTENDED.body))));
      }
      return Promise.resolve(reply(answer.status, answer.body));
    }
    if (url.includes('/kill-session')) {
      server.kills.push(url);
      return Promise.resolve(reply(200, { success: true, message: 'ok' }));
    }
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
  return server;
}

async function opened(mode: ModeAnswer) {
  const server = install(mode);
  const hook = renderHook(({ worktreeId }) => useWorktreeDetailController({ worktreeId }), {
    initialProps: { worktreeId: A },
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
  return { ...hook, server };
}


const OTHER: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude-3', label: 'Lead' };
const UNIT = { worktreeId: A, requestId: 'req-1', ifVersion: 1, decisions: [] };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetHandoffStoreForTests();
});

async function openedHandoff() {
  resetHandoffStoreForTests();
  const hook = await opened(ATTENDED);
  await act(async () => {
    await hook.result.current.openEnd(TARGET);
  });
  expect(hook.result.current.handoffTarget).toEqual(TARGET);
  const own = handoffStoreSnapshot().opening;
  expect(own?.target.instanceId).toBe(TARGET.instanceId);
  return { hook, own: own! };
}

describe('[#4227 pr2g] closeHandoffBy on a stale opening: its own target goes, nothing else is touched', () => {
  it('the dialog’s close after another page began an opening that holds a decide: target cleared, the other opening and its unit stay', async () => {
    const { hook } = await openedHandoff();
    // Another page: a new opening of the same worktree, and a decide sent from it.
    const other = beginHandoffOpening(A, OTHER);
    const sending = startHandoffDecide(UNIT);
    expect(sending).not.toBeNull();
    act(() => {
      hook.result.current.closeHandoff();
    });
    expect(hook.result.current.handoffTarget).toBeNull();
    expect(handoffStoreSnapshot().opening).toBe(other);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(handoffUnitsOf(A).inflight).toBe(sending);
    // The page's next "end" begins its own opening again (as before pr2g); the decide sent from
    // the other page's opening is still the worktree's (a new opening never drops a unit).
    await act(async () => {
      await hook.result.current.openEnd(TARGET);
    });
    expect(hook.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffUnitsOf(A).inflight).toBe(sending);
  });

  it('a switch of worktree after another page began an opening: target cleared, the other opening stays open', async () => {
    const { hook } = await openedHandoff();
    const other = beginHandoffOpening(A, OTHER);
    hook.rerender({ worktreeId: B });
    await waitFor(() => expect(hook.result.current.handoffTarget).toBeNull());
    expect(handoffStoreSnapshot().opening).toBe(other);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('(negative control) the page’s own opening holding a decide: the close is refused and the target stays', async () => {
    const { hook, own } = await openedHandoff();
    const sending = startHandoffDecide(UNIT);
    act(() => {
      hook.result.current.closeHandoff();
    });
    expect(hook.result.current.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening).toBe(own);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(handoffUnitsOf(A).inflight).toBe(sending);
  });

  it('(negative control) the page’s own opening holding nothing: closed through the rule', async () => {
    const { hook, own } = await openedHandoff();
    act(() => {
      hook.result.current.closeHandoff();
    });
    expect(hook.result.current.handoffTarget).toBeNull();
    expect(handoffStoreSnapshot().opening?.token).toBe(own.token);
    expect(handoffStoreSnapshot().opening?.closed).toBe(true);
  });
});
