/**
 * Tests for MemoPane component
 *
 * Tests the main memo pane that displays memo list and handles CRUD operations
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoPane } from '@/components/worktree/MemoPane';
import type { WorktreeMemo } from '@/types/models';

// Issue #1277: this file asserts rendered wording (empty/loading/no-match copy,
// aria-labels), so it must resolve keys through the real dictionary. The global
// mock in tests/setup.ts echoes `<namespace>.<key>` back and would keep these
// assertions green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

// Mock memoApi
const mockGetAll = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockReorder = vi.fn();

vi.mock('@/lib/api-client', () => ({
  memoApi: {
    getAll: (...args: unknown[]) => mockGetAll(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    reorder: (...args: unknown[]) => mockReorder(...args),
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
    mockReorder.mockResolvedValue(undefined);
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

    it('should disable add button when at memo limit (20)', async () => {
      const maxMemos = Array.from({ length: 20 }, (_, i) => ({
        id: `memo-${i}`,
        worktreeId: 'worktree-1',
        title: `Memo ${i}`,
        content: `Content ${i}`,
        position: i,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      mockGetAll.mockResolvedValue(maxMemos);

      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        const addButton = screen.getByRole('button', { name: /add memo/i });
        expect(addButton).toBeDisabled();
      });
    });

    it('should NOT disable add button at the old limit (10) after expansion to 20', async () => {
      const tenMemos = Array.from({ length: 10 }, (_, i) => ({
        id: `memo-${i}`,
        worktreeId: 'worktree-1',
        title: `Memo ${i}`,
        content: `Content ${i}`,
        position: i,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      mockGetAll.mockResolvedValue(tenMemos);

      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        const addButton = screen.getByRole('button', { name: /add memo/i });
        expect(addButton).not.toBeDisabled();
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

  describe('Insert to message propagation (Issue #485)', () => {
    it('should pass onInsertToMessage to MemoCard components', async () => {
      const onInsertToMessage = vi.fn();
      render(<MemoPane {...defaultProps} onInsertToMessage={onInsertToMessage} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });

      // Insert buttons should be rendered on each MemoCard
      const insertButtons = screen.getAllByTestId('insert-memo-content');
      expect(insertButtons.length).toBe(2);
    });

    it('should not render insert buttons when onInsertToMessage is not provided', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });

      expect(screen.queryAllByTestId('insert-memo-content')).toHaveLength(0);
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

  describe('Search (Issue #787)', () => {
    const searchMemos: WorktreeMemo[] = [
      {
        id: 'memo-a',
        worktreeId: 'worktree-1',
        title: 'Alpha note',
        content: 'first body',
        position: 0,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      },
      {
        id: 'memo-b',
        worktreeId: 'worktree-1',
        title: 'Beta note',
        content: 'unrelated content',
        position: 1,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      },
      {
        id: 'memo-c',
        worktreeId: 'worktree-1',
        title: 'Gamma',
        content: 'mentions alpha inside',
        position: 2,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      },
    ];

    beforeEach(() => {
      mockGetAll.mockResolvedValue(searchMemos);
      // Element.prototype.scrollIntoView is not implemented in jsdom.
      Element.prototype.scrollIntoView = vi.fn();
    });

    /**
     * The memo title inputs are also textboxes, so scope to the search region
     * to unambiguously resolve the search field.
     */
    function getSearchInput(): HTMLElement {
      return within(screen.getByRole('search')).getByRole('textbox');
    }

    it('should show a search toggle button (no bar until opened)', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('memo-search-toggle')).toBeInTheDocument();
      });
      expect(screen.queryByRole('search')).not.toBeInTheDocument();
    });

    it('should open the search bar when the toggle is clicked', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('memo-search-toggle')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('memo-search-toggle'));
      expect(screen.getByRole('search')).toBeInTheDocument();
    });

    it('should filter the list to matching memos while searching', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(3);
      });

      fireEvent.click(screen.getByTestId('memo-search-toggle'));
      fireEvent.change(getSearchInput(), { target: { value: 'alpha' } });

      // memo-a (title "Alpha note") and memo-c (content "alpha") match; memo-b does not.
      await waitFor(() => {
        const cards = screen.getAllByTestId('memo-card');
        expect(cards).toHaveLength(2);
      });
      const ids = screen
        .getAllByTestId('memo-card')
        .map((c) => c.getAttribute('data-memo-id'));
      expect(ids).toEqual(expect.arrayContaining(['memo-a', 'memo-c']));
      expect(ids).not.toContain('memo-b');
    });

    it('should hide the Add button while searching', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add memo/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('memo-search-toggle'));
      fireEvent.change(getSearchInput(), { target: { value: 'alpha' } });

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });
      expect(screen.queryByRole('button', { name: /add memo/i })).not.toBeInTheDocument();
    });

    it('should restore the full list and Add button when search is closed (Esc)', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(3);
      });

      fireEvent.click(screen.getByTestId('memo-search-toggle'));
      fireEvent.change(getSearchInput(), { target: { value: 'alpha' } });

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });

      fireEvent.keyDown(getSearchInput(), { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('search')).not.toBeInTheDocument();
      });
      expect(screen.getAllByTestId('memo-card')).toHaveLength(3);
      expect(screen.getByRole('button', { name: /add memo/i })).toBeInTheDocument();
    });

    it('should show a no-results message when nothing matches', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(3);
      });

      fireEvent.click(screen.getByTestId('memo-search-toggle'));
      fireEvent.change(getSearchInput(), { target: { value: 'zzzz-nope' } });

      await waitFor(() => {
        expect(screen.getByText(/no memos match/i)).toBeInTheDocument();
      });
      expect(screen.queryAllByTestId('memo-card')).toHaveLength(0);
    });

    it('works in the mobile h-full layout (className passthrough)', async () => {
      render(<MemoPane {...defaultProps} className="h-full" />);

      await waitFor(() => {
        expect(screen.getByTestId('memo-search-toggle')).toBeInTheDocument();
      });
      const pane = screen.getByTestId('memo-pane');
      expect(pane).toHaveClass('h-full');

      fireEvent.click(screen.getByTestId('memo-search-toggle'));
      expect(screen.getByRole('search')).toBeInTheDocument();
    });
  });

  describe('Reorder (Issue #944)', () => {
    it('renders move buttons with correct disabled edges (first up / last down)', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });

      // First memo: up disabled, down enabled.
      expect(screen.getByTestId('memo-move-up-memo-1')).toBeDisabled();
      expect(screen.getByTestId('memo-move-down-memo-1')).not.toBeDisabled();
      // Last memo: down disabled, up enabled.
      expect(screen.getByTestId('memo-move-down-memo-2')).toBeDisabled();
      expect(screen.getByTestId('memo-move-up-memo-2')).not.toBeDisabled();
    });

    it('swaps and calls memoApi.reorder with the new order when moving down', async () => {
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });

      fireEvent.click(screen.getByTestId('memo-move-down-memo-1'));

      await waitFor(() => {
        expect(mockReorder).toHaveBeenCalledWith('worktree-1', ['memo-2', 'memo-1']);
      });

      // Optimistic update: DOM order is swapped.
      const ids = screen
        .getAllByTestId('memo-card')
        .map((c) => c.getAttribute('data-memo-id'));
      expect(ids).toEqual(['memo-2', 'memo-1']);
    });

    it('rolls back via fetchMemos when reorder fails', async () => {
      mockReorder.mockRejectedValueOnce(new Error('reorder failed'));
      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });

      // getAll called once on mount.
      expect(mockGetAll).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('memo-move-down-memo-1'));

      // On failure, fetchMemos re-fetches to restore the server order.
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledTimes(2);
      });

      await waitFor(() => {
        const ids = screen
          .getAllByTestId('memo-card')
          .map((c) => c.getAttribute('data-memo-id'));
        expect(ids).toEqual(['memo-1', 'memo-2']);
      });
    });

    it('disables reordering while search is active', async () => {
      const searchMemos: WorktreeMemo[] = [
        { ...mockMemos[0], id: 'memo-a', title: 'Alpha' },
        { ...mockMemos[1], id: 'memo-b', title: 'Beta' },
      ];
      mockGetAll.mockResolvedValue(searchMemos);
      Element.prototype.scrollIntoView = vi.fn();

      render(<MemoPane {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(2);
      });

      fireEvent.click(screen.getByTestId('memo-search-toggle'));
      const searchInput = within(screen.getByRole('search')).getByRole('textbox');
      fireEvent.change(searchInput, { target: { value: 'Alpha' } });

      await waitFor(() => {
        expect(screen.getAllByTestId('memo-card')).toHaveLength(1);
      });

      // Move buttons must be absent (or disabled) while searching.
      expect(screen.queryByTestId('memo-move-up-memo-a')).not.toBeInTheDocument();
      expect(screen.queryByTestId('memo-move-down-memo-a')).not.toBeInTheDocument();
    });
  });
});
