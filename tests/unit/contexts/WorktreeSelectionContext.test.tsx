/**
 * Tests for WorktreeSelectionContext
 *
 * Tests the worktree selection state management context
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  WorktreeSelectionProvider,
  useWorktreeSelection,
} from '@/contexts/WorktreeSelectionContext';
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
  },
  {
    id: 'feature-test-2',
    name: 'feature/test-2',
    path: '/path/to/worktree2',
    repositoryPath: '/path/to/repo',
    repositoryName: 'MyRepo',
  },
];

// Test component to access context
function TestConsumer() {
  const context = useWorktreeSelection();
  return (
    <div>
      <span data-testid="selectedWorktreeId">{context.selectedWorktreeId ?? 'null'}</span>
      <span data-testid="worktreeCount">{context.worktrees.length}</span>
      <span data-testid="isLoadingDetail">{String(context.isLoadingDetail)}</span>
      <span data-testid="error">{context.error ?? 'null'}</span>
      <button
        data-testid="selectWorktree"
        onClick={() => context.selectWorktree('feature-test-1')}
      >
        Select
      </button>
      <button
        data-testid="refreshWorktrees"
        onClick={() => context.refreshWorktrees()}
      >
        Refresh
      </button>
    </div>
  );
}

describe('WorktreeSelectionContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementation
    (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
      worktrees: mockWorktrees,
      repositories: [],
    });
    (worktreeApi.getById as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorktrees[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('WorktreeSelectionProvider', () => {
    it('should provide initial empty state', async () => {
      render(
        <WorktreeSelectionProvider>
          <TestConsumer />
        </WorktreeSelectionProvider>
      );

      // Initially loading
      await waitFor(() => {
        expect(screen.getByTestId('selectedWorktreeId').textContent).toBe('null');
      });
    });

    it('should fetch worktrees on mount', async () => {
      render(
        <WorktreeSelectionProvider>
          <TestConsumer />
        </WorktreeSelectionProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('worktreeCount').textContent).toBe('2');
      });

      expect(worktreeApi.getAll).toHaveBeenCalled();
    });

    it('should select a worktree', async () => {
      render(
        <WorktreeSelectionProvider>
          <TestConsumer />
        </WorktreeSelectionProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('worktreeCount').textContent).toBe('2');
      });

      act(() => {
        screen.getByTestId('selectWorktree').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('selectedWorktreeId').textContent).toBe('feature-test-1');
      });
    });

    it('should show loading state while fetching worktree detail', async () => {
      // Make the getById call take some time
      (worktreeApi.getById as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockWorktrees[0]), 100))
      );

      render(
        <WorktreeSelectionProvider>
          <TestConsumer />
        </WorktreeSelectionProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('worktreeCount').textContent).toBe('2');
      });

      act(() => {
        screen.getByTestId('selectWorktree').click();
      });

      // Should show loading immediately
      expect(screen.getByTestId('isLoadingDetail').textContent).toBe('true');

      await waitFor(() => {
        expect(screen.getByTestId('isLoadingDetail').textContent).toBe('false');
      });
    });

    it('should refresh worktrees', async () => {
      render(
        <WorktreeSelectionProvider>
          <TestConsumer />
        </WorktreeSelectionProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('worktreeCount').textContent).toBe('2');
      });

      // Update mock to return different data
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockResolvedValue({
        worktrees: [...mockWorktrees, {
          id: 'feature-test-3',
          name: 'feature/test-3',
          path: '/path/to/worktree3',
          repositoryPath: '/path/to/repo',
          repositoryName: 'MyRepo',
        }],
        repositories: [],
      });

      act(() => {
        screen.getByTestId('refreshWorktrees').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('worktreeCount').textContent).toBe('3');
      });
    });

    it('should handle fetch error', async () => {
      (worktreeApi.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error')
      );

      render(
        <WorktreeSelectionProvider>
          <TestConsumer />
        </WorktreeSelectionProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('error').textContent).not.toBe('null');
      });
    });
  });

  describe('useWorktreeSelection', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useWorktreeSelection must be used within a WorktreeSelectionProvider');

      consoleSpy.mockRestore();
    });
  });

  describe('Optimistic UI updates', () => {
    it('should immediately update selectedWorktreeId before API call completes', async () => {
      // Make the getById call take some time
      let resolveGetById: (value: Worktree) => void;
      (worktreeApi.getById as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => { resolveGetById = resolve; })
      );

      render(
        <WorktreeSelectionProvider>
          <TestConsumer />
        </WorktreeSelectionProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('worktreeCount').textContent).toBe('2');
      });

      act(() => {
        screen.getByTestId('selectWorktree').click();
      });

      // Should immediately update the selected ID (optimistic update)
      expect(screen.getByTestId('selectedWorktreeId').textContent).toBe('feature-test-1');
      expect(screen.getByTestId('isLoadingDetail').textContent).toBe('true');

      // Now resolve the API call
      act(() => {
        resolveGetById!(mockWorktrees[0]);
      });

      await waitFor(() => {
        expect(screen.getByTestId('isLoadingDetail').textContent).toBe('false');
      });
    });
  });
});
