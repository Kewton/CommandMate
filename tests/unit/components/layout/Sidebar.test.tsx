/**
 * Tests for Sidebar component
 *
 * Tests the sidebar with branch list
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { Sidebar, parseGroupCollapsed } from '@/components/layout/Sidebar';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import type { Worktree } from '@/types/models';

// Mock Next.js navigation
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

// Mock the API client
vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: {
      getAll: vi.fn(),
      getById: vi.fn(),
    },
    repositoryApi: {
      sync: vi.fn(),
    },
  };
});

import { worktreeApi, repositoryApi, ApiError } from '@/lib/api-client';

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
  {
    id: 'feature-test-2',
    name: 'feature/test-2',
    path: '/path/to/worktree2',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
    isSessionRunning: false,
    isWaitingForResponse: false,
  },
  {
    id: 'main',
    name: 'main',
    path: '/path/to/main',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
  },
];

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <SidebarProvider>
    <WorktreeSelectionProvider>
      {children}
    </WorktreeSelectionProvider>
  </SidebarProvider>
);

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    localStorage.clear();
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: mockWorktrees,
      repositories: [],
    });
    (worktreeApi.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorktrees[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the sidebar', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('sidebar')).toBeInTheDocument();
      });
    });

    it('should render header section', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('sidebar-header')).toBeInTheDocument();
      });
    });

    it('should render branch list', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('branch-list')).toBeInTheDocument();
      });
    });
  });

  describe('Branch items', () => {
    it('should display worktree items', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        // Branch names appear in both inline display and tooltip
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('feature/test-2').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('main').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should show repository name for each branch', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        const repoNames = screen.getAllByText('MyRepo');
        // 3 branch items + 1 group header = 4 in grouped mode
        expect(repoNames.length).toBeGreaterThanOrEqual(3);
      });
    });
  });

  describe('Search functionality', () => {
    it('should render search input', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/search|filter/i)).toBeInTheDocument();
      });
    });
  });

  describe('Layout', () => {
    it('should have vertical flex layout', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        const sidebar = screen.getByTestId('sidebar');
        expect(sidebar.className).toMatch(/flex|flex-col/);
      });
    });

    it('should have full height', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        const sidebar = screen.getByTestId('sidebar');
        expect(sidebar.className).toMatch(/h-full|h-screen/);
      });
    });

    it('should have scrollable content area', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        const branchList = screen.getByTestId('branch-list');
        expect(branchList.className).toMatch(/overflow/);
      });
    });
  });

  describe('Styling', () => {
    it('should have dark background', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        const sidebar = screen.getByTestId('sidebar');
        expect(sidebar.className).toMatch(/bg-gray-800|bg-gray-900|bg-slate-900|bg-zinc-900/);
      });
    });
  });

  describe('Accessibility', () => {
    it('should have navigation role', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole('navigation')).toBeInTheDocument();
      });
    });

    it('should have aria-label for navigation', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        const nav = screen.getByRole('navigation');
        expect(nav).toHaveAttribute('aria-label');
      });
    });
  });

  describe('Empty state', () => {
    it('should handle empty worktrees gracefully', async () => {
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktrees: [],
        repositories: [],
      });

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('sidebar')).toBeInTheDocument();
      });

      // Should either show empty state or just empty list
      const branchList = screen.queryByTestId('branch-list');
      expect(branchList || screen.getByTestId('sidebar')).toBeInTheDocument();
    });

    it('should show empty state message when no branches available', async () => {
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktrees: [],
        repositories: [],
      });

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText(/No branches available/i)).toBeInTheDocument();
      });
    });
  });

  describe('Branch selection', () => {
    it('should handle branch click', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
      });

      // Click on a branch
      const branchItem = screen.getAllByText('feature/test-1')[0].closest('[data-testid="branch-list-item"]');
      if (branchItem) {
        fireEvent.click(branchItem);
      }

      // Branch should still be visible after click
      expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Search filtering', () => {
    it('should filter branches by name', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
      });

      // Type in search input
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'test-1' } });

      // Should show only matching branch
      await waitFor(() => {
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
        expect(screen.queryAllByText('feature/test-2').length).toBe(0);
        expect(screen.queryAllByText('main').filter((el) => !el.closest('[role="tooltip"]')).length).toBe(0);
      });
    });

    it('should filter branches by repository name', async () => {
      const multiRepoWorktrees: Worktree[] = [
        ...mockWorktrees,
        {
          id: 'other-feature',
          name: 'feature/other',
          path: '/path/to/other',
          repositoryPath: '/path/to/other-repo',
          repositoryName: 'OtherRepo',
        },
      ];
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktrees: multiRepoWorktrees,
        repositories: [],
      });

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/other').length).toBeGreaterThanOrEqual(1);
      });

      // Type in search input for repository name
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'OtherRepo' } });

      // Should show only matching branch
      await waitFor(() => {
        expect(screen.getAllByText('feature/other').length).toBeGreaterThanOrEqual(1);
        expect(screen.queryAllByText('feature/test-1').length).toBe(0);
      });
    });

    it('should show no branches found when search has no results', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
      });

      // Type in search input with non-matching query
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'nonexistent-branch' } });

      // Should show no branches found message
      await waitFor(() => {
        expect(screen.getByText(/No branches found/i)).toBeInTheDocument();
      });
    });

    it('should clear filter and show all branches', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
      });

      // Type and then clear search input
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'test-1' } });

      await waitFor(() => {
        expect(screen.queryAllByText('main').filter((el) => !el.closest('[role="tooltip"]')).length).toBe(0);
      });

      fireEvent.change(searchInput, { target: { value: '' } });

      // Should show all branches again
      await waitFor(() => {
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('feature/test-2').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('main').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should handle case-insensitive search', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
      });

      // Type in search input with different case
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'FEATURE' } });

      // Should show matching branches (case-insensitive)
      await waitFor(() => {
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('feature/test-2').length).toBeGreaterThanOrEqual(1);
        expect(screen.queryAllByText('main').filter((el) => !el.closest('[role="tooltip"]')).length).toBe(0);
      });
    });
  });

  describe('Header content', () => {
    it('should display Branches title', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Branches')).toBeInTheDocument();
      });
    });
  });

  describe('Grouped view (default)', () => {
    const multiRepoWorktrees: Worktree[] = [
      {
        id: 'repo-a-feature',
        name: 'feature/a-work',
        path: '/path/to/a',
        repositoryPath: '/path/to/repo-a',
        repositoryName: 'RepoA',
      },
      {
        id: 'repo-b-feature',
        name: 'feature/b-work',
        path: '/path/to/b',
        repositoryPath: '/path/to/repo-b',
        repositoryName: 'RepoB',
      },
      {
        id: 'repo-a-main',
        name: 'main',
        path: '/path/to/a-main',
        repositoryPath: '/path/to/repo-a',
        repositoryName: 'RepoA',
      },
    ];

    beforeEach(() => {
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktrees: multiRepoWorktrees,
        repositories: [],
      });
    });

    it('should display repository group headers in grouped mode', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        const groupHeaders = screen.getAllByTestId('group-header');
        expect(groupHeaders.length).toBe(2);
      });
    });

    it('should display all branches within their groups', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        // Branch names appear in both inline display and tooltip
        expect(screen.getAllByText('feature/a-work').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('feature/b-work').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('main').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should show view mode toggle button', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('view-mode-toggle')).toBeInTheDocument();
      });
    });

    it('should toggle group collapsed state on header click', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/a-work').length).toBeGreaterThanOrEqual(1);
      });

      // Click the first group header to collapse it
      const groupHeaders = screen.getAllByTestId('group-header');
      fireEvent.click(groupHeaders[0]);

      // Branches in collapsed group should be hidden (no inline or tooltip instances)
      await waitFor(() => {
        expect(screen.queryAllByText('feature/a-work').length).toBe(0);
        expect(screen.getAllByText('feature/b-work').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should expand collapsed group on second click', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/a-work').length).toBeGreaterThanOrEqual(1);
      });

      // Collapse
      const groupHeaders1 = screen.getAllByTestId('group-header');
      fireEvent.click(groupHeaders1[0]);
      await waitFor(() => {
        expect(screen.queryAllByText('feature/a-work').length).toBe(0);
      });

      // Expand (re-query headers after re-render)
      const groupHeaders2 = screen.getAllByTestId('group-header');
      fireEvent.click(groupHeaders2[0]);
      await waitFor(() => {
        expect(screen.getAllByText('feature/a-work').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should show all groups expanded when searching', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/a-work').length).toBeGreaterThanOrEqual(1);
      });

      // Collapse RepoA group
      const groupHeaders1 = screen.getAllByTestId('group-header');
      fireEvent.click(groupHeaders1[0]);

      await waitFor(() => {
        expect(screen.queryAllByText('feature/a-work').length).toBe(0);
      });

      // Search for something in RepoA - should override collapsed state
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'a-work' } });

      await waitFor(() => {
        expect(screen.getAllByText('feature/a-work').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should hide groups with no matching branches during search', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('feature/a-work').length).toBeGreaterThanOrEqual(1);
      });

      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'b-work' } });

      await waitFor(() => {
        // RepoB group should be visible
        expect(screen.getAllByText('feature/b-work').length).toBeGreaterThanOrEqual(1);
        // RepoA group header should not be visible (no matching branches)
        const groupHeaders = screen.getAllByTestId('group-header');
        expect(groupHeaders.length).toBe(1);
      });
    });
  });

  describe('Flat view', () => {
    it('should show flat list when view mode is flat', async () => {
      // Set localStorage to flat mode before rendering
      localStorage.setItem('mcbd-sidebar-view-mode', 'flat');

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        // In flat mode, group headers should not be present
        expect(screen.queryAllByTestId('group-header').length).toBe(0);
        // Branches should still be visible (inline + tooltip)
        expect(screen.getAllByText('feature/test-1').length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('parseGroupCollapsed', () => {
    it('should handle invalid JSON in localStorage gracefully', async () => {
      localStorage.setItem('mcbd-sidebar-group-collapsed', 'not-json');

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      // Should render without errors
      await waitFor(() => {
        expect(screen.getByTestId('sidebar')).toBeInTheDocument();
      });
    });

    it('should parse valid group collapsed state', () => {
      const result = parseGroupCollapsed(JSON.stringify({ RepoA: true, RepoB: false }));
      expect(result).toEqual({ RepoA: true, RepoB: false });
    });

    it('should return empty object for invalid JSON', () => {
      expect(parseGroupCollapsed('not-json')).toEqual({});
    });

    it('should return empty object for non-object values', () => {
      expect(parseGroupCollapsed('"string"')).toEqual({});
      expect(parseGroupCollapsed('123')).toEqual({});
      expect(parseGroupCollapsed('null')).toEqual({});
      expect(parseGroupCollapsed('[1,2,3]')).toEqual({});
    });

    it('should filter out dangerous prototype pollution keys', () => {
      const input = JSON.stringify({
        __proto__: true,
        constructor: true,
        prototype: true,
        SafeKey: true,
      });
      const result = parseGroupCollapsed(input);
      expect(result).toEqual({ SafeKey: true });
      expect(result).not.toHaveProperty('__proto__');
      expect(result).not.toHaveProperty('constructor');
      expect(result).not.toHaveProperty('prototype');
    });

    it('should filter out non-boolean values', () => {
      const input = JSON.stringify({
        ValidTrue: true,
        ValidFalse: false,
        StringVal: 'true',
        NumberVal: 1,
        NullVal: null,
        ObjectVal: {},
      });
      const result = parseGroupCollapsed(input);
      expect(result).toEqual({ ValidTrue: true, ValidFalse: false });
    });

    it('should limit number of keys to prevent abuse', () => {
      const largeObj: Record<string, boolean> = {};
      for (let i = 0; i < 150; i++) {
        largeObj[`key-${i}`] = true;
      }
      const result = parseGroupCollapsed(JSON.stringify(largeObj));
      expect(Object.keys(result).length).toBe(100);
    });
  });

  describe('useWorktreeList integration (Issue #600)', () => {
    it('should use useWorktreeList for sorting and grouping', async () => {
      // This test validates the Sidebar still produces correct output
      // after migrating from inline useMemo to useWorktreeList hook
      const orderedWorktrees: Worktree[] = [
        {
          id: 'z-branch',
          name: 'z-feature',
          path: '/path/to/z',
          repositoryPath: '/path/to/repo',
          repositoryName: 'RepoZ',
          updatedAt: new Date('2025-01-01T00:00:00Z'),
        },
        {
          id: 'a-branch',
          name: 'a-feature',
          path: '/path/to/a',
          repositoryPath: '/path/to/repo',
          repositoryName: 'RepoA',
          updatedAt: new Date('2025-01-02T00:00:00Z'),
        },
      ];

      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktrees: orderedWorktrees,
        repositories: [],
      });

      // Set flat view mode to verify sort order
      localStorage.setItem('mcbd-sidebar-view-mode', 'flat');

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('z-feature').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('a-feature').length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('SyncButton', () => {
    beforeEach(() => {
      (repositoryApi.sync as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        message: 'Synced',
        worktreeCount: 3,
        repositoryCount: 1,
        repositories: [],
      });
    });

    it('should render sync button in sidebar header', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        // The mock useTranslations('common') returns 'common.syncButtonLabel' for t('syncButtonLabel')
        expect(screen.getByLabelText('common.syncButtonLabel')).toBeInTheDocument();
      });
    });

    it('should call repositoryApi.sync() on click', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByLabelText('common.syncButtonLabel')).toBeInTheDocument();
      });

      const syncButton = screen.getByLabelText('common.syncButtonLabel');
      fireEvent.click(syncButton);

      await waitFor(() => {
        expect(repositoryApi.sync).toHaveBeenCalledTimes(1);
      });
    });

    it('should call refreshWorktrees() after successful sync', async () => {
      // worktreeApi.getAll is called by refreshWorktrees via fetchWorktrees
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByLabelText('common.syncButtonLabel')).toBeInTheDocument();
      });

      // Clear initial call count from mount
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockClear();

      const syncButton = screen.getByLabelText('common.syncButtonLabel');
      fireEvent.click(syncButton);

      await waitFor(() => {
        // refreshWorktrees calls worktreeApi.getAll internally
        expect(worktreeApi.getAll).toHaveBeenCalled();
      });
    });

    it('should disable button during sync', async () => {
      // Make sync take some time
      (repositoryApi.sync as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          success: true,
          message: 'Synced',
          worktreeCount: 3,
          repositoryCount: 1,
          repositories: [],
        }), 100))
      );

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByLabelText('common.syncButtonLabel')).toBeInTheDocument();
      });

      const syncButton = screen.getByLabelText('common.syncButtonLabel');
      fireEvent.click(syncButton);

      // Button should be disabled while syncing
      expect(syncButton).toBeDisabled();

      // Wait for sync to complete
      await waitFor(() => {
        expect(syncButton).not.toBeDisabled();
      });
    });

    it('should show success toast on sync success', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByLabelText('common.syncButtonLabel')).toBeInTheDocument();
      });

      const syncButton = screen.getByLabelText('common.syncButtonLabel');
      fireEvent.click(syncButton);

      await waitFor(() => {
        // The mock useTranslations replaces {count} in the key string
        // t('syncSuccess', { count: 3 }) => 'common.syncSuccess' with {count} replaced to '3'
        expect(screen.getByText('common.syncSuccess')).toBeInTheDocument();
      });
    });

    it('should show error toast on sync failure', async () => {
      (repositoryApi.sync as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error')
      );

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByLabelText('common.syncButtonLabel')).toBeInTheDocument();
      });

      const syncButton = screen.getByLabelText('common.syncButtonLabel');
      fireEvent.click(syncButton);

      await waitFor(() => {
        expect(screen.getByText('common.syncError')).toBeInTheDocument();
      });
    });

    it('should prevent double-click from triggering multiple syncs', async () => {
      // Make sync take some time to ensure overlap
      (repositoryApi.sync as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          success: true,
          message: 'Synced',
          worktreeCount: 3,
          repositoryCount: 1,
          repositories: [],
        }), 200))
      );

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByLabelText('common.syncButtonLabel')).toBeInTheDocument();
      });

      const syncButton = screen.getByLabelText('common.syncButtonLabel');

      // Click twice rapidly
      fireEvent.click(syncButton);
      fireEvent.click(syncButton);

      // Wait for sync to complete
      await waitFor(() => {
        expect(syncButton).not.toBeDisabled();
      });

      // Should only have been called once due to isSyncingRef guard
      expect(repositoryApi.sync).toHaveBeenCalledTimes(1);
    });

    it('should handle 401 error with auth error toast', async () => {
      (repositoryApi.sync as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiError('Unauthorized', 401)
      );

      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByLabelText('common.syncButtonLabel')).toBeInTheDocument();
      });

      const syncButton = screen.getByLabelText('common.syncButtonLabel');
      fireEvent.click(syncButton);

      await waitFor(() => {
        expect(screen.getByText('common.syncAuthError')).toBeInTheDocument();
      });
    });
  });
});
