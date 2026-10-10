/**
 * Shared settings menu: sidebar footer + ActivityBar gear (Issue #3510)
 *
 * The sidebar half mounts the real `Sidebar` inside the real providers, so the
 * menu reads the same SidebarContext / PcDisplaySizeContext the app does. The
 * ActivityBar half is covered by ActivityBar.test.tsx and the #2709 files; this
 * file only adds what they do not pin: Esc closes and focus goes back to the
 * button that opened it, for both hosts.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ActivityBar } from '@/components/worktree/ActivityBar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { PcDisplaySizeProvider } from '@/contexts/PcDisplaySizeContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import type { Worktree } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
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

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { getAll: vi.fn(), getById: vi.fn() },
    repositoryApi: { sync: vi.fn() },
  };
});

import { worktreeApi } from '@/lib/api-client';

const mockWorktrees: Worktree[] = [
  {
    id: 'feature-test-1',
    name: 'feature/test-1',
    path: '/path/to/worktree1',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    isSessionRunning: true,
    isWaitingForResponse: false,
  },
];

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>
    <PcDisplaySizeProvider>
      <SidebarProvider>
        <WorktreeSelectionProvider>{children}</WorktreeSelectionProvider>
      </SidebarProvider>
    </PcDisplaySizeProvider>
  </ToastProvider>
);

/** `useIsMobile` reads `window.innerWidth` through the matchMedia stub on first render. */
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

async function renderSidebar(width: number): Promise<HTMLElement> {
  setViewportWidth(width);
  render(
    <Wrapper>
      <Sidebar />
    </Wrapper>
  );
  return screen.findByTestId('sidebar-settings-menu');
}

