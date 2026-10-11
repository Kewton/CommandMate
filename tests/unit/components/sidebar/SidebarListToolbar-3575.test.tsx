/**
 * Sidebar list toolbar in one row (Issue #3575): the filter field and a filter
 * icon that opens View and Sort in a small menu.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn(),
      getById: vi.fn().mockResolvedValue(null),
      markAsViewed: vi.fn().mockResolvedValue(undefined),
    },
    repositoryApi: { sync: vi.fn() },
  };
});

import { Sidebar } from '@/components/layout/Sidebar';
import {
  SidebarProvider,
  SIDEBAR_SORT_STORAGE_KEY,
  SIDEBAR_VIEW_MODE_STORAGE_KEY,
} from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';

const REPO = '/repos/app';

function wt(overrides: Record<string, unknown> & { id: string }): Worktree {
  return {
    name: overrides.id,
    path: `${REPO}/${overrides.id}`,
    repositoryPath: REPO,
    repositoryName: 'App',
    ...overrides,
  } as unknown as Worktree;
}

const WORKTREES: Worktree[] = [
  wt({ id: 'a', name: 'feature/alpha', updatedAt: new Date('2026-10-01T00:00:00Z') }),
  wt({ id: 'b', name: 'feature/beta', updatedAt: new Date('2026-10-02T00:00:00Z') }),
];

function renderSidebar(worktrees: Worktree[] = WORKTREES) {
  return render(
    <SidebarProvider>
      <WorktreeSelectionProvider externalWorktrees={worktrees} externalRepositories={[]}>
        <Sidebar />
      </WorktreeSelectionProvider>
    </SidebarProvider>,
  );
}

const trigger = () => screen.getByTestId('sidebar-list-options');

/** Opens the View / Sort menu from the keyboard and returns it. */
function openOptions(): HTMLElement {
  fireEvent.keyDown(trigger(), { key: 'Enter' });
  return screen.getByTestId('sidebar-list-options-menu');
}

const branchRowNames = () =>
  screen.getAllByTestId('branch-list-item').map((el) => el.querySelector('p')?.textContent);

beforeAll(() => installRadixJsdomPolyfills());

beforeEach(() => {
  locale.current = 'en';
  localStorage.clear();
  global.fetch = vi.fn().mockResolvedValue({ json: async () => ({ success: true, order: null }) }) as unknown as typeof fetch;
});

