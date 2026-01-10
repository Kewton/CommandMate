/**
 * Tests for Sidebar component
 *
 * Tests the sidebar with branch list
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { SidebarProvider } from '@/contexts/SidebarContext';
import { WorktreeSelectionProvider } from '@/contexts/WorktreeSelectionContext';
import type { Worktree } from '@/types/models';

// Mock the API client
vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    getAll: vi.fn(),
    getById: vi.fn(),
  },
}));

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
  });
});
