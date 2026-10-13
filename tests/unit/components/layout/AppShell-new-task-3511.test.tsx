/**
 * @vitest-environment jsdom
 */

/**
 * New task from the list screens (Issue #3511).
 *
 * AppShell returns from two branches (mobile / desktop) and the dialog has to
 * be reachable from both, the gap #2501 and #2651 closed for their own mounts.
 * Here AppShell wraps a list screen's content: the chord opens the real
 * dialog, which starts on the last destination sent to, sends, and navigates
 * to that branch with the instance selected. A button inside the screen opens
 * it through `openNewTask()` — the entry point #3512's navigation buttons call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { ConnectivityState } from '@/hooks/useConnectivity';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useLayoutConfig', () => ({
  useLayoutConfig: () => ({
    showSidebar: true,
    showGlobalNav: true,
    showLocalNav: false,
    autoCollapseSidebar: false,
  }),
}));

const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    isMobileDrawerOpen: false,
    closeMobileDrawer: vi.fn(),
    toggle: vi.fn(),
    width: 256,
    setWidth: vi.fn(),
  }),
}));

vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));
vi.mock('@/components/mobile/GlobalMobileNav', () => ({
  GlobalMobileNav: () => <div data-testid="global-mobile-nav">GlobalMobileNav</div>,
}));
vi.mock('@/components/layout/Header', () => ({
  Header: () => <div data-testid="header">Header</div>,
}));
vi.mock('@/components/common/CommandPalette', () => ({
  CommandPalette: () => <div data-testid="command-palette-mock" />,
}));
vi.mock('@/components/common/KeyboardShortcutsOverlay', () => ({
  KeyboardShortcutsOverlay: () => <div data-testid="keyboard-shortcuts-mock" />,
}));
vi.mock('@/components/layout/VersionMismatchBanner', () => ({
  VersionMismatchBanner: () => <div data-testid="version-mismatch-mock" />,
}));
vi.mock('@/components/common/WhatsNewDialog', () => ({
  WhatsNewDialog: () => <div data-testid="whats-new-mock" />,
}));

const connectivity = vi.hoisted(() => ({ state: {} as ConnectivityState }));
vi.mock('@/hooks/useConnectivity', () => ({
  useConnectivity: () => connectivity.state,
  reportServerReachability: vi.fn(),
}));

import { AppShell } from '@/components/layout/AppShell';
import { ToastProvider } from '@/components/common/Toast';
import { useNewTask } from '@/contexts/NewTaskContext';
import { pushRecentTarget } from '@/lib/new-task/recent-targets';
import { buildRepositories, buildWorktrees, jsonResponse } from '../../lib/new-task/new-task-fixtures';

const sendCalls: Array<{ url: string; body: unknown }> = [];

function ListScreen() {
  const { openNewTask } = useNewTask();
  return (
    <button type="button" data-testid="screen-new-task" onClick={() => openNewTask()}>
      New task
    </button>
  );
}

function renderShell() {
  return render(
    <ToastProvider>
      <AppShell>
        <ListScreen />
      </AppShell>
    </ToastProvider>,
  );
}

beforeEach(() => {
  connectivity.state = {
    status: 'online',
    isOnline: true,
    isReconnecting: false,
    isOffline: false,
    shouldSurface: false,
    signals: { browserOnline: true, realtimeStatus: 'connected', serverReachable: true },
    lastReachableAt: null,
    recheck: vi.fn(),
  };
  window.localStorage.clear();
  nav.push.mockClear();
  sendCalls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/worktrees') {
        return jsonResponse({ worktrees: buildWorktrees(), repositories: buildRepositories() });
      }
      if (url.endsWith('/send')) {
        sendCalls.push({ url, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ id: 'm1' }, 201);
      }
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('[#3511] AppShell mounts New task on the list screens', () => {
  it.each([
    ['desktop', false],
    ['mobile', true],
  ])('%s: the chord opens it on the last destination, and a send lands on that instance', async (_name, isMobile) => {
    mockIsMobile.mockReturnValue(isMobile as boolean);
    pushRecentTarget({ worktreeId: 'wt-a-main', instanceId: 'codex-2' });
    renderShell();

    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'O', code: 'KeyO', metaKey: true, shiftKey: true });

    const textarea = await screen.findByTestId('new-task-message');
    expect(screen.getByTestId('new-task-branch')).toHaveValue('wt-a-main');
    expect(screen.getByTestId('new-task-agent')).toHaveValue('codex-2');

    fireEvent.change(textarea, { target: { value: 'Summarize the open PRs' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/worktrees/wt-a-main?instance=codex-2'));
    expect(sendCalls).toEqual([
      {
        url: '/api/worktrees/wt-a-main/send',
        body: { content: 'Summarize the open PRs', cliToolId: 'codex', instanceId: 'codex-2' },
      },
    ]);
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
  });

  it('opens through openNewTask() from inside the screen', async () => {
    renderShell();
    fireEvent.click(screen.getByTestId('screen-new-task'));
    expect(await screen.findByTestId('new-task-message')).toBeInTheDocument();
  });

  it('does not open on the chords other features own (negative control)', () => {
    renderShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(window, { key: 'M', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.queryByTestId('new-task-dialog')).toBeNull();
  });
});
