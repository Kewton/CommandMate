/**
 * @vitest-environment jsdom
 */

/**
 * The global Header after Issue #3512: the screen's name plus the connection
 * status and the app update button. Issue #3579: a screen that names itself
 * in its own <h1> (SCREEN_TITLE_KEYS) gets no second name here; only `/` keeps
 * the title fallback. Navigation, ⌘K, display size, tab-strip
 * mode, theme and GitHub moved to the sidebar / icon rail / SettingsMenu.
 * The two status controls keep their own visibility rules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { ConnectivityState } from '@/hooks/useConnectivity';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const pathMock = vi.hoisted(() => ({ pathname: '/sessions' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathMock.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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

const mockUseAppUpdate = vi.fn();
vi.mock('@/contexts/AppUpdateContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AppUpdateContext')>()),
  useAppUpdate: () => mockUseAppUpdate(),
}));

import { Header, resolveScreenTitleKey } from '@/components/layout/Header';
import { makeAppUpdateValue, makeUpdateInfo } from '@tests/helpers/app-update-context';

beforeEach(() => {
  pathMock.pathname = '/sessions';
  connectivity.shouldSurface = false;
  mockUseAppUpdate.mockReturnValue(makeAppUpdateValue());
});

describe('Header is the screen name and its state (Issue #3512)', () => {
  // Issue #3579: the list screens' name is the page's own <h1>; the header
  // must not repeat it (it would be the screen name twice).
  it('shows the name of the screen it is on', () => {
    for (const pathname of ['/sessions', '/repositories', '/review', '/skills', '/more']) {
      pathMock.pathname = pathname;
      const { unmount } = render(<Header />);
      expect(screen.queryByTestId('header-screen-title')).toBeNull();
      expect(screen.queryByRole('heading')).toBeNull();
      unmount();
    }
  });

  it.each([
    ['/sessions', 'nav.sessions'],
    ['/repositories', 'nav.repositories'],
    ['/review', 'nav.review'],
    ['/skills', 'nav.skills'],
    ['/more', 'nav.more'],
    ['/', null],
  ])('resolves %s to %s', (pathname, key) => {
    expect(resolveScreenTitleKey(pathname)).toBe(key);
  });

  it('falls back to the title prop where the screen has no name (/)', () => {
    pathMock.pathname = '/';
    render(<Header />);
    expect(screen.getByTestId('header-screen-title')).toHaveTextContent('CommandMate');
  });

  it('no longer carries the moved entries', () => {
    render(<Header />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByTestId('header-command-palette-trigger')).toBeNull();
    expect(screen.queryByTestId('pc-display-size-select')).toBeNull();
    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.queryByRole('button', { name: /theme/i })).toBeNull();
  });

  // Issue #3579: nothing measures against the header any more (the sidebar
  // starts at the top of the screen); the row has no fixed height and
  // collapses while it has nothing to show.
  it('keeps the h-16 row the sidebar offset (#1070) is measured against', () => {
    const { container } = render(<Header />);
    const header = container.querySelector('header') as HTMLElement;
    expect(container.querySelector('header .h-16')).toBeNull();
    expect(header).not.toHaveClass('h-16');
    expect(header).not.toHaveClass('sticky');
    expect(header).toHaveClass('empty:hidden');
    expect(header.childNodes).toHaveLength(0);
  });

  it('shows nothing for connection or update while connected and up to date (negative control)', () => {
    render(<Header />);
    expect(screen.queryByTestId('connection-status-indicator')).toBeNull();
    expect(screen.queryByTestId('app-update-button')).toBeNull();
  });

  it('still shows the connection status while the live connection is down', () => {
    connectivity.shouldSurface = true;
    render(<Header />);
    expect(screen.getByTestId('connection-status-indicator')).toBeInTheDocument();
  });

  it('still shows the update button while an update is available', () => {
    mockUseAppUpdate.mockReturnValue(makeAppUpdateValue({ updateInfo: makeUpdateInfo() }));
    render(<Header />);
    expect(screen.getByTestId('app-update-button')).toBeInTheDocument();
  });
});
