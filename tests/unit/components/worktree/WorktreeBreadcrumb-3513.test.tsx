/**
 * @vitest-environment jsdom
 */

/**
 * The worktree header's breadcrumb (Issue #3513).
 *
 * Pinned here:
 *   1. The repository is named in the header whatever the tab strip is doing —
 *      the strip is gone while the sidebar is open and under the `hidden`
 *      setting, and the header is then the only place that says it.
 *   2. Two repositories that both have a `develop` are told apart: by the
 *      repository on the small line, and by the ▾ list, which is that
 *      worktree's own repository's (found by id, not by name).
 *   3. The ▾ list is the tab strip's list (same panel, same rows), opens on
 *      click / ArrowDown, closes on Escape with focus back, and navigates.
 *   4. Without the worktree cache (isolated renders) the name is plain text,
 *      as before — no ▾, nothing thrown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import React from 'react';
import type { Worktree } from '@/types/models';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/beta-develop',
  useSearchParams: () => new URLSearchParams(),
}));

const cacheState = vi.hoisted(() => ({
  value: null as null | { worktrees: unknown[]; repositories: unknown[] },
}));
vi.mock('@/components/providers/WorktreesCacheProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/providers/WorktreesCacheProvider')>()),
  useOptionalWorktreesCacheContext: () =>
    cacheState.value
      ? {
          ...cacheState.value,
          isLoading: false,
          error: null,
          refresh: vi.fn(),
        }
      : null,
}));

const sidebarState = vi.hoisted(() => ({
  value: null as null | Record<string, unknown>,
}));
vi.mock('@/contexts/SidebarContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/SidebarContext')>()),
  useSidebarContext: () => sidebarState.value,
}));

import { DesktopHeader } from '@/components/worktree/WorktreeDetailSubComponents';

function worktree(overrides: Partial<Worktree> & Pick<Worktree, 'id'>): Worktree {
  return {
    name: `branch-${overrides.id}`,
    path: `/repos/${overrides.id}`,
    repositoryPath: '/repos/alpha',
    repositoryName: 'alpha',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Worktree;
}

/** Two repositories, each with a `develop`. */
const WORKTREES: Worktree[] = [
  worktree({ id: 'alpha-develop', name: 'develop', repositoryPath: '/repos/alpha', repositoryName: 'alpha' }),
  worktree({ id: 'alpha-main', name: 'main', repositoryPath: '/repos/alpha', repositoryName: 'alpha' }),
  worktree({ id: 'beta-develop', name: 'develop', repositoryPath: '/repos/beta', repositoryName: 'beta' }),
  worktree({ id: 'beta-fix', name: 'fix/3513', repositoryPath: '/repos/beta', repositoryName: 'beta' }),
];

/** The sidebar settings the header reads; the tab-strip state is varied per test. */
function sidebar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sortKey: 'updatedAt',
    sortDirection: 'desc',
    repositoryOrder: [],
    isOpen: false,
    repoTabBarMode: 'collapsed',
    ...overrides,
  };
}

function renderHeader(props: { worktreeId?: string; worktreeName: string; repositoryName: string }) {
  return render(
    <DesktopHeader {...props} status="idle" onInfoClick={vi.fn()} />
  );
}

beforeEach(() => {
  mockPush.mockReset();
  cacheState.value = { worktrees: WORKTREES, repositories: [] };
  sidebarState.value = sidebar();
});

afterEach(() => {
  cleanup();
});