function openWithKeyboard(trigger: HTMLElement): HTMLElement {
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('Settings menu (Issue #3510)', () => {
  beforeAll(() => installRadixJsdomPolyfills());

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    themeMock.theme = 'dark';
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: mockWorktrees,
      repositories: [],
    });
    (worktreeApi.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorktrees[0]);
  });

  afterEach(() => {
    setViewportWidth(1024);
    vi.unstubAllEnvs();
  });

  describe('sidebar footer (PC, 1024px)', () => {
    it('is a menu button inside the sidebar footer', async () => {
      const trigger = await renderSidebar(1024);
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveAccessibleName('Settings');
      expect(trigger.closest('[data-testid="sidebar"]')).not.toBeNull();
    });

    it('holds every moved entry: settings, skills, theme, language, display size, tab strip, GitHub, version', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.2.3');
      const trigger = await renderSidebar(1024);
      const menu = openWithKeyboard(trigger);

      expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
        'Settings',
        'Skills',
        'GitHub',
      ]);
      expect(within(menu).getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual([
        'Light',
        'Dark',
        'System',
        'English',
        '日本語',
        'Large',
        'Medium',
        'Small',
        'Extra small',
        'Always show',
        'Only when the sidebar is collapsed',
        'Hidden',
      ]);
      expect(screen.getByTestId('sidebar-settings-menu-version')).toHaveTextContent('CommandMate v1.2.3');
      expect(within(menu).getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('data-state', 'checked');
      expect(within(menu).getByRole('menuitemradio', { name: 'Medium' })).toHaveAttribute('data-state', 'checked');
    });

    it('closes on Escape and gives focus back to the button', async () => {
      const trigger = await renderSidebar(1024);
      openWithKeyboard(trigger);

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens and closes in light mode too', async () => {
      themeMock.theme = 'light';
      const trigger = await renderSidebar(1024);
      const menu = openWithKeyboard(trigger);
      expect(within(menu).getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute('data-state', 'checked');

      fireEvent.keyDown(menu, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });

    it('applies the theme, display size and tab-strip choices', async () => {
      const trigger = await renderSidebar(1024);

      openWithKeyboard(trigger);
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Light' }));
      expect(themeMock.setTheme).toHaveBeenCalledWith('light');

      openWithKeyboard(trigger);
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Small' }));
      openWithKeyboard(trigger);
      expect(screen.getByRole('menuitemradio', { name: 'Small' })).toHaveAttribute('data-state', 'checked');

      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Hidden' }));
      openWithKeyboard(trigger);
      expect(screen.getByRole('menuitemradio', { name: 'Hidden' })).toHaveAttribute('data-state', 'checked');
    });

    it('opens the settings modal from "Settings" without navigating', async () => {
      const trigger = await renderSidebar(1024);
      openWithKeyboard(trigger);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));

      await waitFor(() => expect(settingsDialogMock.open).toHaveBeenCalledTimes(1));
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('navigates to /skills from "Skills"', async () => {
      const trigger = await renderSidebar(1024);
      openWithKeyboard(trigger);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Skills' }));
      expect(mockPush).toHaveBeenCalledWith('/skills');
    });

    it('leaves the menu button as the only control in the footer', async () => {
      const trigger = await renderSidebar(1024);
      const footer = screen.getByTestId('sidebar-footer');
      const controls = footer.querySelectorAll('button, a[href], select, input, textarea, [tabindex]');
      expect(Array.from(controls)).toEqual([trigger]);
      // The entries that used to sit next to it are gone from the sidebar.
      const sidebar = screen.getByTestId('sidebar');
      expect(within(sidebar).queryByTestId('sidebar-settings')).toBeNull();
      expect(within(sidebar).queryByTestId('locale-switcher')).toBeNull();
      expect(within(sidebar).queryByTestId('theme-toggle')).toBeNull();
      expect(within(sidebar).queryByTestId('logout-button')).toBeNull();
    });

    it('switches the language from the menu', async () => {
      const trigger = await renderSidebar(1024);
      openWithKeyboard(trigger);
      expect(screen.getByRole('menuitemradio', { name: 'English' })).toHaveAttribute('data-state', 'checked');

      fireEvent.click(screen.getByRole('menuitemradio', { name: '日本語' }));
      expect(localeMock.switchLocale).toHaveBeenCalledWith('ja');
    });
  });

  describe('sidebar footer (phone, 390px)', () => {
    it('sends "Settings" to /more and opens no modal (#2709 behaviour)', async () => {
      const trigger = await renderSidebar(390);
      openWithKeyboard(trigger);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));

      expect(mockPush).toHaveBeenCalledWith('/more');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settingsDialogMock.open).not.toHaveBeenCalled();
    });

    it('leaves out the PC-only display size and tab-strip choices', async () => {
      const trigger = await renderSidebar(390);
      const menu = openWithKeyboard(trigger);

      expect(within(menu).queryByRole('menuitemradio', { name: 'Medium' })).toBeNull();
      expect(within(menu).queryByRole('menuitemradio', { name: 'Hidden' })).toBeNull();
      expect(within(menu).getByRole('menuitemradio', { name: 'Light' })).toBeInTheDocument();
    });

    it('keeps the menu inside a 390px viewport', async () => {
      const trigger = await renderSidebar(390);
      const menu = openWithKeyboard(trigger);

      // Radix keeps it on screen (collisionPadding); the width and height caps
      // are what make that possible at all.
      expect(menu.className).toContain('max-w-[calc(100vw-16px)]');
      expect(menu.className).toContain('max-h-[var(--radix-dropdown-menu-content-available-height)]');
      expect(menu.className).toContain('overflow-y-auto');
    });

    it('closes on Escape and gives focus back to the button', async () => {
      const trigger = await renderSidebar(390);
      openWithKeyboard(trigger);

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });
  });

  describe('ActivityBar gear', () => {
    it('closes on Escape and gives focus back to the gear', async () => {
      render(
        <Wrapper>
          <ActivityBar active="files" onToggle={() => {}} />
        </Wrapper>
      );
      const gear = screen.getByTestId('activity-bar-settings');
      openWithKeyboard(gear);

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(gear));
    });
  });
});
