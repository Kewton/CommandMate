/**
 * @vitest-environment jsdom
 */

/**
 * No full-width header band on the list screens (Issue #3579).
 *
 * Before: the global Header was a 64px band across the whole width, and the
 * sidebar / icon rail started under it (`top-16`), so the open/close button sat
 * 64px lower on /sessions than on /worktrees/*, and the screen name appeared
 * twice (band + the page's own <h1>).
 *
 * After: the sidebar / icon rail start at the top of the screen on every route,
 * under every repository-tab mode and display size. The tab strip and the
 * status row (connection + app update, no screen name) live at the top of the
 * content column, inside <main>, so they follow the sidebar width (including a
 * live drag) instead of offsetting the fixed columns. jsdom has no layout, so
 * positions are checked through what decides them: classes, inline top, and
 * which ancestor holds what.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import type { ConnectivityState } from '@/hooks/useConnectivity';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const route = vi.hoisted(() => ({ pathname: '/sessions' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

const device = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => device.mobile,
  MOBILE_BREAKPOINT: 768,
}));

const size = vi.hoisted(() => ({ factor: 1 }));
vi.mock('@/contexts/PcDisplaySizeContext', () => ({
  usePcDisplaySizeContext: () => ({
    size: 'medium',
    setSize: vi.fn(),
    isMobile: false,
    factor: size.factor,
    isAvailable: true,
  }),
}));

const connectivity = vi.hoisted(() => ({ shouldSurface: false }));
vi.mock('@/hooks/useConnectivity', () => ({
  useConnectivity: () =>
    ({
      status: connectivity.shouldSurface ? 'offline' : 'online',
      isOnline: !connectivity.shouldSurface,
      isReconnecting: false,
      isOffline: connectivity.shouldSurface,
      shouldSurface: connectivity.shouldSurface,
      signals: { browserOnline: true, realtimeStatus: 'connected', serverReachable: true },
      lastReachableAt: null,
      recheck: vi.fn(),
    }) as unknown as ConnectivityState,
  reportServerReachability: vi.fn(),
}));

vi.mock('@/components/layout/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));
vi.mock('@/components/layout/SidebarRail', () => ({
  SidebarRail: () => <div data-testid="sidebar-rail" />,
}));
vi.mock('@/components/layout/RepositoryTabBar', () => ({
  RepositoryTabBar: () => <div data-testid="repository-tab-bar" />,
  REPOSITORY_TAB_BAR_HEIGHT: 32,
}));
vi.mock('@/components/mobile/GlobalMobileNav', () => ({
  GlobalMobileNav: () => <nav data-testid="global-mobile-nav" />,
}));
vi.mock('@/components/mobile/MobileConnectionBanner', () => ({
  MobileConnectionBanner: () => <div data-testid="mobile-connection-banner" />,
}));
vi.mock('@/components/common/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/common/KeyboardShortcutsOverlay', () => ({ KeyboardShortcutsOverlay: () => null }));
vi.mock('@/components/layout/VersionMismatchBanner', () => ({ VersionMismatchBanner: () => null }));
vi.mock('@/components/common/WhatsNewDialog', () => ({ WhatsNewDialog: () => null }));
vi.mock('@/components/new-task/NewTaskDialogHost', () => ({ NewTaskDialogHost: () => null }));

import { AppShell } from '@/components/layout/AppShell';
import { SidebarProvider, useSidebarContext, REPO_TAB_BAR_MODE_STORAGE_KEY } from '@/contexts/SidebarContext';
import { SIDEBAR_RAIL_WIDTH, type RepoTabBarMode } from '@/lib/sidebar-utils';

const MODES: RepoTabBarMode[] = ['collapsed', 'always', 'hidden'];

function Toggle() {
  const { toggle } = useSidebarContext();
  return <button data-testid="test-toggle" onClick={toggle} />;
}

function renderShell(initialOpen: boolean) {
  return render(
    <SidebarProvider initialOpen={initialOpen}>
      <AppShell>
        <div data-testid="page">
          <h1>Sessions</h1>
          <Toggle />
        </div>
      </AppShell>
    </SidebarProvider>,
  );
}

/** What places a fixed column: its top/height classes and inline top/height. */
function columnPlacement(testId: string) {
  const aside = screen.getByTestId(testId);
  return {
    classes: Array.from(aside.classList).filter((c) => /^top-|^h-/.test(c)).sort(),
    inlineTop: aside.style.top,
    inlineHeight: aside.style.height,
  };
}

const AT_TOP = { classes: ['h-full', 'top-0'], inlineTop: '', inlineHeight: '' };

