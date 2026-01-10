/**
 * Tests for MemoAddButton component
 *
 * Tests the add memo button with remaining count display
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoAddButton } from '@/components/worktree/MemoAddButton';

describe('MemoAddButton', () => {
  const defaultProps = {
    currentCount: 2,
    maxCount: 5,
    onAdd: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render add button', () => {
      render(<MemoAddButton {...defaultProps} />);

      expect(screen.getByRole('button', { name: /add memo/i })).toBeInTheDocument();
    });

    it('should display remaining count', () => {
      render(<MemoAddButton {...defaultProps} currentCount={2} maxCount={5} />);

      expect(screen.getByText(/3/)).toBeInTheDocument();
    });

    it('should show proper remaining text format', () => {
      render(<MemoAddButton {...defaultProps} currentCount={1} maxCount={5} />);

      // Should display something like "4 remaining" or "remaining 4"
      expect(screen.getByText(/4/)).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<MemoAddButton {...defaultProps} className="custom-class" />);

      const container = screen.getByTestId('memo-add-button');
      expect(container).toHaveClass('custom-class');
    });
  });

  describe('Click handling', () => {
    it('should call onAdd when clicked', () => {
      const onAdd = vi.fn();
      render(<MemoAddButton {...defaultProps} onAdd={onAdd} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      fireEvent.click(button);

      expect(onAdd).toHaveBeenCalledTimes(1);
    });

    it('should not call onAdd when disabled', () => {
      const onAdd = vi.fn();
      render(<MemoAddButton {...defaultProps} onAdd={onAdd} currentCount={5} maxCount={5} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      fireEvent.click(button);

      expect(onAdd).not.toHaveBeenCalled();
    });
  });

  describe('Disabled state', () => {
    it('should be disabled when currentCount equals maxCount', () => {
      render(<MemoAddButton {...defaultProps} currentCount={5} maxCount={5} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button).toBeDisabled();
    });

    it('should be enabled when currentCount is less than maxCount', () => {
      render(<MemoAddButton {...defaultProps} currentCount={4} maxCount={5} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button).not.toBeDisabled();
    });

    it('should show zero remaining when at limit', () => {
      render(<MemoAddButton {...defaultProps} currentCount={5} maxCount={5} />);

      expect(screen.getByText(/0/)).toBeInTheDocument();
    });
  });

  describe('Loading state', () => {
    it('should show loading indicator when isLoading is true', () => {
      render(<MemoAddButton {...defaultProps} isLoading />);

      expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    });

    it('should be disabled when isLoading is true', () => {
      render(<MemoAddButton {...defaultProps} isLoading />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button).toBeDisabled();
    });
  });

  describe('Icon display', () => {
    it('should display plus icon', () => {
      render(<MemoAddButton {...defaultProps} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button.querySelector('svg')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('should have button styling', () => {
      render(<MemoAddButton {...defaultProps} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button.className).toMatch(/bg-|border-|rounded/);
    });

    it('should have disabled styling when at limit', () => {
      render(<MemoAddButton {...defaultProps} currentCount={5} maxCount={5} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button.className).toMatch(/opacity-|cursor-not-allowed|disabled/);
    });
  });

  describe('Accessibility', () => {
    it('should have accessible label', () => {
      render(<MemoAddButton {...defaultProps} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button).toHaveAccessibleName();
    });

    it('should indicate disabled state accessibly', () => {
      render(<MemoAddButton {...defaultProps} currentCount={5} maxCount={5} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button).toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('Edge cases', () => {
    it('should handle zero current count', () => {
      render(<MemoAddButton {...defaultProps} currentCount={0} maxCount={5} />);

      expect(screen.getByText(/5/)).toBeInTheDocument();
      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button).not.toBeDisabled();
    });

    it('should handle currentCount greater than maxCount gracefully', () => {
      render(<MemoAddButton {...defaultProps} currentCount={6} maxCount={5} />);

      const button = screen.getByRole('button', { name: /add memo/i });
      expect(button).toBeDisabled();
    });
  });
});
