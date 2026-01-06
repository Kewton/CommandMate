/**
 * Tests for PaneResizer component
 *
 * Tests the draggable resizer for adjusting pane widths
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaneResizer } from '@/components/worktree/PaneResizer';

describe('PaneResizer', () => {
  const mockOnResize = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render resizer element', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      expect(screen.getByRole('separator')).toBeInTheDocument();
    });

    it('should have accessible role="separator"', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');
      expect(separator).toHaveAttribute('aria-orientation');
    });

    it('should have aria-valuenow for screen readers', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');
      expect(separator).toHaveAttribute('aria-valuenow');
    });
  });

  describe('Orientation', () => {
    it('should default to horizontal orientation', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');
      expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    });

    it('should accept horizontal orientation', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');
      expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    });

    it('should accept vertical orientation', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      const separator = screen.getByRole('separator');
      expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    });
  });

  describe('Cursor styling', () => {
    it('should have col-resize cursor for horizontal orientation', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');
      expect(separator.className).toMatch(/col-resize|cursor-col-resize/);
    });

    it('should have row-resize cursor for vertical orientation', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      const separator = screen.getByRole('separator');
      expect(separator.className).toMatch(/row-resize|cursor-row-resize/);
    });
  });

  describe('Drag behavior', () => {
    it('should call onResize when dragged horizontally', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');

      // Start drag
      fireEvent.mouseDown(separator, { clientX: 100, clientY: 50 });
      // Move mouse
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 });
      // End drag
      fireEvent.mouseUp(document);

      expect(mockOnResize).toHaveBeenCalled();
    });

    it('should call onResize when dragged vertically', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      const separator = screen.getByRole('separator');

      // Start drag
      fireEvent.mouseDown(separator, { clientX: 50, clientY: 100 });
      // Move mouse
      fireEvent.mouseMove(document, { clientX: 50, clientY: 150 });
      // End drag
      fireEvent.mouseUp(document);

      expect(mockOnResize).toHaveBeenCalled();
    });

    it('should calculate correct delta for horizontal drag', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');

      fireEvent.mouseDown(separator, { clientX: 100, clientY: 50 });
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 });
      fireEvent.mouseUp(document);

      // Delta should be 50 (150 - 100)
      expect(mockOnResize).toHaveBeenCalledWith(50);
    });

    it('should calculate correct delta for vertical drag', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      const separator = screen.getByRole('separator');

      fireEvent.mouseDown(separator, { clientX: 50, clientY: 100 });
      fireEvent.mouseMove(document, { clientX: 50, clientY: 180 });
      fireEvent.mouseUp(document);

      // Delta should be 80 (180 - 100)
      expect(mockOnResize).toHaveBeenCalledWith(80);
    });

    it('should handle negative delta (drag left/up)', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');

      fireEvent.mouseDown(separator, { clientX: 150, clientY: 50 });
      fireEvent.mouseMove(document, { clientX: 100, clientY: 50 });
      fireEvent.mouseUp(document);

      // Delta should be -50 (100 - 150)
      expect(mockOnResize).toHaveBeenCalledWith(-50);
    });
  });

  describe('Visual feedback during drag', () => {
    it('should show dragging state visually', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');

      fireEvent.mouseDown(separator, { clientX: 100, clientY: 50 });

      // Should have visual indication of dragging
      expect(separator.className).toMatch(/dragging|active|bg-blue/);

      fireEvent.mouseUp(document);

      // Should remove dragging state
      expect(separator.className).not.toMatch(/dragging/);
    });
  });

  describe('Keyboard accessibility', () => {
    it('should be focusable', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');
      expect(separator).toHaveAttribute('tabIndex', '0');
    });

    it('should handle ArrowRight key for horizontal resizing', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');

      separator.focus();
      fireEvent.keyDown(separator, { key: 'ArrowRight' });

      expect(mockOnResize).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should handle ArrowLeft key for horizontal resizing', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');

      separator.focus();
      fireEvent.keyDown(separator, { key: 'ArrowLeft' });

      expect(mockOnResize).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should handle ArrowDown key for vertical resizing', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      const separator = screen.getByRole('separator');

      separator.focus();
      fireEvent.keyDown(separator, { key: 'ArrowDown' });

      expect(mockOnResize).toHaveBeenCalledWith(expect.any(Number));
    });

    it('should handle ArrowUp key for vertical resizing', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      const separator = screen.getByRole('separator');

      separator.focus();
      fireEvent.keyDown(separator, { key: 'ArrowUp' });

      expect(mockOnResize).toHaveBeenCalledWith(expect.any(Number));
    });
  });

  describe('Styling', () => {
    it('should have appropriate width for horizontal resizer', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');
      expect(separator.className).toMatch(/w-1|w-2|w-\[/);
    });

    it('should have appropriate height for vertical resizer', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      const separator = screen.getByRole('separator');
      expect(separator.className).toMatch(/h-1|h-2|h-\[/);
    });

    it('should have hover effect', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');
      expect(separator.className).toMatch(/hover:/);
    });
  });

  describe('Touch support', () => {
    it('should handle touchstart event', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');

      fireEvent.touchStart(separator, {
        touches: [{ clientX: 100, clientY: 50 }],
      });
      fireEvent.touchMove(document, {
        touches: [{ clientX: 150, clientY: 50 }],
      });
      fireEvent.touchEnd(document);

      expect(mockOnResize).toHaveBeenCalled();
    });
  });

  describe('Edge cases', () => {
    it('should not call onResize if not dragging', () => {
      render(<PaneResizer onResize={mockOnResize} />);

      // Just move mouse without mousedown
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 });

      expect(mockOnResize).not.toHaveBeenCalled();
    });

    it('should stop dragging on mouseup outside component', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');

      fireEvent.mouseDown(separator, { clientX: 100, clientY: 50 });
      fireEvent.mouseUp(document.body);

      // Reset mock
      mockOnResize.mockClear();

      // Try to continue moving
      fireEvent.mouseMove(document, { clientX: 200, clientY: 50 });

      expect(mockOnResize).not.toHaveBeenCalled();
    });

    it('should cleanup event listeners on unmount', () => {
      const { unmount } = render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');

      fireEvent.mouseDown(separator, { clientX: 100, clientY: 50 });

      // Unmount while dragging
      unmount();

      // Should not throw or call callback
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 });
      expect(mockOnResize).not.toHaveBeenCalled();
    });
  });
});
