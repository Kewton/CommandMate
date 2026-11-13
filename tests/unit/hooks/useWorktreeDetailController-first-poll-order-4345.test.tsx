/**
 * Issue #4345 1c 再指示 1 (指摘 3): on a cache hit the page draws what it owns in its first commit, and
 * the pane's first poll (`useTerminalPanePolling`'s passive effect) leaves in that commit. The page
 * registers in the layout phase, so that poll is already owned: its 401 expires the session and the
 * host draws nothing.
 *
 * Drawn as the app orders it — the real page (`useWorktreeDetailController`, the worktree in the
 * list's cache) providing its holder to a real pane poller in the same tree, with no registration made
 * before the render (unlike `page-owner-harness`, which registers first).
 *
 * Positive control (red before 再指示 1, where the page registered in a passive effect after its
 * children's): the first pane poll answers 401 (the detail read held, nothing else answering 401) —
 * expired, and the opening's dialog is not drawn. Negative control: the same first poll answering 200
 * leaves the session as it is (the dialog is drawn).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

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
    isOpen: true, width: 288, isMobileDrawerOpen: false, toggle: vi.fn(),
    setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
}));
// The cache hit: the list already holds the worktree, so the page draws without its Loading.
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({
    worktrees: [{ id: 'wt-a', name: 'wt-a', path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} }],
    repositories: [], isLoading: false, error: null, refresh: vi.fn(),
  }),
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { HandoffPageOwnerContext } from '@/hooks/useHandoffPageOwner';
import { HandoffDialogHost } from '@/components/mem/HandoffDialogHost';
import { beginHandoffOpening, patchHandoffOpening, resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import { handoffRegistrySnapshot, resetHandoffRegistryForTests } from '@/lib/handoff/page-registration';
import type { HandoffReadResponse } from '@/lib/handoff/types';
import { HANDOFF_READ_VIEW, json } from '../lib/handoff/page-owner-harness';

const A = 'wt-a';
let firstPaneStatus: number;
let paneCalls: number;
const held: Array<() => void> = [];

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  paneCalls = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/mem/mode')) return json(200, { ok: true, mode: 'on', features: { popup: true } });
    if (url.includes('/mem/handoff/requests/r1')) return json(200, HANDOFF_READ_VIEW);
    // The pane's own poll names its instance; the page's (PC) does not.
    if (url.startsWith(`/api/worktrees/${A}/current-output`) && url.includes('&instance=')) {
      paneCalls += 1;
      return paneCalls === 1 ? json(firstPaneStatus, { error: 'x' }) : json(200, { isRunning: false });
    }
    if (url.startsWith(`/api/worktrees/${A}/current-output`)) return json(200, { isRunning: false });
    if (url.includes('/messages')) return json(200, []);
    if (url.includes('/auto-yes')) return json(200, { instances: {} });
    // The detail read is held: nothing recovers, nothing else answers 401.
    if (url === `/api/worktrees/${A}`) return new Promise<Response>((resolve) => held.push(() => resolve(json(200, {}))));
    return json(200, {});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  held.splice(0);
  cleanup();
  vi.restoreAllMocks();
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
});

function PanePoll() {
  useTerminalPanePolling({ worktreeId: A, cliToolId: 'claude', instanceId: 'claude' });
  return null;
}
function Page() {
  const page = useWorktreeDetailController({ worktreeId: A });
  return (
    <HandoffPageOwnerContext.Provider value={page.handoffOwner}>
      <PanePoll />
    </HandoffPageOwnerContext.Provider>
  );
}

function openingOfA(): void {
  const own = beginHandoffOpening(A, { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' });
  patchHandoffOpening(own.token, { created: 'done', view: HANDOFF_READ_VIEW as unknown as HandoffReadResponse, text: 'the request text' });
}
const dialog = () => document.querySelector('[data-testid="handoff-dialog"]');

describe('[#4345 1c 再指示 1] (d) the first pane poll of a page drawn from the cache is owned', () => {
  it('its 401 expires the session; the host draws nothing', async () => {
    firstPaneStatus = 401;
    openingOfA();
    render(
      <>
        <Page />
        <HandoffDialogHost />
      </>,
    );
    await waitFor(() => expect(paneCalls).toBe(1));
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    expect(paneCalls).toBe(1);
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    expect(dialog()).toBeNull();
  });

  it('(negative control) its 200 leaves the session as it is', async () => {
    firstPaneStatus = 200;
    openingOfA();
    render(
      <>
        <Page />
        <HandoffDialogHost />
      </>,
    );
    await waitFor(() => expect(paneCalls).toBe(1));
    await act(async () => new Promise((done) => setTimeout(done, 20)));
    expect(handoffRegistrySnapshot().authExpired).toBe(false);
    await waitFor(() => expect(dialog()).not.toBeNull());
  });
});
