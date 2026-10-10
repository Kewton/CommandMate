/**
 * @vitest-environment jsdom
 */

/**
 * The top of the open PC sidebar (Issue #3512): logo + open/close, New task,
 * the ⌘K search row, then the destinations. The sync button is a plain
 * always-painted button (not a hover reveal), so touch and keyboard reach it.
 * The mobile drawer keeps its header as it was (#3515).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { ToastProvider } from '@/components/common/Toast';
import { SidebarProvider } from '@/contexts/SidebarContext';
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

function renderSidebar() {
  return render(
    <ToastProvider>
      <PcDisplaySizeProvider>
        <SidebarProvider>
          <WorktreeSelectionProvider>
            <Sidebar />
          </WorktreeSelectionProvider>
        </SidebarProvider>
      </PcDisplaySizeProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setViewportWidth(1024);
});

afterEach(() => {
  setViewportWidth(1024);
});

describe('Sidebar top on the PC (Issue #3512)', () => {
  it('orders logo + open/close, New task, search, then the destinations', () => {
    renderSidebar();
    const header = screen.getByTestId('sidebar-header');
    const order = Array.from(
      header.querySelectorAll(
        '[data-testid="sidebar-panel-toggle"], [data-testid="sidebar-logo"], [data-testid="sidebar-new-task"], [data-testid="sidebar-search"], [data-testid="sidebar-nav"]',
      ),
    ).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'sidebar-panel-toggle',
      'sidebar-logo',
      'sidebar-new-task',
      'sidebar-search',
      'sidebar-nav',
    ]);
    expect(screen.getByTestId('sidebar-logo')).toHaveAttribute('href', '/');
  });

  it('puts the open/close button first in the header, in the left cell the rail uses', () => {
    renderSidebar();
    const toggle = screen.getByTestId('sidebar-panel-toggle');
    expect(toggle).toHaveAccessibleName('Close sidebar');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Same padding as the rail (px-2 py-2), so the 40px button lands on the same spot.
    expect(screen.getByTestId('sidebar-header')).toHaveClass('px-2', 'py-2');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens New task and the command palette', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('sidebar-new-task'));
    expect(newTaskMock.openNewTask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('sidebar-search'));
    expect(paletteMock.setOpen).toHaveBeenCalledWith(true);
  });

  it('keeps the sync button painted and focusable without hover', () => {
    renderSidebar();
    const repositoriesRow = screen.getByTestId('sidebar-nav-repositories').closest('li') as HTMLElement;
    const sync = within(repositoriesRow).getByRole('button', { name: 'Sync branches' });
    expect(sync.className).not.toMatch(/opacity-0|invisible|hidden/);
    sync.focus();
    expect(document.activeElement).toBe(sync);
  });
});

describe('Sidebar top in the mobile drawer (#3515, unchanged)', () => {
  it('has no logo / open-close / New task / search rows', () => {
    setViewportWidth(390);
    renderSidebar();
    expect(screen.queryByTestId('sidebar-top-controls')).toBeNull();
    expect(screen.queryByTestId('sidebar-panel-toggle')).toBeNull();
    expect(screen.getByTestId('sidebar-nav')).toBeInTheDocument();
  });
});
