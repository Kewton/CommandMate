/**
 * @vitest-environment jsdom
 */

/**
 * The phone's drawer (Issue #3515): the same rows as the PC sidebar (#3512) —
 * close button + logo, New task, search, destinations, the list, the settings
 * menu (#3510) — with the open/close cell drawn as a close button (×) and no
 * keyboard hint. Every top row closes the drawer before it acts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider, useSidebarContext } from '@/contexts/SidebarContext';
import { PcDisplaySizeProvider } from '@/contexts/PcDisplaySizeContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: vi.fn() }),
}));

vi.mock('@/hooks/useAttentionCount', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAttentionCount')>();
  return { ...actual, useAttentionCount: () => ({ count: 0, worktrees: [] }) };
});

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { getAll: vi.fn(async () => ({ worktrees: [], repositories: [] })), getById: vi.fn() },
    repositoryApi: { sync: vi.fn() },
  };
});

const paletteMock = vi.hoisted(() => ({ setOpen: vi.fn() }));
vi.mock('@/contexts/CommandPaletteContext', () => ({
  useCommandPalette: () => ({ open: false, setOpen: paletteMock.setOpen }),
}));

const newTaskMock = vi.hoisted(() => ({ openNewTask: vi.fn() }));
vi.mock('@/contexts/NewTaskContext', () => ({
  useNewTask: () => ({ openNewTask: newTaskMock.openNewTask }),
}));

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

/** Shows the drawer state and opens it, so a test can see a row close it. */
function DrawerProbe() {
  const { isMobileDrawerOpen, openMobileDrawer } = useSidebarContext();
  return (
    <button type="button" data-testid="drawer-probe" data-open={String(isMobileDrawerOpen)} onClick={openMobileDrawer}>
      probe
    </button>
  );
}

function renderSidebar() {
  return render(
    <ToastProvider>
      <PcDisplaySizeProvider>
        <SidebarProvider>
          <WorktreeSelectionProvider>
            <DrawerProbe />
            <Sidebar />
          </WorktreeSelectionProvider>
        </SidebarProvider>
      </PcDisplaySizeProvider>
    </ToastProvider>,
  );
}

function openDrawer(): void {
  fireEvent.click(screen.getByTestId('drawer-probe'));
  expect(screen.getByTestId('drawer-probe')).toHaveAttribute('data-open', 'true');
}

function expectDrawerClosed(): void {
  expect(screen.getByTestId('drawer-probe')).toHaveAttribute('data-open', 'false');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setViewportWidth(390);
});

afterEach(() => {
  setViewportWidth(1024);
});

describe('Sidebar top in the mobile drawer (Issue #3515)', () => {
  it('orders close + logo, New task, search, destinations, the list, then the settings menu', () => {
    renderSidebar();
    const sidebar = screen.getByTestId('sidebar');
    const order = Array.from(
      sidebar.querySelectorAll(
        '[data-testid="sidebar-drawer-close"], [data-testid="sidebar-logo"], [data-testid="sidebar-new-task"], [data-testid="sidebar-search"], [data-testid="sidebar-nav"], [data-testid="branch-list"], [data-testid="sidebar-settings-menu"]',
      ),
    ).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'sidebar-drawer-close',
      'sidebar-logo',
      'sidebar-new-task',
      'sidebar-search',
      'sidebar-nav',
      'branch-list',
      'sidebar-settings-menu',
    ]);
    expect(sidebar.firstElementChild).toBe(screen.getByTestId('sidebar-drawer-top-controls'));
  });

  it('puts the settings menu button (#3510) in the drawer footer', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar-footer')).toContainElement(screen.getByTestId('sidebar-settings-menu'));
  });

  it('draws the open/close cell as a close button that closes the drawer', () => {
    renderSidebar();
    openDrawer();
    const close = screen.getByTestId('sidebar-drawer-close');
    expect(close).toHaveAccessibleName('Close sidebar');
    // It closes the drawer; it does not describe the PC sidebar's state.
    expect(close).not.toHaveAttribute('aria-expanded');
    expect(close.closest('[data-sidebar-toggle-cell]')).not.toBeNull();
    fireEvent.click(close);
    expectDrawerClosed();
  });

  it('shows no keyboard hint on the search row', async () => {
    renderSidebar();
    // The hint is set in an effect on the PC; give it the chance to appear.
    await Promise.resolve();
    expect(screen.getByTestId('sidebar-search').querySelector('kbd')).toBeNull();
  });

  it('closes the drawer, then opens New task / the command palette', () => {
    renderSidebar();
    openDrawer();
    fireEvent.click(screen.getByTestId('sidebar-new-task'));
    expectDrawerClosed();
    expect(newTaskMock.openNewTask).toHaveBeenCalledTimes(1);

    openDrawer();
    fireEvent.click(screen.getByTestId('sidebar-search'));
    expectDrawerClosed();
    expect(paletteMock.setOpen).toHaveBeenCalledWith(true);
  });

  it('closes the drawer from the logo link', () => {
    renderSidebar();
    openDrawer();
    const logo = screen.getByTestId('sidebar-logo');
    expect(logo).toHaveAttribute('href', '/');
    fireEvent.click(logo);
    expectDrawerClosed();
  });
});

describe('Sidebar top on the PC is unchanged (Issue #3515 negative control)', () => {
  it('keeps the panel toggle and the key hint, and has no drawer close button', async () => {
    setViewportWidth(1024);
    renderSidebar();
    expect(screen.getByTestId('sidebar-top-controls')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-panel-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('sidebar-drawer-close')).toBeNull();
    expect(screen.queryByTestId('sidebar-drawer-top-controls')).toBeNull();
    expect(await screen.findAllByText('K')).not.toHaveLength(0);
  });

  it('does not touch the drawer state from New task / search', () => {
    setViewportWidth(1024);
    renderSidebar();
    openDrawer();
    fireEvent.click(screen.getByTestId('sidebar-new-task'));
    fireEvent.click(screen.getByTestId('sidebar-search'));
    expect(screen.getByTestId('drawer-probe')).toHaveAttribute('data-open', 'true');
  });
});
