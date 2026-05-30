/**
 * Tests for WorktreeDesktopLayout component (Issue #727 4-column layout)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

import { useIsMobile } from '@/hooks/useIsMobile';

const defaultProps = {
  activityBar: <div data-testid="activity-bar-content">ActivityBar</div>,
  activityPane: <div data-testid="activity-pane-content">ActivityPane</div>,
  historyPane: <div data-testid="history-pane-content">HistoryPane</div>,
  rightPane: <div data-testid="right-pane-content">RightPane</div>,
};

describe('WorktreeDesktopLayout (Issue #727)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic 4-column rendering', () => {
    it('renders Activity Bar slot, Activity Pane slot, History Pane slot, and Right Pane slot', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      expect(screen.getByTestId('activity-bar-content')).toBeInTheDocument();
      expect(screen.getByTestId('activity-pane-content')).toBeInTheDocument();
      expect(screen.getByTestId('history-pane-content')).toBeInTheDocument();
      expect(screen.getByTestId('right-pane-content')).toBeInTheDocument();
    });

    it('exposes new DOM ids on the slot containers', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      expect(document.getElementById('worktree-activity-bar')).not.toBeNull();
      expect(document.getElementById('worktree-activity-pane')).not.toBeNull();
      expect(document.getElementById('worktree-history-pane')).not.toBeNull();
      expect(document.getElementById('worktree-right-pane')).not.toBeNull();
    });

    it('renders two resizers between activity/history and history/right when all panes are visible', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      const separators = screen.getAllByRole('separator');
      expect(separators).toHaveLength(2);
    });
  });

  describe('Activity Pane null', () => {
    it('hides the activity pane column AND its resizer when activityPane=null', () => {
      render(<WorktreeDesktopLayout {...defaultProps} activityPane={null} />);
      expect(screen.queryByTestId('activity-pane-content')).not.toBeInTheDocument();
      // Only history resizer remains
      const separators = screen.getAllByRole('separator');
      expect(separators).toHaveLength(1);
    });

    it('still renders activity bar when activityPane=null', () => {
      render(<WorktreeDesktopLayout {...defaultProps} activityPane={null} />);
      expect(screen.getByTestId('activity-bar-content')).toBeInTheDocument();
    });
  });

  describe('History Pane collapse', () => {
    it('hides history pane and shows expand bar when historyPaneCollapsed=true', () => {
      render(
        <WorktreeDesktopLayout
          {...defaultProps}
          historyPaneCollapsed={true}
        />
      );
      expect(screen.queryByTestId('history-pane-content')).not.toBeInTheDocument();
      expect(screen.getByTestId('history-expand-bar')).toBeInTheDocument();
    });

    it('expand button has aria-controls=worktree-history-pane and aria-expanded=false', () => {
      render(
        <WorktreeDesktopLayout
          {...defaultProps}
          historyPaneCollapsed={true}
        />
      );
      const btn = screen.getByRole('button', { name: /expand history panel/i });
      expect(btn).toHaveAttribute('aria-controls', 'worktree-history-pane');
      expect(btn).toHaveAttribute('aria-expanded', 'false');
    });

    it('calls onToggleHistoryPane when expand button clicked', () => {
      const onToggle = vi.fn();
      render(
        <WorktreeDesktopLayout
          {...defaultProps}
          historyPaneCollapsed={true}
          onToggleHistoryPane={onToggle}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /expand history panel/i }));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('does not render expand bar when historyPaneCollapsed=false', () => {
      render(
        <WorktreeDesktopLayout
          {...defaultProps}
          historyPaneCollapsed={false}
        />
      );
      expect(screen.queryByTestId('history-expand-bar')).not.toBeInTheDocument();
    });

    it('also hides the history resizer when collapsed', () => {
      render(
        <WorktreeDesktopLayout
          {...defaultProps}
          historyPaneCollapsed={true}
        />
      );
      // Only activity resizer remains
      const separators = screen.getAllByRole('separator');
      expect(separators).toHaveLength(1);
    });
  });

  describe('Width props', () => {
    it('applies activityPaneWidth as a percentage', () => {
      render(
        <WorktreeDesktopLayout {...defaultProps} activityPaneWidth={30} />
      );
      const slot = document.getElementById('worktree-activity-pane');
      expect(slot?.style.width).toBe('30%');
    });

    it('applies historyPaneWidth as a percentage', () => {
      render(
        <WorktreeDesktopLayout {...defaultProps} historyPaneWidth={25} />
      );
      const slot = document.getElementById('worktree-history-pane');
      expect(slot?.style.width).toBe('25%');
    });
  });

  describe('Mobile fallback', () => {
    it('falls back to mobile layout when useIsMobile=true', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      render(<WorktreeDesktopLayout {...defaultProps} />);
      expect(screen.getByTestId('mobile-layout')).toBeInTheDocument();
    });

    it('does not render desktop slots in mobile mode', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      render(<WorktreeDesktopLayout {...defaultProps} />);
      expect(document.getElementById('worktree-activity-bar')).toBeNull();
      expect(document.getElementById('worktree-history-pane')).toBeNull();
    });

    it('uses history pane as the mobile left side when visible', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      render(<WorktreeDesktopLayout {...defaultProps} historyPaneCollapsed={false} />);
      // Activate left tab
      fireEvent.click(screen.getByRole('tab', { name: /history/i }));
      expect(screen.getByTestId('history-pane-content')).toBeInTheDocument();
    });

    it('falls back to activity pane on mobile left when history is collapsed', () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      render(
        <WorktreeDesktopLayout
          {...defaultProps}
          historyPaneCollapsed={true}
        />
      );
      fireEvent.click(screen.getByRole('tab', { name: /history/i }));
      expect(screen.getByTestId('activity-pane-content')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('history pane has aria-label', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      const slot = document.getElementById('worktree-history-pane');
      expect(slot).toHaveAttribute('aria-label');
    });

    it('right pane has aria-label', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      const slot = document.getElementById('worktree-right-pane');
      expect(slot).toHaveAttribute('aria-label');
    });

    it('container has role=main', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      expect(screen.getByRole('main')).toBeInTheDocument();
    });
  });

  describe('Resize callbacks', () => {
    it('calls onHistoryPaneResize when the history resizer is dragged', () => {
      // Mock offsetWidth so resize logic produces a non-zero delta.
      Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 1000,
      });
      const onResize = vi.fn();
      render(
        <WorktreeDesktopLayout
          {...defaultProps}
          historyPaneWidth={22}
          onHistoryPaneResize={onResize}
        />
      );
      // The 2nd separator is between history and right (history resizer).
      const separators = screen.getAllByRole('separator');
      const historyResizer = separators[separators.length - 1];
      fireEvent.mouseDown(historyResizer, { clientX: 500 });
      fireEvent.mouseMove(document, { clientX: 600 });
      fireEvent.mouseUp(document);
      expect(onResize).toHaveBeenCalled();
      // Cleanup
      Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 0,
      });
    });
  });
});
