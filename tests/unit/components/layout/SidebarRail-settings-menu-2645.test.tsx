/**
 * Settings menu at the bottom of the icon rail (Issue #2645 → #3512)
 *
 * These were the ActivityBar gear's tests (ActivityBar.test.tsx, "Settings
 * menu (Issue #2645)"). #3512 removed that gear: on the PC worktree screen the
 * shared `SettingsMenu` is in the sidebar footer when the sidebar is open and
 * at the bottom of the icon rail when it is closed. The same intents are
 * pinned here on the rail's gear, one `it` per original `it`.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { SidebarRail } from '@/components/layout/SidebarRail';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { AuthProvider } from '@/contexts/AuthContext';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const sidebarMock = vi.hoisted(() => ({ isOpen: false, toggle: vi.fn() }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({ isOpen: sidebarMock.isOpen, toggle: sidebarMock.toggle }),
  useOptionalSidebarContext: () => null,
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/worktrees/wt-1',
}));

const themeMock = vi.hoisted(() => ({ theme: 'dark' as string | undefined, setTheme: vi.fn() }));
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: themeMock.theme, setTheme: themeMock.setTheme }),
}));

const localeMock = vi.hoisted(() => ({ switchLocale: vi.fn() }));
vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: localeMock.switchLocale }),
}));

const settingsDialogMock = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('@/contexts/SettingsDialogContext', () => ({
  useSettingsDialog: () => ({ isOpen: false, open: settingsDialogMock.open, close: settingsDialogMock.close }),
}));

vi.mock('@/hooks/useAttentionCount', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAttentionCount')>();
  return { ...actual, useAttentionCount: () => ({ count: 0, worktrees: [] }) };
});

beforeEach(() => {
  vi.clearAllMocks();
  sidebarMock.isOpen = false;
  themeMock.theme = 'dark';
});

describe('Settings menu (Issue #2645, moved from the ActivityBar gear by #3512)', () => {
  beforeAll(() => installRadixJsdomPolyfills());
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the settings gear button outside tablist at the bottom', () => {
    // The rail has no tablist; the intent kept from #2645 is "a labelled
    // menu button, after every navigation entry, pinned to the bottom".
    render(<SidebarRail />);
    const button = screen.getByTestId('sidebar-rail-settings');
    expect(button).toHaveAttribute('aria-label', 'Settings');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button.querySelector('svg.lucide-settings')).not.toBeNull();

    const review = screen.getByTestId('sidebar-rail-review');
    expect(review.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const mtAuto = button.closest('.mt-auto');
    expect(mtAuto).not.toBeNull();
    expect(screen.getByTestId('sidebar-rail').lastElementChild).toBe(mtAuto);
  });

  it('opens the dropdown menu with items, radios, and default checked states', () => {
    render(<SidebarRail />);
    const button = screen.getByTestId('sidebar-rail-settings');
    fireEvent.keyDown(button, { key: 'Enter' });

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');

    const menuitems = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(menuitems).toEqual(['Settings', 'Skills', 'GitHub']);

    // The rail passes `showDisplayPreferences`, so the display sizes follow
    // theme and language (the repository-tab modes need a SidebarProvider,
    // which this file stubs out; SettingsMenu-3510 covers them).
    const radios = screen.getAllByRole('menuitemradio').map((el) => el.textContent);
    expect(radios).toEqual(['Light', 'Dark', 'System', 'English', '日本語', 'Large', 'Medium', 'Small', 'Extra small']);

    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByRole('menuitemradio', { name: 'English' })).toHaveAttribute('data-state', 'checked');
  });

  it('marks System as checked when theme is undefined', () => {
    themeMock.theme = undefined;
    render(<SidebarRail />);
    fireEvent.keyDown(screen.getByTestId('sidebar-rail-settings'), { key: 'Enter' });

    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('data-state', 'checked');
  });

  it('displays the app version when NEXT_PUBLIC_APP_VERSION is set', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '9.9.9');
    render(<SidebarRail />);
    fireEvent.keyDown(screen.getByTestId('sidebar-rail-settings'), { key: 'Enter' });

    expect(screen.getByTestId('sidebar-rail-settings-version')).toHaveTextContent('CommandMate v9.9.9');
  });

  it('handles navigation, theme change, locale change, and external link without triggering onToggle or toggleSidebar', async () => {
    render(<SidebarRail />);
    const button = screen.getByTestId('sidebar-rail-settings');
    const openMenu = () => {
      fireEvent.keyDown(button, { key: 'Enter' });
    };

    // Settings (Issue #2709: opens the modal, does not navigate).
    // Radix raises `onCloseAutoFocus` from a setTimeout(0) after the menu
    // unmounts, and the handler defers `open()` by one microtask, so this
    // cannot be asserted synchronously after the click.
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    await waitFor(() => expect(settingsDialogMock.open).toHaveBeenCalledTimes(1));
    expect(routerMock.push).not.toHaveBeenCalled();

    // Skills
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Skills' }));
    expect(routerMock.push).toHaveBeenCalledWith('/skills');

    // Light & System
    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));
    expect(themeMock.setTheme).toHaveBeenCalledWith('light');

    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(themeMock.setTheme).toHaveBeenCalledWith('system');

    // 日本語
    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: '日本語' }));
    expect(localeMock.switchLocale).toHaveBeenCalledWith('ja');

    // GitHub
    openMenu();
    const githubItem = screen.getByRole('menuitem', { name: 'GitHub' });
    expect(githubItem.tagName).toBe('A');
    expect(githubItem).toHaveAttribute('href', 'https://github.com/kewton/MyCodeBranchDesk');
    expect(githubItem).toHaveAttribute('target', '_blank');
    expect(githubItem).toHaveAttribute('rel', 'noopener noreferrer');

    // The menu never opens or closes the sidebar (the rail has no tabs, so
    // there is no onToggle to check any more).
    expect(sidebarMock.toggle).not.toHaveBeenCalled();
  });

  it('does not show Logout item when AuthProvider is not present', () => {
    render(<SidebarRail />);
    fireEvent.keyDown(screen.getByTestId('sidebar-rail-settings'), { key: 'Enter' });
    expect(screen.queryByRole('menuitem', { name: 'Logout' })).toBeNull();
  });

  it('shows Logout item when authEnabled is true and logs out on click', async () => {
    const originalLocation = window.location;
    const hrefSetter = vi.fn();
    const locationObj = { ...originalLocation };
    Object.defineProperty(locationObj, 'href', {
      get: () => 'http://localhost/',
      set: (val: string) => {
        hrefSetter(val);
      },
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: locationObj,
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      render(
        <AuthProvider authEnabled>
          <SidebarRail />
        </AuthProvider>
      );
      fireEvent.keyDown(screen.getByTestId('sidebar-rail-settings'), { key: 'Enter' });
      const logoutItem = screen.getByRole('menuitem', { name: 'Logout' });
      expect(logoutItem).toBeInTheDocument();

      fireEvent.click(logoutItem);

      expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
      await waitFor(() => {
        expect(hrefSetter).toHaveBeenCalledWith('/login');
      });
    } finally {
      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('still navigates to /login even if logout fetch rejects', async () => {
    const originalLocation = window.location;
    const hrefSetter = vi.fn();
    const locationObj = { ...originalLocation };
    Object.defineProperty(locationObj, 'href', {
      get: () => 'http://localhost/',
      set: (val: string) => {
        hrefSetter(val);
      },
      configurable: true,
    });
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: locationObj,
    });

    const fetchMock = vi.fn().mockRejectedValue(new Error('Network failure'));
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      render(
        <AuthProvider authEnabled>
          <SidebarRail />
        </AuthProvider>
      );
      fireEvent.keyDown(screen.getByTestId('sidebar-rail-settings'), { key: 'Enter' });
      const logoutItem = screen.getByRole('menuitem', { name: 'Logout' });

      fireEvent.click(logoutItem);

      expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
      await waitFor(() => {
        expect(hrefSetter).toHaveBeenCalledWith('/login');
      });
    } finally {
      Object.defineProperty(window, 'location', {
        writable: true,
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
