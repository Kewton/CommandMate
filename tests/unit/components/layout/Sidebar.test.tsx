/**
 * Tests for Sidebar component
 *
 * Tests the sidebar with branch list
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
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
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
        expect(screen.getByText('feature/test-2')).toBeInTheDocument();
        expect(screen.getByText('main')).toBeInTheDocument();
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
        expect(repoNames.length).toBe(3);
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
        expect(sidebar.className).toMatch(/bg-gray-900|bg-slate-900|bg-zinc-900/);
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
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
      });

      // Click on a branch
      const branchItem = screen.getByText('feature/test-1').closest('[data-testid="branch-list-item"]');
      if (branchItem) {
        fireEvent.click(branchItem);
      }

      // Branch should still be visible after click
      expect(screen.getByText('feature/test-1')).toBeInTheDocument();
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
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
      });

      // Type in search input
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'test-1' } });

      // Should show only matching branch
      await waitFor(() => {
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
        expect(screen.queryByText('feature/test-2')).not.toBeInTheDocument();
        expect(screen.queryByText('main')).not.toBeInTheDocument();
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
        expect(screen.getByText('feature/other')).toBeInTheDocument();
      });

      // Type in search input for repository name
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'OtherRepo' } });

      // Should show only matching branch
      await waitFor(() => {
        expect(screen.getByText('feature/other')).toBeInTheDocument();
        expect(screen.queryByText('feature/test-1')).not.toBeInTheDocument();
      });
    });

    it('should show no branches found when search has no results', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
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
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
      });

      // Type and then clear search input
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'test-1' } });

      await waitFor(() => {
        expect(screen.queryByText('main')).not.toBeInTheDocument();
      });

      fireEvent.change(searchInput, { target: { value: '' } });

      // Should show all branches again
      await waitFor(() => {
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
        expect(screen.getByText('feature/test-2')).toBeInTheDocument();
        expect(screen.getByText('main')).toBeInTheDocument();
      });
    });

    it('should handle case-insensitive search', async () => {
      render(
        <Wrapper>
          <Sidebar />
        </Wrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
      });

      // Type in search input with different case
      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: 'FEATURE' } });

      // Should show matching branches (case-insensitive)
      await waitFor(() => {
        expect(screen.getByText('feature/test-1')).toBeInTheDocument();
        expect(screen.getByText('feature/test-2')).toBeInTheDocument();
        expect(screen.queryByText('main')).not.toBeInTheDocument();
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
});
