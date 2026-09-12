/**
 * @vitest-environment jsdom
 */

/**
 * Tests for the connection banner's placement in AppShell (Issue #2501).
 *
 * The bug this closes is structural, not cosmetic: AppShell's mobile branch
 * renders no `Header`, and `Header` was the only mount point for
 * `ConnectionStatusIndicator`, so a phone could not show a connection state at
 * all. These tests pin the mount point and, just as importantly, where in the
 * column it sits — ahead of `<main>`, in flow, so it displaces the page rather
 * than covering the composer or the bottom tab bar (cf. #2271).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
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

const mockIsMobile = vi.fn(() => true);
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

function setConnectivity(over: Partial<ConnectivityState>): void {
  connectivity.state = {
    status: 'online',
    isOnline: true,
    isReconnecting: false,
    isOffline: false,
    shouldSurface: false,
    signals: { browserOnline: true, realtimeStatus: 'connected', serverReachable: true },
    lastReachableAt: null,
    recheck: vi.fn(),
    ...over,
  };
}

const OFFLINE: Partial<ConnectivityState> = {
  status: 'offline',
  isOnline: false,
  isOffline: true,
  shouldSurface: true,
};

describe('AppShell connection banner (mobile)', () => {
  beforeEach(() => {
    mockIsMobile.mockReturnValue(true);
    setConnectivity({});
  });

  it('mounts the banner on mobile, where no Header exists to hold the pill', () => {
    setConnectivity(OFFLINE);
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    expect(screen.queryByTestId('header')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-connection-banner')).toBeInTheDocument();
  });

  it('shows nothing on mobile while the connection is healthy', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    expect(screen.queryByTestId('mobile-connection-banner')).not.toBeInTheDocument();
  });

  it('places the banner ahead of main, so it displaces content rather than covering it', () => {
    setConnectivity(OFFLINE);
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    const banner = screen.getByTestId('mobile-connection-banner');
    const main = screen.getByRole('main');
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves the bottom tab bar untouched', () => {
    setConnectivity(OFFLINE);
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    // The banner is at the top of the column; the nav keeps its own place and
    // the main region keeps the padding that clears it.
    expect(screen.getByTestId('global-mobile-nav')).toBeInTheDocument();
    expect(screen.getByRole('main').className).toMatch(/\bpb-14\b/);
  });

  it('still shows on /worktrees/* where the global nav is hidden', () => {
    // showGlobalNav: false is the terminal screen — the one route with neither a
    // Header nor a GlobalMobileNav, and the one where losing the connection
    // matters most.
    mockLayoutConfig.mockReturnValueOnce({
      showSidebar: true,
      showGlobalNav: false,
      showLocalNav: true,
      autoCollapseSidebar: false,
    });
    setConnectivity(OFFLINE);
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('mobile-connection-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('global-mobile-nav')).not.toBeInTheDocument();
  });

  it('does not duplicate the banner on desktop, which has the header pill', () => {
    mockIsMobile.mockReturnValue(false);
    setConnectivity(OFFLINE);
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getByTestId('header')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-connection-banner')).not.toBeInTheDocument();
  });
});