describe('WorktreeBreadcrumb in DesktopHeader (Issue #3513)', () => {
  describe('the repository is named when the tab strip is not on screen', () => {
    // The strip is off in both of these states (shouldShowRepositoryTabBar);
    // the header does not read them, so the repository must be there anyway.
    for (const [label, state] of [
      ['sidebar open', { isOpen: true, repoTabBarMode: 'collapsed' }],
      ['tab strip hidden', { isOpen: false, repoTabBarMode: 'hidden' }],
    ] as const) {
      it(`shows the repository with the ${label}`, () => {
        sidebarState.value = sidebar(state);
        renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
        expect(screen.getByTestId('desktop-repository-name')).toHaveTextContent('beta');
      });
    }

    it('shows it outside every provider too (no cache, no sidebar)', () => {
      cacheState.value = null;
      sidebarState.value = null; // would throw if it were read
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      expect(screen.getByTestId('desktop-repository-name')).toHaveTextContent('beta');
    });
  });

  describe('two `develop` worktrees are told apart', () => {
    it('names a different repository on each header', () => {
      renderHeader({ worktreeId: 'alpha-develop', worktreeName: 'develop', repositoryName: 'alpha' });
      const alphaRepo = screen.getByTestId('desktop-repository-name').textContent;
      const alphaHeading = screen.getByRole('heading', { level: 1 }).textContent;
      cleanup();
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      const betaRepo = screen.getByTestId('desktop-repository-name').textContent;
      const betaHeading = screen.getByRole('heading', { level: 1 }).textContent;

      // Same heading, so the heading alone could not tell them apart...
      expect(alphaHeading).toBe('develop');
      expect(betaHeading).toBe('develop');
      // ...the repository line does.
      expect(alphaRepo).toBe('alpha');
      expect(betaRepo).toBe('beta');
    });

    it("opens the worktree's own repository's list, with it marked", () => {
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      fireEvent.click(screen.getByTestId('worktree-breadcrumb-branch'));

      const popover = screen.getByTestId('repository-tab-popover');
      expect(popover).toHaveAttribute('data-repository', 'beta');
      const rows = within(popover).getAllByTestId('branch-list-item');
      expect(rows).toHaveLength(2);
      expect(within(popover).queryByText('main')).toBeNull();
      const current = rows.filter((row) => row.getAttribute('aria-current') === 'true');
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent('develop');
    });
  });

  describe('the ▾ list behaves like the tab strip', () => {
    it('keeps the heading named after the worktree (the chevron is hidden)', () => {
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('develop');
    });

    it('opens on ArrowDown and closes on Escape, handing focus back', () => {
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      const button = screen.getByTestId('worktree-breadcrumb-branch');
      fireEvent.keyDown(button, { key: 'ArrowDown' });
      expect(screen.getByTestId('repository-tab-popover')).toBeInTheDocument();
      expect(button).toHaveAttribute('aria-expanded', 'true');

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
      expect(document.activeElement).toBe(button);
    });

    it('closes on a click outside, and again on the ▾', () => {
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      const button = screen.getByTestId('worktree-breadcrumb-branch');
      fireEvent.click(button);
      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId('repository-tab-popover')).toBeNull();

      fireEvent.click(button);
      expect(screen.getByTestId('repository-tab-popover')).toBeInTheDocument();
      fireEvent.click(button);
      expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
    });

    it('navigates to the picked branch and closes', () => {
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      fireEvent.click(screen.getByTestId('worktree-breadcrumb-branch'));
      const popover = screen.getByTestId('repository-tab-popover');
      fireEvent.click(within(popover).getByText('fix/3513'));

      expect(mockPush).toHaveBeenCalledWith('/worktrees/beta-fix');
      expect(screen.queryByTestId('repository-tab-popover')).toBeNull();
    });
  });

  describe('without the list data the name is plain text (as before #3513)', () => {
    it('renders no ▾ outside the worktree cache', () => {
      cacheState.value = null;
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      expect(screen.queryByTestId('worktree-breadcrumb-branch')).toBeNull();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('develop');
    });

    it('renders no ▾ when the cache does not list this worktree yet', () => {
      renderHeader({ worktreeId: 'gamma-main', worktreeName: 'main', repositoryName: 'gamma' });
      expect(screen.queryByTestId('worktree-breadcrumb-branch')).toBeNull();
    });

    it('renders no ▾ under a sidebar context without sort settings (partial stubs)', () => {
      sidebarState.value = { isOpen: true };
      renderHeader({ worktreeId: 'beta-develop', worktreeName: 'develop', repositoryName: 'beta' });
      expect(screen.queryByTestId('worktree-breadcrumb-branch')).toBeNull();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('develop');
    });

    it('renders no ▾ without a worktree id', () => {
      renderHeader({ worktreeName: 'develop', repositoryName: 'beta' });
      expect(screen.queryByTestId('worktree-breadcrumb-branch')).toBeNull();
    });
  });
});
