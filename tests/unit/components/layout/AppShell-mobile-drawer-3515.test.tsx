/**
 * @vitest-environment jsdom
 */

/**
 * The phone's drawer inside AppShell (Issue #3515).
 *
 * - opened from the bottom tab bar's "Branches" (#2642, kept), closed by the
 *   drawer's own close button (×) and by the overlay (kept);
 * - the bottom tab bar steps aside while the drawer is open, and the drawer
 *   pads itself by the safe-area insets, so its settings button is covered by
 *   neither the tab bar nor the home indicator (#2642);
 * - the PC branch draws none of it (negative control).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => true),
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn().mockResolvedValue({ worktrees: [], repositories: [] }),
      getById: vi.fn(),
    },
  };
});

import { useIsMobile } from '@/hooks/useIsMobile';

function renderShell() {
  return render(
    <SidebarProvider>
      <WorktreeSelectionProvider>
        <AppShell>
          <div>Content</div>
        </AppShell>
      </WorktreeSelectionProvider>
    </SidebarProvider>,
  );
}

function openFromTabBar(): void {
  fireEvent.click(screen.getByTestId('mobile-nav-open-sidebar'));
  expect(screen.getByTestId('drawer-overlay')).toBeInTheDocument();
  expect(screen.getByTestId('sidebar-container').className).toContain('translate-x-0');
}

function expectClosed(): void {
  expect(screen.queryByTestId('drawer-overlay')).toBeNull();
  expect(screen.getByTestId('sidebar-container').className).toContain('-translate-x-full');
  expect(screen.getByTestId('global-mobile-nav')).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

describe('AppShell mobile drawer (Issue #3515)', () => {
  it('keeps "Branches" in the bottom tab bar as the way in', () => {
    renderShell();
    expect(screen.getByTestId('mobile-nav-open-sidebar')).toHaveTextContent('Branches');
  });

  it('closes from the close button at the top of the drawer', () => {
    renderShell();
    openFromTabBar();
    const drawer = screen.getByTestId('sidebar-container');
    fireEvent.click(within(drawer).getByTestId('sidebar-drawer-close'));
    expectClosed();
  });

  it('still closes from the overlay', () => {
    renderShell();
    openFromTabBar();
    fireEvent.click(screen.getByTestId('drawer-overlay'));
    expectClosed();
  });

  it('is not covered by the bottom tab bar or the home indicator', () => {
    renderShell();
    openFromTabBar();
    // The tab bar steps aside (#2642) ...
    expect(screen.queryByTestId('global-mobile-nav')).toBeNull();
    const drawer = screen.getByTestId('sidebar-container');
    // ... and the drawer clears the insets itself, on its own background.
    expect(drawer.className).toMatch(/(^|\s)pb-safe(\s|$)/);
    expect(drawer.className).toMatch(/(^|\s)pt-safe(\s|$)/);
    expect(drawer.className).toMatch(/(^|\s)bg-sidebar(\s|$)/);
    expect(within(drawer).getByTestId('sidebar-footer')).toContainElement(
      within(drawer).getByTestId('sidebar-settings-menu'),
    );
  });

  it('leaves room for the overlay on a narrow phone', () => {
    renderShell();
    expect(screen.getByTestId('sidebar-container').className).toContain('max-w-[85vw]');
  });
});

describe('AppShell PC sidebar is unchanged (Issue #3515 negative control)', () => {
  it('draws no drawer close button and no safe-area padding', () => {
    (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(false);
    renderShell();
    const sidebar = screen.getByTestId('sidebar-container');
    expect(within(sidebar).queryByTestId('sidebar-drawer-close')).toBeNull();
    expect(within(sidebar).getByTestId('sidebar-panel-toggle')).toBeInTheDocument();
    expect(sidebar.className).not.toMatch(/pb-safe|pt-safe|max-w-\[85vw\]/);
  });
});
