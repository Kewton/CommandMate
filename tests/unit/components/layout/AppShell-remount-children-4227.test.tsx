/**
 * @vitest-environment jsdom
 */

/**
 * G10 (Issue #4227, design `mem-ui-4227.md` §4.1.1): why the hand-off dialog closed on the real
 * page at the PC ↔ phone switch while the component test "path 6" passed. AppShell draws its
 * children under another parent per layout, so the page under it (the worktree page and its
 * `useWorktreeDetailController`) is mounted anew: every React state of the page — the hand-off's
 * `handoffTarget` among them — starts again. This pins that fact (the page cannot keep the dialog
 * open by its own state over the switch), so the page takes the store's opening back on mount
 * (`useWorktreeDetailController-handoff-remount-4227.test.tsx`).
 *
 * If AppShell ever keeps its children mounted over the switch, this test fails: then read §4.1.1
 * again (the taking back stays harmless, but the reason given there changes).
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import React, { useEffect } from 'react';
import type { ConnectivityState } from '@/hooks/useConnectivity';

const mockLayoutConfig = vi.fn(() => ({
  showSidebar: true,
  showGlobalNav: true,
  showLocalNav: false,
  autoCollapseSidebar: false,
}));
vi.mock('@/hooks/useLayoutConfig', () => ({
  useLayoutConfig: () => mockLayoutConfig(),
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

const connectivity = vi.hoisted(() => ({ state: {} as ConnectivityState }));
vi.mock('@/hooks/useConnectivity', () => ({
  useConnectivity: () => connectivity.state,
}));

import { AppShell } from '@/components/layout/AppShell';

const counts = { mounts: 0 };
function Page() {
  useEffect(() => {
    counts.mounts += 1;
  }, []);
  return <div data-testid="page">page</div>;
}

describe('[#4227 G10] AppShell mounts its children anew when the layout switches', () => {
  it('PC → phone → PC mounts the page three times', () => {
    connectivity.state = {
      status: 'online',
      isOnline: true,
      isReconnecting: false,
      isOffline: false,
      shouldSurface: false,
      signals: { browserOnline: true, realtimeStatus: 'connected', serverReachable: true },
      lastReachableAt: null,
      recheck: vi.fn(),
    } as unknown as ConnectivityState;
    counts.mounts = 0;
    mockIsMobile.mockReturnValue(false);
    const view = render(
      <AppShell>
        <Page />
      </AppShell>
    );
    expect(counts.mounts).toBe(1);
    mockIsMobile.mockReturnValue(true);
    view.rerender(
      <AppShell>
        <Page />
      </AppShell>
    );
    expect(counts.mounts).toBe(2);
    mockIsMobile.mockReturnValue(false);
    view.rerender(
      <AppShell>
        <Page />
      </AppShell>
    );
    expect(counts.mounts).toBe(3);
  });
});
