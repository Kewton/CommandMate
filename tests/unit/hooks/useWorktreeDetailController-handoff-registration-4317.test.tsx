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
 * @vitest-environment jsdom
 */
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
import { handoffStoreSnapshot, resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import {
  isCurrentHandoffRegistration,
  registerHandoffPage,
  resetHandoffRegistryForTests,
  unregisterHandoffPage,
} from '@/lib/handoff/page-registration';

const A = 'wt-a';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

let heldModes: Array<() => void>;
let holdMode: boolean;

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  heldModes = [];
  holdMode = false;
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
    if (detail) {
      return Promise.resolve(reply(200, { id: detail[1], name: detail[1], path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} }));
    }
    return Promise.resolve(reply(404, {}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const release of heldModes.splice(0)) release();
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
