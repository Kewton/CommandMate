/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for AppShell layout config integration
 * Issue #600: UX refresh - useLayoutConfig flags drive AppShell rendering
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock useLayoutConfig
const mockLayoutConfig = vi.fn(() => ({
  showSidebar: true,
  showGlobalNav: true,
  showLocalNav: false,
  autoCollapseSidebar: false,
}));
vi.mock('@/hooks/useLayoutConfig', () => ({
  useLayoutConfig: () => mockLayoutConfig(),
}));

// Mock useIsMobile
const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
}));

// Mock SidebarContext
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    isMobileDrawerOpen: false,
    closeMobileDrawer: vi.fn(),
    toggle: vi.fn(),
  }),
}));

// Mock Sidebar
vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

// Mock GlobalMobileNav
vi.mock('@/components/mobile/GlobalMobileNav', () => ({
  GlobalMobileNav: () => <div data-testid="global-mobile-nav">GlobalMobileNav</div>,
}));

// Mock Header
vi.mock('@/components/layout/Header', () => ({
  Header: () => <div data-testid="header">Header</div>,
}));

// Mock z-index config
vi.mock('@/config/z-index', () => ({
  Z_INDEX: { SIDEBAR: 30 },
}));

import { AppShell } from '@/components/layout/AppShell';

describe('AppShell with useLayoutConfig', () => {
  it('should render app-shell container', () => {
    render(<AppShell><div>Content</div></AppShell>);
    expect(screen.getByTestId('app-shell')).toBeDefined();
  });

  it('should render children content', () => {
    render(<AppShell><div>Test Content</div></AppShell>);
    expect(screen.getByText('Test Content')).toBeDefined();
  });

  it('should render Header when showGlobalNav is true on desktop', () => {
    mockIsMobile.mockReturnValue(false);
    mockLayoutConfig.mockReturnValue({
      showSidebar: true,
      showGlobalNav: true,
      showLocalNav: false,
      autoCollapseSidebar: false,
    });
    render(<AppShell><div>Content</div></AppShell>);
    expect(screen.getByTestId('header')).toBeDefined();
  });

  it('should render GlobalMobileNav when showGlobalNav is true on mobile', () => {
    mockIsMobile.mockReturnValue(true);
    mockLayoutConfig.mockReturnValue({
      showSidebar: true,
      showGlobalNav: true,
      showLocalNav: false,
      autoCollapseSidebar: false,
    });
    render(<AppShell><div>Content</div></AppShell>);
    expect(screen.getByTestId('global-mobile-nav')).toBeDefined();
  });

  it('should NOT render Header or GlobalMobileNav when showGlobalNav is false', () => {
    mockIsMobile.mockReturnValue(false);
    mockLayoutConfig.mockReturnValue({
      showSidebar: true,
      showGlobalNav: false,
      showLocalNav: true,
      autoCollapseSidebar: false,
    });
    render(<AppShell><div>Content</div></AppShell>);
    expect(screen.queryByTestId('header')).toBeNull();
    expect(screen.queryByTestId('global-mobile-nav')).toBeNull();
  });

  it('should render sidebar when showSidebar is true', () => {
    mockLayoutConfig.mockReturnValue({
      showSidebar: true,
      showGlobalNav: true,
      showLocalNav: false,
      autoCollapseSidebar: false,
    });
    render(<AppShell><div>Content</div></AppShell>);
    expect(screen.getByTestId('sidebar-container')).toBeDefined();
  });
});
