/**
 * @vitest-environment jsdom
 */

/**
 * Focus after a dialog opened from the phone's drawer closes (Issue #3515).
 *
 * New task and search close the drawer before they open the New task dialog /
 * the command palette. Both of those remember "where focus was" when they open
 * and return it there on close — which, left alone, is the drawer button the
 * user tapped, now inside a closed, off-screen drawer. AppShell hands focus to
 * the opener on screen as the drawer closes, so it comes back there.
 *
 * The real dialog, the real palette and the real providers are mounted;
 * nothing that opens or closes them is mocked. Negative control: the PC
 * sidebar's rows keep returning focus to themselves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { SidebarProvider, useSidebarContext } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext';
import { ToastProvider } from '@/components/common/Toast';
import { MOBILE_DRAWER_OPENER_PROPS } from '@/components/mobile/mobile-drawer-opener';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const nav = vi.hoisted(() => ({ pathname: '/sessions' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => nav.pathname,
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
      ...actual.worktreeApi,
      getAll: vi.fn().mockResolvedValue({ worktrees: [], repositories: [] }),
      getById: vi.fn(),
    },
  };
});

import { useIsMobile } from '@/hooks/useIsMobile';

/** Stands in for the worktree header's ☰ (MobileHeader carries the same props). */
function HeaderMenuButton() {
  const { openMobileDrawer } = useSidebarContext();
  return (
    <button type="button" data-testid="test-header-menu" {...MOBILE_DRAWER_OPENER_PROPS} onClick={openMobileDrawer}>
      menu
    </button>
  );
}

function renderShell(children: React.ReactNode = <div>Content</div>) {
  return render(
    <ToastProvider>
      <CommandPaletteProvider>
        <SidebarProvider>
          <WorktreeSelectionProvider>
            <AppShell>{children}</AppShell>
          </WorktreeSelectionProvider>
        </SidebarProvider>
      </CommandPaletteProvider>
    </ToastProvider>,
  );
}

/** Tap a drawer row the way a browser does: focus lands on it, then click. */
function tap(el: HTMLElement): void {
  act(() => el.focus());
  fireEvent.click(el);
}

function drawerRow(testId: string): HTMLElement {
  return within(screen.getByTestId('sidebar-container')).getByTestId(testId);
}

async function cancelNewTask(): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
}

function escapePalette(): void {
  expect(screen.getByTestId('command-palette')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByTestId('command-palette')).toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // jsdom has no layout; the palette scrolls its active row into view.
  Element.prototype.scrollIntoView = vi.fn();
  nav.pathname = '/sessions';
  (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

describe('focus after a dialog opened from the mobile drawer (Issue #3515)', () => {
  it('New task → Cancel returns focus to "Branches", not into the closed drawer', async () => {
    renderShell();
    tap(screen.getByTestId('mobile-nav-open-sidebar'));
    tap(drawerRow('sidebar-new-task'));
    await cancelNewTask();
    expect(document.activeElement).toBe(screen.getByTestId('mobile-nav-open-sidebar'));
  });

  it('search → Esc returns focus to "Branches", not into the closed drawer', () => {
    renderShell();
    tap(screen.getByTestId('mobile-nav-open-sidebar'));
    tap(drawerRow('sidebar-search'));
    escapePalette();
    expect(document.activeElement).toBe(screen.getByTestId('mobile-nav-open-sidebar'));
  });

  it('on a worktree screen, returns focus to the header ☰', async () => {
    nav.pathname = '/worktrees/wt-1';
    renderShell(<HeaderMenuButton />);
    expect(screen.queryByTestId('global-mobile-nav')).toBeNull();
    tap(screen.getByTestId('test-header-menu'));
    tap(drawerRow('sidebar-new-task'));
    await cancelNewTask();
    expect(document.activeElement).toBe(screen.getByTestId('test-header-menu'));
  });

  it('the drawer close button also hands focus to the opener', () => {
    renderShell();
    tap(screen.getByTestId('mobile-nav-open-sidebar'));
    tap(drawerRow('sidebar-drawer-close'));
    expect(document.activeElement).toBe(screen.getByTestId('mobile-nav-open-sidebar'));
  });
});

describe('focus after a dialog opened from the PC sidebar is unchanged (negative control)', () => {
  beforeEach(() => {
    (useIsMobile as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('New task → Cancel returns focus to the New task row', async () => {
    renderShell();
    const row = drawerRow('sidebar-new-task');
    tap(row);
    await cancelNewTask();
    expect(document.activeElement).toBe(row);
  });

  it('search → Esc returns focus to the search row', () => {
    renderShell();
    const row = drawerRow('sidebar-search');
    tap(row);
    escapePalette();
    expect(document.activeElement).toBe(row);
  });
});
