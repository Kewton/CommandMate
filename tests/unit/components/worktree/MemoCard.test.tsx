/**
 * Tests for MemoCard component
 *
 * Tests individual memo card display and editing functionality
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoCard } from '@/components/worktree/MemoCard';
import type { WorktreeMemo } from '@/types/models';

// Mock useAutoSave hook
const mockSaveNow = vi.fn();
vi.mock('@/hooks/useAutoSave', () => ({
  useAutoSave: () => ({
    isSaving: false,
    error: null,
    saveNow: mockSaveNow,
  }),
}));

describe('MemoCard', () => {
  const mockMemo: WorktreeMemo = {
    id: 'memo-1',
    worktreeId: 'worktree-1',
    title: 'Test Memo',
    content: 'Test content',
    position: 0,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
  };

  const defaultProps = {
    memo: mockMemo,
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render memo title', () => {
      render(<MemoCard {...defaultProps} />);

      expect(screen.getByDisplayValue('Test Memo')).toBeInTheDocument();
    });

    it('should render memo content', () => {
      render(<MemoCard {...defaultProps} />);

      expect(screen.getByDisplayValue('Test content')).toBeInTheDocument();
    });

    it('should render delete button', () => {
      render(<MemoCard {...defaultProps} />);

      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<MemoCard {...defaultProps} className="custom-class" />);

      const card = screen.getByTestId('memo-card');
      expect(card).toHaveClass('custom-class');
    });
  });

  describe('Title editing', () => {
    it('should allow editing title', () => {
      render(<MemoCard {...defaultProps} />);

      const titleInput = screen.getByDisplayValue('Test Memo');
      fireEvent.change(titleInput, { target: { value: 'Updated Title' } });

      expect(screen.getByDisplayValue('Updated Title')).toBeInTheDocument();
    });

    it('should call saveNow when title loses focus', async () => {
      render(<MemoCard {...defaultProps} />);

      const titleInput = screen.getByDisplayValue('Test Memo');
      fireEvent.change(titleInput, { target: { value: 'Updated Title' } });
      fireEvent.blur(titleInput);

      await waitFor(() => {
        expect(mockSaveNow).toHaveBeenCalled();
      });
    });
  });

  describe('Content editing', () => {
    it('should render content as textarea', () => {
      render(<MemoCard {...defaultProps} />);

      const textarea = screen.getByDisplayValue('Test content');
      expect(textarea.tagName).toBe('TEXTAREA');
    });

    it('should allow editing content', () => {
      render(<MemoCard {...defaultProps} />);

      const contentTextarea = screen.getByDisplayValue('Test content');
      fireEvent.change(contentTextarea, { target: { value: 'Updated content' } });

      expect(screen.getByDisplayValue('Updated content')).toBeInTheDocument();
    });

    it('should call saveNow when content loses focus', async () => {
      render(<MemoCard {...defaultProps} />);

      const contentTextarea = screen.getByDisplayValue('Test content');
      fireEvent.change(contentTextarea, { target: { value: 'Updated content' } });
      fireEvent.blur(contentTextarea);

      await waitFor(() => {
        expect(mockSaveNow).toHaveBeenCalled();
      });
    });
  });

  describe('Delete functionality', () => {
    it('should call onDelete when delete button is clicked', () => {
      const onDelete = vi.fn();
      render(<MemoCard {...defaultProps} onDelete={onDelete} />);

      const deleteButton = screen.getByRole('button', { name: /delete/i });
      fireEvent.click(deleteButton);

      expect(onDelete).toHaveBeenCalledWith('memo-1');
    });
  });

  describe('Saving indicator', () => {
    it('should show saving indicator when isSaving is true', () => {
      render(<MemoCard {...defaultProps} isSaving />);

      expect(screen.getByTestId('saving-indicator')).toBeInTheDocument();
    });

    it('should not show saving indicator when isSaving is false', () => {
      render(<MemoCard {...defaultProps} />);

      expect(screen.queryByTestId('saving-indicator')).not.toBeInTheDocument();
    });
  });

  describe('Error state', () => {
    it('should show error message when there is an error', () => {
      render(<MemoCard {...defaultProps} error="Save failed" />);

      expect(screen.getByText(/save failed/i)).toBeInTheDocument();
    });
  });

  describe('Empty content', () => {
    it('should show placeholder when content is empty', () => {
      const memoWithEmptyContent = {
        ...mockMemo,
        content: '',
      };
      render(<MemoCard {...defaultProps} memo={memoWithEmptyContent} />);

      const textarea = screen.getByPlaceholderText(/enter memo content/i);
      expect(textarea).toBeInTheDocument();
    });
  });

  describe('Keyboard accessibility', () => {
    it('should be focusable', () => {
      render(<MemoCard {...defaultProps} />);

      const titleInput = screen.getByDisplayValue('Test Memo');
      titleInput.focus();

      expect(document.activeElement).toBe(titleInput);
    });
  });

  describe('Styling', () => {
    it('should have card styling', () => {
      render(<MemoCard {...defaultProps} />);

      const card = screen.getByTestId('memo-card');
      expect(card.className).toMatch(/rounded|border|bg-/);
    });

    it('should have proper spacing', () => {
      render(<MemoCard {...defaultProps} />);

      const card = screen.getByTestId('memo-card');
      expect(card.className).toMatch(/p-\d|space-y-/);
    });
  });
});