describe('List toolbar in one row (Issue #3575)', () => {
  it('holds only the filter field and the filter icon, in one row', async () => {
    renderSidebar();

    const toolbar = await screen.findByTestId('sidebar-list-toolbar');
    expect(toolbar).toHaveClass('flex', 'items-center');
    expect(toolbar.className).not.toMatch(/space-y/);
    const children = Array.from(toolbar.children);
    expect(children).toHaveLength(2);
    expect(children[0]).toBe(screen.getByPlaceholderText('Search branches...'));
    expect(children[0]).toHaveClass('h-8', 'flex-1', 'min-w-0');
    expect(children[1]).toBe(trigger());
    // The old second and third rows are gone.
    expect(screen.queryByTestId('sidebar-list-controls')).not.toBeInTheDocument();
    expect(screen.queryByTestId('view-mode-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sort-selector-base')).not.toBeInTheDocument();
    // View and Sort are not drawn until the icon is used.
    expect(screen.queryByTestId('sidebar-list-options-menu')).not.toBeInTheDocument();
  });

  it('names the current View and Sort on the icon, with no dot at the defaults (negative control)', async () => {
    renderSidebar();

    const button = await screen.findByTestId('sidebar-list-options');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAccessibleName('View and sort (Repository · Updated · Newest first)');
    expect(button).toHaveAttribute('title', 'Repository · Updated · Newest first');
    expect(screen.queryByTestId('sidebar-list-options-indicator')).not.toBeInTheDocument();
  });

  it.each([
    ['a non-default view', () => localStorage.setItem(SIDEBAR_VIEW_MODE_STORAGE_KEY, 'flat')],
    ['a non-default sort key', () => localStorage.setItem(SIDEBAR_SORT_STORAGE_KEY, JSON.stringify({ sortKey: 'status', sortDirection: 'asc' }))],
    ['a non-default direction', () => localStorage.setItem(SIDEBAR_SORT_STORAGE_KEY, JSON.stringify({ sortKey: 'updatedAt', sortDirection: 'asc' }))],
  ])('marks the icon with a dot for %s (positive control)', async (_label, seed) => {
    seed();
    renderSidebar();

    expect(await screen.findByTestId('sidebar-list-options-indicator')).toBeInTheDocument();
  });

  it('lists View and Sort in the menu with the current values checked', async () => {
    renderSidebar();
    await screen.findByTestId('sidebar-list-options');

    const menu = openOptions();
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const view = within(menu).getByTestId('view-mode-options');
    expect(view).toHaveAccessibleName('View');
    expect(within(view).getAllByRole('menuitemradio').map((el) => [el.textContent, el.getAttribute('aria-checked')])).toEqual([
      ['Repository', 'true'],
      ['Branch', 'false'],
      ['Session', 'false'],
    ]);
    const keys = within(menu).getByTestId('sort-key-options');
    expect(keys).toHaveAccessibleName('Sort');
    expect(within(keys).getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual([
      'Updated',
      'Repository name',
      'Branch name',
      'Status',
    ]);
    expect(within(keys).getByRole('menuitemradio', { name: 'Updated' })).toHaveAttribute('aria-checked', 'true');
    const directions = within(menu).getByTestId('sort-direction-options');
    expect(within(directions).getAllByRole('menuitemradio').map((el) => [el.textContent, el.getAttribute('aria-checked')])).toEqual([
      ['Newest first', 'true'],
      ['Oldest first', 'false'],
    ]);
  });

  it('opens from the keyboard, moves with the arrows, and Escape returns focus to the icon', async () => {
    renderSidebar();
    await screen.findByTestId('sidebar-list-options');

    trigger().focus();
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    // Radix focuses the first item when the menu is opened from the keyboard.
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Repository' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Branch' })).toHaveFocus());
    // The arrows cross the separators: every View and Sort item is reachable.
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Oldest first' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Newest first' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    await waitFor(() => expect(screen.getByRole('menuitemradio', { name: 'Status' })).toHaveFocus());
    // Enter on an item chooses it and keeps the menu open.
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(trigger()).toHaveAttribute('data-sort-key', 'status'));
    expect(screen.getByTestId('sidebar-list-options-menu')).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('sidebar-list-options-menu')).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('switches the view from the menu, keeps the menu open, and persists the choice', async () => {
    renderSidebar();
    await waitFor(() => expect(screen.getAllByTestId('group-header').length).toBeGreaterThan(0));

    fireEvent.click(within(openOptions()).getByRole('menuitemradio', { name: 'Branch' }));
    await waitFor(() => expect(screen.queryAllByTestId('group-header')).toHaveLength(0));
    expect(localStorage.getItem(SIDEBAR_VIEW_MODE_STORAGE_KEY)).toBe('flat');
    expect(screen.getByTestId('sidebar-list-options-menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Branch' })).toHaveAttribute('aria-checked', 'true');
    expect(trigger()).toHaveAttribute('data-view-mode', 'flat');
    expect(screen.getByTestId('sidebar-list-options-indicator')).toBeInTheDocument();
  });

  it('applies the default direction for a new key and lets the direction be chosen', async () => {
    renderSidebar();
    await waitFor(() => expect(branchRowNames()).toEqual(['feature/beta', 'feature/alpha']));

    const menu = openOptions();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Branch name' }));
    await waitFor(() => expect(trigger()).toHaveAttribute('data-sort-key', 'branchName'));
    expect(trigger()).toHaveAttribute('data-sort-direction', 'asc');
    expect(branchRowNames()).toEqual(['feature/alpha', 'feature/beta']);
    const directions = screen.getByTestId('sort-direction-options');
    expect(within(directions).getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual(['A→Z', 'Z→A']);

    fireEvent.click(within(directions).getByRole('menuitemradio', { name: 'Z→A' }));
    await waitFor(() => expect(trigger()).toHaveAttribute('data-sort-direction', 'desc'));
    expect(branchRowNames()).toEqual(['feature/beta', 'feature/alpha']);

    // Choosing the current key again does not flip the direction.
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Branch name' }));
    expect(trigger()).toHaveAttribute('data-sort-direction', 'desc');
    expect(JSON.parse(localStorage.getItem(SIDEBAR_SORT_STORAGE_KEY)!)).toEqual({ sortKey: 'branchName', sortDirection: 'desc' });
  });

  it('keeps the menu inside a 390px drawer (collision padding and a width cap)', async () => {
    renderSidebar();
    await screen.findByTestId('sidebar-list-options');

    const menu = openOptions();
    expect(menu.className).toMatch(/max-w-\[calc\(100vw-16px\)\]/);
    expect(menu.className).toMatch(/overflow-y-auto/);
  });

  it('is labelled in Japanese', async () => {
    locale.current = 'ja';
    renderSidebar();

    const button = await screen.findByTestId('sidebar-list-options');
    expect(button).toHaveAccessibleName('表示と並び（リポジトリ · 更新日時 · 新しい順）');
    const menu = openOptions();
    expect(within(menu).getByTestId('view-mode-options')).toHaveAccessibleName('表示');
    expect(within(menu).getByTestId('sort-direction-options')).toHaveAccessibleName('順序');
  });
});
