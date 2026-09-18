/**
 * @vitest-environment jsdom
 */

/**
 * Tests for the What's-new dialog's mount point in AppShell (Issue #2651).
 *
 * AppShell returns from two separate branches (mobile / desktop) and nothing in
 * the type system links them, so a dialog added to one branch only would be
 * invisible on the other half of the devices — the same structural gap #2501
 * closed for the connection banner. These tests pin that both branches mount
 * exactly one instance, next to the version-drift banner it sits beside.
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
vi.mock('@/components/common/WhatsNewDialog', () => ({
  WhatsNewDialog: () => <div data-testid="whats-new-mock" />,
}));

const connectivity = vi.hoisted(() => ({ state: {} as ConnectivityState }));
vi.mock('@/hooks/useConnectivity', () => ({
  useConnectivity: () => connectivity.state,
}));

import { AppShell } from '@/components/layout/AppShell';

function setConnectivity(): void {
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
}

describe("[#2651] AppShell mounts the What's-new dialog", () => {
  beforeEach(() => {
    setConnectivity();
  });

  it.each([
    ['mobile', true],
    ['desktop', false],
  ])('renders exactly one instance on %s, after the version-drift banner', (_name, isMobile) => {
    mockIsMobile.mockReturnValue(isMobile as boolean);

    render(
      <AppShell>
        <div>Content</div>
      </AppShell>
    );

    expect(screen.getAllByTestId('whats-new-mock')).toHaveLength(1);

    const banner = screen.getByTestId('version-mismatch-mock');
    const dialog = screen.getByTestId('whats-new-mock');
    expect(
      banner.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
