/**
 * Tests for MemoCard component
 *
 * Tests individual memo card display and editing functionality.
 * Copy functionality tests (Issue #321) cover:
 * - Basic copy interaction and clipboard API call
 * - Copy/Check icon feedback transition
 * - Empty and whitespace-only content guards
 * - Rapid double-click timer deduplication (S1-004)
 * - Unmount safety during copy feedback (S1-005)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoCard } from '@/components/worktree/MemoCard';
import type { WorktreeMemo } from '@/types/models';

// Must match COPY_FEEDBACK_DURATION_MS in MemoCard.tsx
const COPY_FEEDBACK_DURATION_MS = 2000;

// Hoisted mock functions (vi.mock factories are hoisted above imports)
const { mockSaveNow, mockCopyToClipboard } = vi.hoisted(() => ({
  mockSaveNow: vi.fn(),
  mockCopyToClipboard: vi.fn(),
}));

// Mock useAutoSave hook
vi.mock('@/hooks/useAutoSave', () => ({
  useAutoSave: () => ({
    isSaving: false,
    error: null,
    saveNow: mockSaveNow,
  }),
}));

// Mock clipboard-utils
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: mockCopyToClipboard,
}));

/** Query the copy button by its aria-label */
function getCopyButton(): HTMLElement {
  return screen.getByRole('button', { name: /copy memo content/i });
}

/** Check whether the SVG icon inside a button has the green Check icon class */
function hasCheckIcon(button: HTMLElement): boolean {
  const svg = button.querySelector('svg');
  return svg?.classList.toString().includes('text-green-600') ?? false;
}

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

  describe('Copy functionality', () => {
    beforeEach(() => {
      mockCopyToClipboard.mockResolvedValue(undefined);
    });

    it('should render copy button with aria-label', () => {
      render(<MemoCard {...defaultProps} />);

      expect(getCopyButton()).toBeInTheDocument();
    });

    it('should call copyToClipboard with memo content when clicked', async () => {
      render(<MemoCard {...defaultProps} />);

      await act(async () => {
        fireEvent.click(getCopyButton());
      });

      expect(mockCopyToClipboard).toHaveBeenCalledWith('Test content');
    });

    it('should show Check icon after successful copy', async () => {
      render(<MemoCard {...defaultProps} />);

      await act(async () => {
        fireEvent.click(getCopyButton());
      });

      expect(hasCheckIcon(getCopyButton())).toBe(true);
    });

    describe('empty content guard', () => {
      it('should not call copyToClipboard when content is empty', async () => {
        render(<MemoCard {...defaultProps} memo={{ ...mockMemo, content: '' }} />);

        await act(async () => {
          fireEvent.click(getCopyButton());
        });

        expect(mockCopyToClipboard).not.toHaveBeenCalled();
      });

      it('should not call copyToClipboard when content is whitespace only', async () => {
        render(<MemoCard {...defaultProps} memo={{ ...mockMemo, content: '   ' }} />);

        await act(async () => {
          fireEvent.click(getCopyButton());
        });

        expect(mockCopyToClipboard).not.toHaveBeenCalled();
      });
    });

    describe('timer-based feedback', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should revert to Copy icon after feedback duration', async () => {
        render(<MemoCard {...defaultProps} />);

        const copyButton = getCopyButton();
        await act(async () => {
          fireEvent.click(copyButton);
        });

        expect(hasCheckIcon(copyButton)).toBe(true);

        await act(async () => {
          vi.advanceTimersByTime(COPY_FEEDBACK_DURATION_MS);
        });

        expect(hasCheckIcon(copyButton)).toBe(false);
      });

      it('should handle rapid double-click correctly (S1-004)', async () => {
        render(<MemoCard {...defaultProps} />);

        const copyButton = getCopyButton();

        // First click
        await act(async () => {
          fireEvent.click(copyButton);
        });

        // Second click immediately -- previous timer should be cleared
        await act(async () => {
          fireEvent.click(copyButton);
        });

        expect(mockCopyToClipboard).toHaveBeenCalledTimes(2);

        // After feedback duration, icon should revert (single timer, not doubled)
        await act(async () => {
          vi.advanceTimersByTime(COPY_FEEDBACK_DURATION_MS);
        });

        expect(hasCheckIcon(copyButton)).toBe(false);
      });

      it('should safely handle unmount during copy feedback (S1-005)', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error');

        const { unmount } = render(<MemoCard {...defaultProps} />);

        await act(async () => {
          fireEvent.click(getCopyButton());
        });

        // Unmount while the feedback timer is still pending
        unmount();

        // Advancing timers after unmount should not trigger React state-update warnings
        await act(async () => {
          vi.advanceTimersByTime(COPY_FEEDBACK_DURATION_MS);
        });

        // Verify no React "state update on unmounted component" warnings were logged
        const reactWarnings = consoleErrorSpy.mock.calls.filter(
          (args) => typeof args[0] === 'string' && args[0].includes('unmounted')
        );
        expect(reactWarnings).toHaveLength(0);
      });
    });
  });
});
