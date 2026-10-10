/**
 * @vitest-environment jsdom
 */

/**
 * The icon rail and Mod+B (Issue #3512).
 *
 * With the real SidebarProvider: a closed PC sidebar leaves the 56px rail in
 * its place (and the content is padded by the rail, not by 0), an open one
 * does not; Mod+B opens and closes it, but not from a text field, the
 * terminal pane, with Shift (the bookmarks bar), or on the phone (#3515).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import React from 'react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
}));

const layout = vi.hoisted(() => ({ showGlobalNav: true }));
vi.mock('@/hooks/useLayoutConfig', () => ({
  useLayoutConfig: () => ({
    showSidebar: true,
    showGlobalNav: layout.showGlobalNav,
    showLocalNav: !layout.showGlobalNav,
    autoCollapseSidebar: false,
  }),
}));

const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  MOBILE_BREAKPOINT: 768,
}));

vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));
vi.mock('@/components/mobile/GlobalMobileNav', () => ({
  GlobalMobileNav: () => <div data-testid="global-mobile-nav" />,
}));
vi.mock('@/components/mobile/MobileConnectionBanner', () => ({
  MobileConnectionBanner: () => null,
}));
vi.mock('@/components/layout/Header', () => ({
  Header: () => <div data-testid="header">Header</div>,
}));
vi.mock('@/components/common/CommandPalette', () => ({
  CommandPalette: () => <div data-testid="command-palette-mock" />,
}));
vi.mock('@/components/common/KeyboardShortcutsOverlay', () => ({
  KeyboardShortcutsOverlay: () => null,
}));
vi.mock('@/components/layout/VersionMismatchBanner', () => ({
  VersionMismatchBanner: () => null,
}));
vi.mock('@/components/common/WhatsNewDialog', () => ({
  WhatsNewDialog: () => null,
}));
vi.mock('@/components/new-task/NewTaskDialogHost', () => ({
  NewTaskDialogHost: () => null,
}));
vi.mock('@/components/layout/RepositoryTabBar', () => ({
  RepositoryTabBar: () => null,
  REPOSITORY_TAB_BAR_HEIGHT: 36,
}));

import { AppShell } from '@/components/layout/AppShell';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { SIDEBAR_RAIL_WIDTH } from '@/lib/sidebar-utils';
import { BranchCheckoutDropdown } from '@/components/worktree/git/BranchCheckoutDropdown';
import type { BranchInfo } from '@/types/git';

function renderShell(initialOpen: boolean, children: React.ReactNode = <div>Content</div>) {
  return render(
    <SidebarProvider initialOpen={initialOpen}>
      <AppShell>{children}</AppShell>
    </SidebarProvider>,
  );
}

function pressModB(target: Window | Element = window, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(target, { key: 'b', code: 'KeyB', metaKey: true, ...init });
}

beforeEach(() => {
  window.localStorage.clear();
  mockIsMobile.mockReturnValue(false);
  layout.showGlobalNav = true;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('icon rail (Issue #3512)', () => {
  it('stands in for the closed sidebar and pads the content by its width', () => {
    renderShell(false);
    expect(screen.getByTestId('sidebar-rail-container')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(screen.getByRole('main').style.paddingLeft).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
  });

  it('is not drawn while the sidebar is open (negative control)', () => {
    renderShell(true);
    expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
    expect(screen.getByRole('main').style.paddingLeft).not.toBe(`${SIDEBAR_RAIL_WIDTH}px`);
  });

  it('takes the sidebar top offset: below the header, or full height without it', () => {
    renderShell(false);
    expect(screen.getByTestId('sidebar-rail-container')).toHaveClass('top-16');
    cleanup();
    layout.showGlobalNav = false;
    renderShell(false);
    expect(screen.getByTestId('sidebar-rail-container')).toHaveClass('top-0', 'h-full');
  });

  it('opens the sidebar from its top cell, which then becomes the sidebar toggle', () => {
    renderShell(false);
    const toggle = screen.getByTestId('sidebar-rail-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
  });

  it('leaves the phone layout alone (#3515)', () => {
    mockIsMobile.mockReturnValue(true);
    renderShell(false);
    expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
  });
});

describe('Mod+B (Issue #3512)', () => {
  it('closes and reopens the PC sidebar', () => {
    renderShell(true);
    pressModB();
    expect(screen.getByTestId('sidebar-rail-container')).toBeInTheDocument();
    pressModB(window, { metaKey: false, ctrlKey: true });
    expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
  });

  it('is left to the browser with Shift (Mod+Shift+B is the bookmarks bar)', () => {
    renderShell(true);
    pressModB(window, { shiftKey: true });
    expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
  });

  it('is left alone in a text field and in the terminal pane', () => {
    renderShell(
      true,
      <>
        <textarea data-testid="composer" />
        <div role="log" tabIndex={0} data-testid="terminal" />
      </>,
    );
    pressModB(screen.getByTestId('composer'));
    pressModB(screen.getByTestId('terminal'));
    expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
  });

  it('does nothing once something earlier claimed the key', () => {
    renderShell(true);
    const event = new KeyboardEvent('keydown', { key: 'b', metaKey: true, cancelable: true, bubbles: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
  });

  it('is not bound on the phone (#3515)', () => {
    mockIsMobile.mockReturnValue(true);
    renderShell(true);
    const event = new KeyboardEvent('keydown', { key: 'b', metaKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  // Review fix: a modal on screen owns the keyboard. The Git checkout
  // confirmation is a plain role="dialog" aria-modal div (no tabindex), which
  // `isAnyModalOpen()` counts since #3563.
  describe('while a modal is on screen', () => {
    const branches: BranchInfo[] = [
      { name: 'main', isCurrent: true, isRemote: false, isDefault: true, upstream: null, aheadBehind: null, checkedOutWorktreePath: null },
      { name: 'feature/x', isCurrent: false, isRemote: false, isDefault: false, upstream: null, aheadBehind: null, checkedOutWorktreePath: null },
    ];

    function renderWithCheckout() {
      renderShell(
        true,
        <BranchCheckoutDropdown
          branches={branches}
          busy={false}
          actionError={null}
          hasRunningSession={false}
          isMobile={false}
          onCheckout={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByTestId('branch-checkout-dropdown-toggle'));
      fireEvent.click(screen.getByRole('menuitem', { name: /feature\/x/ }));
      return screen.getByTestId('branch-checkout-confirm');
    }

    it('does nothing with the checkout confirmation open and its Cancel focused', () => {
      const dialog = renderWithCheckout();
      const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
      cancel.focus();
      expect(document.activeElement).toBe(cancel);

      pressModB(cancel);
      expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
      pressModB(window, { metaKey: false, ctrlKey: true });
      expect(screen.queryByTestId('sidebar-rail-container')).toBeNull();
    });

    it('works again once the confirmation is closed (negative control)', () => {
      const dialog = renderWithCheckout();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('branch-checkout-confirm')).toBeNull();

      pressModB();
      expect(screen.getByTestId('sidebar-rail-container')).toBeInTheDocument();
    });
  });
});
