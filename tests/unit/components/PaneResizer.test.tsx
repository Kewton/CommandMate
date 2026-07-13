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
      expect(separator.className).toMatch(/dragging|active|bg-accent/);

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

  describe('VS Code-style thin divider (Issue #970)', () => {
    it('should use subtle panel-border color matching fixed borders (light/dark)', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');
      // [#1061] Divider uses the `border` token (same value as the fixed panel
      // borders gray-200 / gray-700) and theme-follows via CSS var — it must not
      // reintroduce a raw gray bg utility.
      expect(separator.className).toContain('bg-border');
      expect(separator.className).not.toMatch(/bg-gray-\d/);
    });

    it('should keep a constant 1px line at rest (no hover thickening)', () => {
      const { rerender } = render(
        <PaneResizer onResize={mockOnResize} orientation="horizontal" />
      );
      let separator = screen.getByRole('separator');
      expect(separator.className).toContain('w-1');
      // Hover must NOT thicken the line.
      expect(separator.className).not.toMatch(/hover:w-2/);

      rerender(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      separator = screen.getByRole('separator');
      expect(separator.className).toContain('h-1');
      expect(separator.className).not.toMatch(/hover:h-2/);
    });

    it('should show an accent color on hover in both themes', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');
      expect(separator.className).toContain('hover:bg-accent-500');
      // A dark hover variant is retained defensively so the accent reliably wins
      // over the tokenized `bg-border` base in dark mode (#1061).
      expect(separator.className).toContain('dark:hover:bg-accent-500');
    });

    it('should provide a transparent ±4px hit area for horizontal resizer', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');
      expect(separator.className).toContain('relative');
      expect(separator.className).toContain('before:absolute');
      expect(separator.className).toContain('before:-inset-x-1');
    });

    it('should provide a transparent ±4px hit area for vertical resizer', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="vertical" />);
      const separator = screen.getByRole('separator');
      expect(separator.className).toContain('relative');
      expect(separator.className).toContain('before:absolute');
      expect(separator.className).toContain('before:-inset-y-1');
    });

    it('should still thicken and accent only while actively dragging', () => {
      render(<PaneResizer onResize={mockOnResize} orientation="horizontal" />);
      const separator = screen.getByRole('separator');

      // At rest: no thickening class applied.
      expect(separator.className).not.toMatch(/(^|\s)w-2(\s|$)/);

      fireEvent.mouseDown(separator, { clientX: 100, clientY: 50 });
      // Dragging: accent + thicken as live feedback.
      expect(separator.className).toContain('bg-accent-500');
      expect(separator.className).toContain('dark:bg-accent-500');
      expect(separator.className).toMatch(/(^|\s)w-2(\s|$)/);

      fireEvent.mouseUp(document);
      expect(separator.className).not.toMatch(/(^|\s)w-2(\s|$)/);
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

  describe('Double click support', () => {
    it('should call onDoubleClick when double-clicked', () => {
      const mockOnDoubleClick = vi.fn();
      render(
        <PaneResizer
          onResize={mockOnResize}
          onDoubleClick={mockOnDoubleClick}
        />
      );
      const separator = screen.getByRole('separator');

      fireEvent.doubleClick(separator);

      expect(mockOnDoubleClick).toHaveBeenCalled();
    });

    it('should not throw when onDoubleClick is not provided', () => {
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');

      // Should not throw
      expect(() => fireEvent.doubleClick(separator)).not.toThrow();
    });
  });

  describe('Backward compatibility', () => {
    it('should work without optional onDoubleClick prop', () => {
      // This test ensures backward compatibility
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');

      expect(separator).toBeInTheDocument();

      // Drag should still work
      fireEvent.mouseDown(separator, { clientX: 100, clientY: 50 });
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 });
      fireEvent.mouseUp(document);

      expect(mockOnResize).toHaveBeenCalled();
    });

    it('should work without optional minRatio prop', () => {
      // This test ensures backward compatibility
      render(<PaneResizer onResize={mockOnResize} />);
      const separator = screen.getByRole('separator');

      expect(separator).toBeInTheDocument();
    });

    it('should accept minRatio prop without changing behavior', () => {
      // minRatio is informational only - parent must enforce
      render(<PaneResizer onResize={mockOnResize} minRatio={0.2} />);
      const separator = screen.getByRole('separator');

      expect(separator).toBeInTheDocument();

      // Drag should still work normally
      fireEvent.mouseDown(separator, { clientX: 100, clientY: 50 });
      fireEvent.mouseMove(document, { clientX: 150, clientY: 50 });
      fireEvent.mouseUp(document);

      expect(mockOnResize).toHaveBeenCalledWith(50);
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
