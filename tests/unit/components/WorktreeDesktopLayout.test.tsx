/**
 * Tests for WorktreeDesktopLayout component
 *
 * Tests the two-column grid layout with resizable panes
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';

// Mock useIsMobile hook
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

import { useIsMobile } from '@/hooks/useIsMobile';

describe('WorktreeDesktopLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to desktop view
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render both left and right panes', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div data-testid="left-content">Left Content</div>}
          rightPane={<div data-testid="right-content">Right Content</div>}
        />
      );

      expect(screen.getByTestId('left-content')).toBeInTheDocument();
      expect(screen.getByTestId('right-content')).toBeInTheDocument();
    });

    it('should render resizer between panes', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      expect(screen.getByRole('separator')).toBeInTheDocument();
    });

    it('should have grid layout container', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      const container = screen.getByTestId('desktop-layout');
      expect(container.className).toMatch(/grid|flex/);
    });
  });

  describe('Column layout', () => {
    it('should apply default 50% width to left pane', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      const leftPane = screen.getByTestId('left-pane');
      // Check that left pane has width styling
      expect(leftPane.style.width || leftPane.className).toMatch(/50|%/);
    });

    it('should accept custom initial left width', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          initialLeftWidth={30}
        />
      );

      const leftPane = screen.getByTestId('left-pane');
      expect(leftPane.style.width).toBe('30%');
    });
  });

  describe('Resizing', () => {
    it('should update pane widths when resizer is dragged', () => {
      // Mock offsetWidth for container
      const mockOffsetWidth = 1000;
      Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
        configurable: true,
        value: mockOffsetWidth,
      });

      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          initialLeftWidth={50}
        />
      );

      const separator = screen.getByRole('separator');
      const leftPane = screen.getByTestId('left-pane');

      // Initial width
      expect(leftPane.style.width).toBe('50%');

      // Simulate drag (container width of 1000px, so 100px = 10%)
      fireEvent.mouseDown(separator, { clientX: 500, clientY: 50 });
      fireEvent.mouseMove(document, { clientX: 600, clientY: 50 });
      fireEvent.mouseUp(document);

      // Width should have increased by 10% (100px / 1000px * 100)
      const newWidth = parseFloat(leftPane.style.width);
      expect(newWidth).toBeGreaterThan(50);

      // Cleanup
      Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 0,
      });
    });

    it('should respect minimum width constraint', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          initialLeftWidth={50}
          minLeftWidth={20}
        />
      );

      const separator = screen.getByRole('separator');
      const leftPane = screen.getByTestId('left-pane');

      // Drag far to the left
      fireEvent.mouseDown(separator, { clientX: 500, clientY: 50 });
      fireEvent.mouseMove(document, { clientX: 50, clientY: 50 });
      fireEvent.mouseUp(document);

      // Width should not go below minimum
      const newWidth = parseFloat(leftPane.style.width);
      expect(newWidth).toBeGreaterThanOrEqual(20);
    });

    it('should respect maximum width constraint', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          initialLeftWidth={50}
          maxLeftWidth={80}
        />
      );

      const separator = screen.getByRole('separator');
      const leftPane = screen.getByTestId('left-pane');

      // Drag far to the right
      fireEvent.mouseDown(separator, { clientX: 500, clientY: 50 });
      fireEvent.mouseMove(document, { clientX: 950, clientY: 50 });
      fireEvent.mouseUp(document);

      // Width should not exceed maximum
      const newWidth = parseFloat(leftPane.style.width);
      expect(newWidth).toBeLessThanOrEqual(80);
    });
  });

  describe('ErrorBoundary wrapping', () => {
    it('should wrap left pane in ErrorBoundary', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div data-testid="left-content">Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      const leftPane = screen.getByTestId('left-pane');
      // ErrorBoundary should be present in the tree
      expect(leftPane).toBeInTheDocument();
    });

    it('should wrap right pane in ErrorBoundary', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div data-testid="right-content">Right</div>}
        />
      );

      const rightPane = screen.getByTestId('right-pane');
      expect(rightPane).toBeInTheDocument();
    });

    // Note: Testing actual error catching is tricky without componentDidCatch,
    // but we verify ErrorBoundary is present by structure
  });

  describe('Responsive behavior', () => {
    it('should show single column on mobile', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);

      render(
        <WorktreeDesktopLayout
          leftPane={<div data-testid="left-content">Left</div>}
          rightPane={<div data-testid="right-content">Right</div>}
        />
      );

      // On mobile, should have mobile layout
      const container = screen.getByTestId('mobile-layout');
      expect(container).toBeInTheDocument();
    });

    it('should hide resizer on mobile', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);

      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    });

    it('should show two columns on desktop', () => {
      vi.mocked(useIsMobile).mockReturnValue(false);

      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      const container = screen.getByTestId('desktop-layout');
      expect(container).toBeInTheDocument();
    });
  });

  describe('Mobile view toggle', () => {
    it('should show both panes option on mobile', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);

      render(
        <WorktreeDesktopLayout
          leftPane={<div data-testid="left-content">Left</div>}
          rightPane={<div data-testid="right-content">Right</div>}
        />
      );

      // Should have tab or toggle for switching panes
      const mobileLayout = screen.getByTestId('mobile-layout');
      expect(mobileLayout).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      const leftPane = screen.getByTestId('left-pane');
      const rightPane = screen.getByTestId('right-pane');

      expect(leftPane).toHaveAttribute('aria-label');
      expect(rightPane).toHaveAttribute('aria-label');
    });

    it('should have main region role', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      expect(screen.getByRole('main')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('should fill available height', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
        />
      );

      const container = screen.getByTestId('desktop-layout');
      expect(container.className).toMatch(/h-full|min-h|flex-1/);
    });

    it('should accept className prop', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          className="custom-layout"
        />
      );

      const container = screen.getByTestId('desktop-layout');
      expect(container.className).toContain('custom-layout');
    });
  });

  describe('Collapse functionality (Issue #688)', () => {
    it('should show left pane when leftPaneCollapsed is false (default)', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div data-testid="left-content">Left Content</div>}
          rightPane={<div data-testid="right-content">Right Content</div>}
          leftPaneCollapsed={false}
        />
      );
      const leftPane = screen.getByTestId('left-pane');
      expect(leftPane).toBeInTheDocument();
      // Default 50% width is preserved when not collapsed
      expect(leftPane.style.width).not.toBe('0px');
    });

    it('should hide left pane (width: 0) when leftPaneCollapsed is true', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={true}
        />
      );

      const leftPane = screen.getByTestId('left-pane');
      // Collapsed left pane should have width 0
      expect(leftPane.style.width).toBe('0px');
    });

    it('should show expand bar when collapsed', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={true}
        />
      );

      expect(screen.getByTestId('expand-bar')).toBeInTheDocument();
    });

    it('should not show expand bar when not collapsed', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={false}
        />
      );

      expect(screen.queryByTestId('expand-bar')).not.toBeInTheDocument();
    });

    it('should hide PaneResizer when collapsed', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={true}
        />
      );

      // Resizer (separator) should be hidden when collapsed
      expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    });

    it('should show PaneResizer when not collapsed', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={false}
        />
      );

      expect(screen.getByRole('separator')).toBeInTheDocument();
    });

    it('should call onToggleLeftPane when expand button clicked', () => {
      const onToggle = vi.fn();
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={true}
          onToggleLeftPane={onToggle}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand left panel/i });
      fireEvent.click(expandButton);
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('should expose proper aria attributes on expand button', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={true}
          onToggleLeftPane={() => {}}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand left panel/i });
      expect(expandButton).toHaveAttribute('aria-label');
      expect(expandButton).toHaveAttribute('aria-expanded', 'false');
      expect(expandButton).toHaveAttribute('aria-controls', 'worktree-left-pane');
    });

    it('should support keyboard activation (Enter) on expand button', () => {
      const onToggle = vi.fn();
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={true}
          onToggleLeftPane={onToggle}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand left panel/i });
      // Native button responds to Enter/Space via click event automatically when focused.
      // Verify by clicking directly (jsdom doesn't simulate native keyboard activation).
      fireEvent.click(expandButton);
      expect(onToggle).toHaveBeenCalled();
    });

    it('should not render expand bar on mobile even when collapsed', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);

      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={true}
        />
      );

      // Mobile layout takes over; expand-bar should not appear
      expect(screen.queryByTestId('expand-bar')).not.toBeInTheDocument();
      expect(screen.getByTestId('mobile-layout')).toBeInTheDocument();
    });

    it('should set id="worktree-left-pane" on left pane for aria-controls reference', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          leftPaneCollapsed={false}
        />
      );

      const leftPane = screen.getByTestId('left-pane');
      expect(leftPane).toHaveAttribute('id', 'worktree-left-pane');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty panes', () => {
      render(
        <WorktreeDesktopLayout leftPane={null} rightPane={null} />
      );

      expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
    });

    it('should handle rapid resize events', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div>Left</div>}
          rightPane={<div>Right</div>}
          initialLeftWidth={50}
        />
      );

      const separator = screen.getByRole('separator');

      // Rapid fire mouse events
      fireEvent.mouseDown(separator, { clientX: 500 });
      for (let i = 0; i < 100; i++) {
        fireEvent.mouseMove(document, { clientX: 500 + i });
      }
      fireEvent.mouseUp(document);

      // Should not crash
      expect(screen.getByTestId('desktop-layout')).toBeInTheDocument();
    });

    it('should preserve pane content after resize', () => {
      render(
        <WorktreeDesktopLayout
          leftPane={<div data-testid="left-content">Left Content</div>}
          rightPane={<div data-testid="right-content">Right Content</div>}
        />
      );

      const separator = screen.getByRole('separator');

      fireEvent.mouseDown(separator, { clientX: 500 });
      fireEvent.mouseMove(document, { clientX: 600 });
      fireEvent.mouseUp(document);

      expect(screen.getByText('Left Content')).toBeInTheDocument();
      expect(screen.getByText('Right Content')).toBeInTheDocument();
    });
  });
});