beforeEach(() => {
  window.localStorage.clear();
  route.pathname = '/sessions';
  device.mobile = false;
  size.factor = 1;
  connectivity.shouldSurface = false;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('sidebar and icon rail start at the top of the screen (Issue #3579)', () => {
  // Positive control: before the fix both were `top-16` (and pushed further by
  // an "always" band) on the list screens.
  describe.each(['/sessions', '/repositories', '/review', '/worktrees/wt-1'])('on %s', (pathname) => {
    it.each(MODES)('open sidebar and icon rail are at the top in "%s" mode', (mode) => {
      route.pathname = pathname;
      window.localStorage.setItem(REPO_TAB_BAR_MODE_STORAGE_KEY, mode);
      renderShell(true);
      expect(columnPlacement('sidebar-container')).toEqual(AT_TOP);
      fireEvent.click(screen.getByTestId('test-toggle'));
      expect(columnPlacement('sidebar-rail-container')).toEqual(AT_TOP);
      expect(columnPlacement('sidebar-container')).toEqual(AT_TOP);
    });
  });

  it.each([0.875, 1, 1.25])('does not move with the display size (factor %s)', (factor) => {
    size.factor = factor;
    window.localStorage.setItem(REPO_TAB_BAR_MODE_STORAGE_KEY, 'always');
    renderShell(false);
    expect(columnPlacement('sidebar-rail-container')).toEqual(AT_TOP);
    expect(columnPlacement('sidebar-container')).toEqual(AT_TOP);
  });

  it('places the list screen and the worktree screen columns identically', () => {
    renderShell(false);
    const list = columnPlacement('sidebar-rail-container');
    cleanup();
    route.pathname = '/worktrees/wt-1';
    renderShell(false);
    expect(columnPlacement('sidebar-rail-container')).toEqual(list);
  });
});

describe('tab strip and status row sit in the content column (Issue #3579)', () => {
  it.each<[RepoTabBarMode, boolean]>([
    ['collapsed', false],
    ['always', true],
    ['always', false],
  ])('the "%s" band (sidebar open: %s) is the first thing in <main>, above the status row', (mode, open) => {
    window.localStorage.setItem(REPO_TAB_BAR_MODE_STORAGE_KEY, mode);
    renderShell(open);
    const main = screen.getByRole('main');
    const band = screen.getByTestId('repository-tab-bar');
    const header = screen.getByTestId('screen-status-row');
    expect(main.contains(band)).toBe(true);
    expect(main.contains(header)).toBe(true);
    expect(main.firstElementChild?.contains(band)).toBe(true);
    expect(band.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    // Offset sideways by <main>'s own padding (which the drag handle writes),
    // never by a px margin or top of its own.
    for (let el: HTMLElement | null = band; el && el !== main; el = el.parentElement) {
      expect(el.style.marginLeft).toBe('');
      expect(el.style.top).toBe('');
    }
    expect(main.style.paddingLeft).not.toBe('0px');
  });

  it('pads the content by the rail with the sidebar closed, and the band rides on it', () => {
    renderShell(false);
    expect(screen.getByRole('main').style.paddingLeft).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
    expect(screen.getByRole('main').contains(screen.getByTestId('repository-tab-bar'))).toBe(true);
  });

  it('keeps the page in a column that takes the rest of the height', () => {
    renderShell(true);
    const main = screen.getByRole('main');
    const page = screen.getByTestId('page');
    expect(main).toHaveClass('flex', 'flex-col');
    const content = page.parentElement as HTMLElement;
    expect(content.parentElement).toBe(main);
    expect(content).toHaveClass('flex-1', 'min-h-0');
  });

  it('has no status row on the worktree screen (unchanged condition)', () => {
    route.pathname = '/worktrees/wt-1';
    renderShell(true);
    expect(screen.queryByTestId('screen-status-row')).toBeNull();
  });
});

describe('screen name appears once (Issue #3579)', () => {
  it('leaves the only <h1> to the page', () => {
    renderShell(true);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByTestId('page').contains(screen.getByRole('heading', { level: 1 }))).toBe(true);
  });

  it('keeps the fallback title on / (no name of its own), once (negative control)', () => {
    route.pathname = '/';
    render(
      <SidebarProvider initialOpen>
        <AppShell>
          <div />
        </AppShell>
      </SidebarProvider>,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByTestId('screen-status-row')).toContainElement(screen.getByTestId('header-screen-title'));
  });

  it('shows the connection status on a list screen while it is down', () => {
    connectivity.shouldSurface = true;
    renderShell(true);
    const row = screen.getByTestId('screen-status-row');
    expect(row.contains(screen.getByTestId('connection-status-indicator'))).toBe(true);
  });
});

describe('phone layout is unchanged (Issue #3579, negative control)', () => {
  it('draws no tab strip and no status row, and keeps the drawer full height', () => {
    device.mobile = true;
    renderShell(false);
    expect(screen.queryByTestId('repository-tab-bar')).toBeNull();
    expect(screen.queryByTestId('screen-status-row')).toBeNull();
    expect(screen.getByTestId('sidebar-container')).toHaveClass('top-0', 'h-full');
    expect(screen.getByTestId('global-mobile-nav')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('pb-nav-safe');
  });
});
