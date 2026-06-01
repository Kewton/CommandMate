/**
 * Tests for WorktreeDesktopLayout component
 * (Issue #727 4-column layout, simplified by Issue #730 to a 2-column layout)
 *
 * History and ActivityBar were moved out of this component:
 *   - History → `TerminalContainer` (inside `rightPane`)
 *   - ActivityBar → managed by parent (`WorktreeDetailRefactored`)
 *
 * Tests focused on `activityBar` / `historyPane` props and on the mobile
 * fallback were therefore removed.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';

const defaultProps = {
  activityPane: <div data-testid="activity-pane-content">ActivityPane</div>,
  rightPane: <div data-testid="right-pane-content">RightPane</div>,
};

describe('WorktreeDesktopLayout (Issue #727 / #730)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic 2-column rendering', () => {
    it('renders Activity Pane slot and Right Pane slot', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      expect(screen.getByTestId('activity-pane-content')).toBeInTheDocument();
      expect(screen.getByTestId('right-pane-content')).toBeInTheDocument();
    });

    it('exposes DOM ids on the slot containers', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      expect(document.getElementById('worktree-activity-pane')).not.toBeNull();
      expect(document.getElementById('worktree-right-pane')).not.toBeNull();
    });

    it('renders one resizer between activity and right when activity pane is visible', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      const separators = screen.getAllByRole('separator');
      expect(separators).toHaveLength(1);
    });
  });

  describe('Activity Pane null', () => {
    it('hides the activity pane column AND its resizer when activityPane=null', () => {
      render(<WorktreeDesktopLayout {...defaultProps} activityPane={null} />);
      expect(screen.queryByTestId('activity-pane-content')).not.toBeInTheDocument();
      expect(screen.queryAllByRole('separator')).toHaveLength(0);
    });

    it('still renders right pane when activityPane=null', () => {
      render(<WorktreeDesktopLayout {...defaultProps} activityPane={null} />);
      expect(screen.getByTestId('right-pane-content')).toBeInTheDocument();
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
  });

  describe('Accessibility', () => {
    it('right pane has aria-label', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      const slot = document.getElementById('worktree-right-pane');
      expect(slot).toHaveAttribute('aria-label');
    });

    it('activity pane has aria-label', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      const slot = document.getElementById('worktree-activity-pane');
      expect(slot).toHaveAttribute('aria-label');
    });

    it('container has role=main', () => {
      render(<WorktreeDesktopLayout {...defaultProps} />);
      expect(screen.getByRole('main')).toBeInTheDocument();
    });
  });

  describe('Resize callbacks', () => {
    it('calls onActivityPaneResize when the activity resizer is dragged', () => {
      Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 1000,
      });
      const onResize = vi.fn();
      render(
        <WorktreeDesktopLayout
          {...defaultProps}
          activityPaneWidth={18}
          onActivityPaneResize={onResize}
        />
      );
      const resizer = screen.getByRole('separator');
      fireEvent.mouseDown(resizer, { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 200 });
      fireEvent.mouseUp(document);
      expect(onResize).toHaveBeenCalled();
      Object.defineProperty(HTMLDivElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 0,
      });
    });
  });
});
