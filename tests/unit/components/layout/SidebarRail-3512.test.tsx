/**
 * @vitest-environment jsdom
 */

/**
 * The icon rail (Issue #3512): with the sidebar closed, Sessions /
 * Repositories / Review / settings / New task / ⌘K are each one click away,
 * and the open/close button is the first cell.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const pathMock = vi.hoisted(() => ({ pathname: '/sessions' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => pathMock.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('@/hooks/useLocaleSwitch', () => ({
  useLocaleSwitch: () => ({ currentLocale: 'en', switchLocale: vi.fn() }),
}));

const sidebarMock = vi.hoisted(() => ({ isOpen: false, toggle: vi.fn() }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({ isOpen: sidebarMock.isOpen, toggle: sidebarMock.toggle }),
  useOptionalSidebarContext: () => null,
}));

const paletteMock = vi.hoisted(() => ({ setOpen: vi.fn() }));
vi.mock('@/contexts/CommandPaletteContext', () => ({
  useCommandPalette: () => ({ open: false, setOpen: paletteMock.setOpen }),
}));

const newTaskMock = vi.hoisted(() => ({ openNewTask: vi.fn() }));
vi.mock('@/contexts/NewTaskContext', () => ({
  useNewTask: () => ({ openNewTask: newTaskMock.openNewTask }),
}));

const attention = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/hooks/useAttentionCount', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useAttentionCount')>();
  return { ...actual, useAttentionCount: () => ({ count: attention.count, worktrees: [] }) };
});

import { SidebarRail } from '@/components/layout/SidebarRail';
import { ATTENTION_REVIEW_HREF } from '@/config/review-config';

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  vi.clearAllMocks();
  pathMock.pathname = '/sessions';
  attention.count = 0;
});

describe('SidebarRail (Issue #3512)', () => {
  it('lists open/close, New task, search, Sessions, Repositories, Review and settings in that order', () => {
    render(<SidebarRail />);
    const rail = screen.getByTestId('sidebar-rail');
    const ids = Array.from(rail.querySelectorAll('[data-testid^="sidebar-rail-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(ids).toEqual([
      'sidebar-rail-toggle',
      'sidebar-rail-new-task',
      'sidebar-rail-search',
      'sidebar-rail-sessions',
      'sidebar-rail-repositories',
      'sidebar-rail-review',
      'sidebar-rail-settings',
    ]);
    expect(rail).toHaveAttribute('aria-label', 'App navigation');
  });

  it('lists the destinations as Sessions → Repositories → Review, the same order as the open sidebar (Issue #3577)', () => {
    render(<SidebarRail />);
    const links = Array.from(
      screen.getByTestId('sidebar-rail').querySelectorAll('a[data-testid^="sidebar-rail-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(links).toEqual(['sidebar-rail-sessions', 'sidebar-rail-repositories', 'sidebar-rail-review']);
  });

  it('every entry has a name (icon-only buttons and links)', () => {
    render(<SidebarRail />);
    expect(screen.getByTestId('sidebar-rail-toggle')).toHaveAccessibleName('Open sidebar');
    expect(screen.getByTestId('sidebar-rail-new-task')).toHaveAccessibleName('New task');
    expect(screen.getByTestId('sidebar-rail-search')).toHaveAccessibleName('Open command palette');
    expect(screen.getByTestId('sidebar-rail-sessions')).toHaveAccessibleName('Sessions');
    expect(screen.getByTestId('sidebar-rail-repositories')).toHaveAccessibleName('Repositories');
    expect(screen.getByTestId('sidebar-rail-review')).toHaveAccessibleName('Review');
    expect(screen.getByTestId('sidebar-rail-settings')).toHaveAccessibleName('Settings');
  });

  it('opens the sidebar, New task and the palette in one click', () => {
    render(<SidebarRail />);
    fireEvent.click(screen.getByTestId('sidebar-rail-toggle'));
    expect(sidebarMock.toggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('sidebar-rail-new-task'));
    expect(newTaskMock.openNewTask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('sidebar-rail-search'));
    expect(paletteMock.setOpen).toHaveBeenCalledWith(true);
  });

  it('links the three screens and marks the current one', () => {
    render(<SidebarRail />);
    expect(screen.getByTestId('sidebar-rail-sessions')).toHaveAttribute('href', '/sessions');
    expect(screen.getByTestId('sidebar-rail-sessions')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('sidebar-rail-repositories')).toHaveAttribute('href', '/repositories');
    expect(screen.getByTestId('sidebar-rail-repositories')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('sidebar-rail-review')).toHaveAttribute('href', '/review');
  });

  it('shows the waiting count on Review and links to the approval list', () => {
    attention.count = 3;
    render(<SidebarRail />);
    const review = screen.getByTestId('sidebar-rail-review');
    expect(review).toHaveAttribute('href', ATTENTION_REVIEW_HREF);
    expect(within(review).getByTestId('attention-badge-bubble')).toHaveTextContent('3');
  });

  it('shows no count at zero (negative control)', () => {
    render(<SidebarRail />);
    expect(screen.queryByTestId('attention-badge-bubble')).toBeNull();
  });

  it('opens the shared settings menu from the bottom gear', () => {
    render(<SidebarRail />);
    fireEvent.keyDown(screen.getByTestId('sidebar-rail-settings'), { key: 'Enter' });
    const menu = screen.getByRole('menu');
    expect(within(menu).getByTestId('sidebar-rail-settings-version')).toBeInTheDocument();
    expect(within(menu).getByText('GitHub')).toBeInTheDocument();
  });
});
