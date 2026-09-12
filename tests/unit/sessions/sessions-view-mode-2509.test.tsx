/**
 * `/sessions` list ⇄ tile — Issue #2509.
 *
 * Covers the page-level half of the feature: the switch, the localStorage
 * persistence, the full-width wrapper, and that the filter/sort controls feed
 * the tile grid the same rows they feed the list. The list branch is asserted to
 * be *absent* in tile mode and *unchanged* in list mode — `SessionsPage.test.tsx`
 * and `app/sessions/page-i18n.test.tsx` are the rest of that guarantee, since
 * neither of them touches localStorage and both therefore run in the default.
 *
 * `SessionTileGrid` is stubbed: what a tile renders is
 * `session-tile-2509.test.tsx`'s subject, and what it fetches is
 * `session-tile-viewport-2509.test.tsx`'s.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/sessions',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'app-shell' }, children),
}));

vi.mock('@/lib/date-utils', () => ({
  formatRelativeTime: () => '2 hours ago',
  formatRelativeTimeShort: () => '2h ago',
}));

// Stubbed so this suite is about the page. The stub publishes the ids it was
// handed, which is how the filter/sort assertions below read the grid's input.
vi.mock('@/components/sessions/SessionTileGrid', () => ({
  SessionTileGrid: ({ worktrees }: { worktrees: Array<{ id: string }> }) =>
    React.createElement(
      'div',
      { 'data-testid': 'sessions-tile-grid' },
      worktrees.map((wt) =>
        React.createElement('div', { key: wt.id, 'data-testid': `session-tile-${wt.id}` }),
      ),
    ),
}));

let mockWorktrees: Array<Record<string, unknown>> = [];

vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useWorktreesCacheContext: () => ({
    worktrees: mockWorktrees,
    repositories: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import SessionsPage from '@/app/sessions/page';
import {
  DEFAULT_SESSIONS_VIEW_MODE,
  SESSIONS_VIEW_MODE_STORAGE_KEY,
} from '@/hooks/useSessionsViewMode';

function createWorktree(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wt-1',
    name: 'feature/test',
    path: '/path/to/wt',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    selectedAgents: ['claude'],
    ...overrides,
  };
}

/** The element PullToRefresh puts its className on — the page's wrapper. */
function wrapperClassList(): string {
  const shell = screen.getByTestId('app-shell');
  const wrapper = shell.firstElementChild;
  expect(wrapper).not.toBeNull();
  return wrapper!.className;
}

beforeEach(() => {
  mockWorktrees = [];
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('Sessions view mode (Issue #2509)', () => {
  describe('the default is list', () => {
    it('renders the list, not the grid, with nothing stored', () => {
      mockWorktrees = [createWorktree()];

      render(<SessionsPage />);

      expect(DEFAULT_SESSIONS_VIEW_MODE).toBe('list');
      expect(screen.getByTestId('sessions-list')).toBeDefined();
      expect(screen.queryByTestId('sessions-tile-grid')).toBeNull();
      expect(screen.getByTestId('sessions-view-mode-list').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('sessions-view-mode-tile').getAttribute('aria-pressed')).toBe('false');
    });

    it('also falls back to list when the stored value is not a known mode', () => {
      window.localStorage.setItem(SESSIONS_VIEW_MODE_STORAGE_KEY, 'mosaic');
      mockWorktrees = [createWorktree()];

      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-list')).toBeDefined();
      expect(screen.queryByTestId('sessions-tile-grid')).toBeNull();
    });
  });

  describe('switching', () => {
    it('swaps the list for the grid and persists the choice', () => {
      mockWorktrees = [createWorktree({ id: 'wt-a' })];

      render(<SessionsPage />);
      fireEvent.click(screen.getByTestId('sessions-view-mode-tile'));

      expect(screen.getByTestId('sessions-tile-grid')).toBeDefined();
      expect(screen.queryByTestId('sessions-list')).toBeNull();
      expect(window.localStorage.getItem(SESSIONS_VIEW_MODE_STORAGE_KEY)).toBe('tile');
    });

    it('restores tile mode from localStorage on the next mount', () => {
      window.localStorage.setItem(SESSIONS_VIEW_MODE_STORAGE_KEY, 'tile');
      mockWorktrees = [createWorktree({ id: 'wt-a' })];

      render(<SessionsPage />);

      expect(screen.getByTestId('sessions-tile-grid')).toBeDefined();
      expect(screen.getByTestId('sessions-view-mode-tile').getAttribute('aria-pressed')).toBe('true');
    });

    it('goes back to the list, and stores that too', () => {
      window.localStorage.setItem(SESSIONS_VIEW_MODE_STORAGE_KEY, 'tile');
      mockWorktrees = [createWorktree({ id: 'wt-a' })];

      render(<SessionsPage />);
      fireEvent.click(screen.getByTestId('sessions-view-mode-list'));

      expect(screen.getByTestId('sessions-list')).toBeDefined();
      expect(window.localStorage.getItem(SESSIONS_VIEW_MODE_STORAGE_KEY)).toBe('list');
    });
  });

  describe('the wrapper', () => {
    it('keeps container-custom in list mode', () => {
      mockWorktrees = [createWorktree()];

      render(<SessionsPage />);

      expect(wrapperClassList()).toContain('container-custom');
    });

    it('drops container-custom for a full-width grid in tile mode', () => {
      window.localStorage.setItem(SESSIONS_VIEW_MODE_STORAGE_KEY, 'tile');
      mockWorktrees = [createWorktree()];

      render(<SessionsPage />);

      const classes = wrapperClassList();
      expect(classes).not.toContain('container-custom');
      expect(classes).toContain('w-full');
    });
  });

  describe('filter and sort feed both layouts', () => {
    beforeEach(() => {
      window.localStorage.setItem(SESSIONS_VIEW_MODE_STORAGE_KEY, 'tile');
      mockWorktrees = [
        createWorktree({
          id: 'wt-old',
          name: 'alpha',
          repositoryName: 'AlphaRepo',
          lastUserMessageAt: '2026-01-01T10:00:00Z',
        }),
        createWorktree({
          id: 'wt-new',
          name: 'beta',
          repositoryName: 'BetaRepo',
          lastUserMessageAt: '2026-04-01T10:00:00Z',
        }),
      ];
    });

    it('orders tiles by the active sort (lastSent desc by default)', () => {
      render(<SessionsPage />);

      const grid = screen.getByTestId('sessions-tile-grid');
      const tiles = within(grid).getAllByTestId(/^session-tile-/);
      expect(tiles.map((tile) => tile.getAttribute('data-testid'))).toEqual([
        'session-tile-wt-new',
        'session-tile-wt-old',
      ]);
    });

    it('narrows the tiles with the text filter', () => {
      render(<SessionsPage />);

      act(() => {
        fireEvent.change(screen.getByTestId('sessions-filter'), { target: { value: 'alpha' } });
      });

      const grid = screen.getByTestId('sessions-tile-grid');
      expect(within(grid).getAllByTestId(/^session-tile-/)).toHaveLength(1);
      expect(screen.getByTestId('session-tile-wt-old')).toBeDefined();
    });

    it('shows the no-matching message instead of an empty grid', () => {
      render(<SessionsPage />);

      act(() => {
        fireEvent.change(screen.getByTestId('sessions-filter'), { target: { value: 'nothing-matches' } });
      });

      expect(screen.queryByTestId('sessions-tile-grid')).toBeNull();
      expect(screen.getByTestId('sessions-empty')).toBeDefined();
    });
  });
});
