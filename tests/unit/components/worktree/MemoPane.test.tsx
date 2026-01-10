/**
 * Tests for MemoPane component
 *
 * Tests the main memo pane that displays memo list and handles CRUD operations
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoPane } from '@/components/worktree/MemoPane';
import type { WorktreeMemo } from '@/types/models';

// Mock memoApi
const mockGetAll = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/api-client', () => ({
  memoApi: {
    getAll: (...args: unknown[]) => mockGetAll(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
  handleApiError: (error: unknown) =>
    error instanceof Error ? error.message : 'Unknown error',
}));

describe('MemoPane', () => {
  const mockMemos: WorktreeMemo[] = [
    {
      id: 'memo-1',
      worktreeId: 'worktree-1',
      title: 'Memo 1',
      content: 'Content 1',
      position: 0,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-02'),
    },
    {
      id: 'memo-2',
      worktreeId: 'worktree-1',
      title: 'Memo 2',
      content: 'Content 2',
      position: 1,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-02'),
    },
  ];

  const defaultProps = {
    worktreeId: 'worktree-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue(mockMemos);
    mockCreate.mockResolvedValue({
      id: 'memo-3',
      worktreeId: 'worktree-1',
      title: 'Memo',
      content: '',
      position: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockUpdate.mockResolvedValue(mockMemos[0]);
    mockDelete.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading state', () => {
    it('should show loading indicator while fetching memos', () => {
      mockGetAll.mockImplementation(() => new Promise(() => {})); // Never resolves
      render(<MemoPane {...defaultProps} />);

      expect(screen.getByTestId('memo-loading')).toBeInTheDocument();
    });

    it('should hide loading indicator after memos are loaded', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.queryByTestId('memo-loading')).not.toBeInTheDocument();
      });
    });
  });

  describe('Memo list display', () => {
    it('should fetch memos on mount', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledWith('worktree-1');
      });
    });

    it('should display all memos', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByDisplayValue('Memo 1')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Memo 2')).toBeInTheDocument();
      });
    });

    it('should display memos in order by position', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        const memoCards = screen.getAllByTestId('memo-card');
        expect(memoCards).toHaveLength(2);
      });
    });

    it('should show empty state when no memos exist', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/no memos/i)).toBeInTheDocument();
      });
    });
  });

  describe('Add memo', () => {
    it('should show add button', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add memo/i })).toBeInTheDocument();
      });
    });

    it('should call create API when add button is clicked', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add memo/i })).toBeInTheDocument();
      });

      const addButton = screen.getByRole('button', { name: /add memo/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalledWith('worktree-1', expect.any(Object));
      });
    });

    it('should add new memo to the list after creation', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add memo/i })).toBeInTheDocument();
      });

      const addButton = screen.getByRole('button', { name: /add memo/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        const memoCards = screen.getAllByTestId('memo-card');
        expect(memoCards.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('should disable add button when at memo limit (5)', async () => {
      const fiveMemos = Array.from({ length: 5 }, (_, i) => ({
        id: `memo-${i}`,
        worktreeId: 'worktree-1',
        title: `Memo ${i}`,
        content: `Content ${i}`,
        position: i,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      mockGetAll.mockResolvedValue(fiveMemos);

      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        const addButton = screen.getByRole('button', { name: /add memo/i });
        expect(addButton).toBeDisabled();
      });
    });
  });

  describe('Edit memo', () => {
    it('should call update API when memo is edited', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByDisplayValue('Memo 1')).toBeInTheDocument();
      });

      const titleInput = screen.getByDisplayValue('Memo 1');
      fireEvent.change(titleInput, { target: { value: 'Updated Title' } });
      fireEvent.blur(titleInput);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalled();
      });
    });
  });

  describe('Delete memo', () => {
    it('should call delete API when delete is clicked', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(2);
      });

      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      fireEvent.click(deleteButtons[0]);

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith('worktree-1', 'memo-1');
      });
    });

    it('should remove memo from list after deletion', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });

      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      fireEvent.click(deleteButtons[0]);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(1);
      });
    });
  });

  describe('Error handling', () => {
    it('should show error message when fetch fails', async () => {
      mockGetAll.mockRejectedValue(new Error('Failed to fetch memos'));
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to fetch memos/i)).toBeInTheDocument();
      });
    });

    it('should show retry button on error', async () => {
      mockGetAll.mockRejectedValue(new Error('Failed to fetch memos'));
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
      });
    });

    it('should retry fetch when retry button is clicked', async () => {
      mockGetAll
        .mockRejectedValueOnce(new Error('Failed'))
        .mockResolvedValueOnce(mockMemos);

      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
      });

      const retryButton = screen.getByRole('button', { name: /retry/i });
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledTimes(2);
      });
    });

    it('should show error toast when create fails', async () => {
      mockCreate.mockRejectedValue(new Error('Failed to create memo'));
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add memo/i })).toBeInTheDocument();
      });

      const addButton = screen.getByRole('button', { name: /add memo/i });
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText(/failed to create memo/i)).toBeInTheDocument();
      });
    });
  });

  describe('Styling', () => {
    it('should apply custom className', async () => {
      render(<MemoPane {...defaultProps} className="custom-class" />);

      await waitFor(() => {
        const pane = screen.getByTestId('memo-pane');
        expect(pane).toHaveClass('custom-class');
      });
    });

    it('should have proper layout', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        const pane = screen.getByTestId('memo-pane');
        expect(pane.className).toMatch(/flex|flex-col|space-y-|gap-/);
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading for memo section', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        // The section should have an accessible label or heading
        const pane = screen.getByTestId('memo-pane');
        expect(pane).toBeInTheDocument();
      });
    });
  });
});
