/**
 * @vitest-environment jsdom
 */

/**
 * The phone's drawer openers carry `data-mobile-drawer-opener` (Issue #3515),
 * so AppShell can hand focus back to them when the drawer closes.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MobileHeader } from '@/components/mobile/MobileHeader';
import { GlobalMobileNav } from '@/components/mobile/GlobalMobileNav';
import { SidebarProvider } from '@/contexts/SidebarContext';
import {
  MOBILE_DRAWER_OPENER_ATTR,
  focusMobileDrawerOpener,
} from '@/components/mobile/mobile-drawer-opener';

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('mobile drawer openers (Issue #3515)', () => {
  it('marks the worktree header ☰', () => {
    render(<MobileHeader worktreeName="main" status="idle" onMenuClick={vi.fn()} />);
    expect(screen.getByTestId('mobile-header-menu-button')).toHaveAttribute(MOBILE_DRAWER_OPENER_ATTR);
  });

  it('marks the bottom tab bar "Branches"', () => {
    render(
      <SidebarProvider>
        <GlobalMobileNav />
      </SidebarProvider>,
    );
    expect(screen.getByTestId('mobile-nav-open-sidebar')).toHaveAttribute(MOBILE_DRAWER_OPENER_ATTR);
  });

  it('focusMobileDrawerOpener focuses the opener, and reports when there is none', () => {
    const { unmount } = render(<MobileHeader worktreeName="main" status="idle" onMenuClick={vi.fn()} />);
    expect(focusMobileDrawerOpener()).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('mobile-header-menu-button'));
    unmount();
    expect(focusMobileDrawerOpener()).toBe(false);
  });
});
