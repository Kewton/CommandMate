/**
 * Tests for ActivityBar (Issue #727, updated by Issue #730)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { ActivityBar } from '@/components/worktree/ActivityBar';
import { ACTIVITIES } from '@/config/activity-bar-config';
import { TOOLTIP_DELAY_MS } from '@/components/common/Tooltip';

// Issue #1277: this file asserts rendered wording (tab aria-labels / tooltips
// resolved from ACTIVITIES[].labelKey), so it must go through the real
// dictionary. The global mock in tests/setup.ts echoes `worktree.<key>` back and
// would keep these assertions green even if the key did not exist.
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

// Issue #747: ActivityBar now reads/controls the sidebar via useSidebarContext().
// Mock the hook so the component can render without a SidebarProvider and so the
// toggle behaviour (click → toggle, aria-expanded ← isOpen) can be asserted.
const sidebarMock = vi.hoisted(() => ({ isOpen: true, toggle: vi.fn() }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({ isOpen: sidebarMock.isOpen, toggle: sidebarMock.toggle }),
}));

describe('ActivityBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarMock.isOpen = true;
  });

  it('renders all 7 activity tabs', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(ACTIVITIES.length);
    expect(tabs).toHaveLength(7);
  });

  it('renders with role="tablist" and aria-orientation="vertical"', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('marks the active tab with aria-selected=true and others false', () => {
    render(<ActivityBar active="git" onToggle={() => {}} />);
    const gitTab = screen.getByTestId('activity-bar-button-git');
    const filesTab = screen.getByTestId('activity-bar-button-files');
    expect(gitTab).toHaveAttribute('aria-selected', 'true');
    expect(filesTab).toHaveAttribute('aria-selected', 'false');
  });

  it('every tab exposes aria-controls="worktree-activity-pane"', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) {
      expect(tab).toHaveAttribute('aria-controls', 'worktree-activity-pane');
    }
  });

  it('container has id="worktree-activity-bar"', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    expect(document.getElementById('worktree-activity-bar')).not.toBeNull();
  });

  it('calls onToggle with the clicked activity id', () => {
    const onToggle = vi.fn();
    render(<ActivityBar active="files" onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('activity-bar-button-git'));
    expect(onToggle).toHaveBeenCalledWith('git');
  });

  it('re-clicking the active activity also calls onToggle (parent handles close)', () => {
    const onToggle = vi.fn();
    render(<ActivityBar active="files" onToggle={onToggle} />);
    fireEvent.click(screen.getByTestId('activity-bar-button-files'));
    expect(onToggle).toHaveBeenCalledWith('files');
  });

  describe('Keyboard navigation', () => {
    it('Enter key activates the focused tab', () => {
      const onToggle = vi.fn();
      render(<ActivityBar active="files" onToggle={onToggle} />);
      const gitTab = screen.getByTestId('activity-bar-button-git');
      fireEvent.keyDown(gitTab, { key: 'Enter' });
      expect(onToggle).toHaveBeenCalledWith('git');
    });

    it('Space key activates the focused tab', () => {
      const onToggle = vi.fn();
      render(<ActivityBar active="files" onToggle={onToggle} />);
      const notesTab = screen.getByTestId('activity-bar-button-notes');
      fireEvent.keyDown(notesTab, { key: ' ' });
      expect(onToggle).toHaveBeenCalledWith('notes');
    });

    it('ArrowDown moves focus to the next tab (wrap-around)', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const last = screen.getByTestId(`activity-bar-button-${ACTIVITIES[ACTIVITIES.length - 1].id}`);
      last.focus();
      fireEvent.keyDown(last, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(
        screen.getByTestId(`activity-bar-button-${ACTIVITIES[0].id}`)
      );
    });

    it('ArrowUp moves focus to the previous tab (wrap-around)', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const first = screen.getByTestId(`activity-bar-button-${ACTIVITIES[0].id}`);
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(
        screen.getByTestId(`activity-bar-button-${ACTIVITIES[ACTIVITIES.length - 1].id}`)
      );
    });

    it('Home moves focus to the first tab', () => {
      render(<ActivityBar active="git" onToggle={() => {}} />);
      const mid = screen.getByTestId(`activity-bar-button-${ACTIVITIES[2].id}`);
      mid.focus();
      fireEvent.keyDown(mid, { key: 'Home' });
      expect(document.activeElement).toBe(
        screen.getByTestId(`activity-bar-button-${ACTIVITIES[0].id}`)
      );
    });

    it('End moves focus to the last tab', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const first = screen.getByTestId(`activity-bar-button-${ACTIVITIES[0].id}`);
      first.focus();
      fireEvent.keyDown(first, { key: 'End' });
      expect(document.activeElement).toBe(
        screen.getByTestId(`activity-bar-button-${ACTIVITIES[ACTIVITIES.length - 1].id}`)
      );
    });
  });

  describe('Sidebar toggle (Issue #747)', () => {
    it('renders the sidebar toggle button at the top with data-testid and aria-label', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const toggle = screen.getByTestId('activity-bar-toggle-sidebar');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-label', 'Toggle sidebar');
    });

    it('calls the sidebar context toggle when clicked', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      fireEvent.click(screen.getByTestId('activity-bar-toggle-sidebar'));
      expect(sidebarMock.toggle).toHaveBeenCalledTimes(1);
    });

    it('reflects the open sidebar state via aria-expanded=true', () => {
      sidebarMock.isOpen = true;
      render(<ActivityBar active="files" onToggle={() => {}} />);
      expect(screen.getByTestId('activity-bar-toggle-sidebar')).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });

    it('reflects the closed sidebar state via aria-expanded=false', () => {
      sidebarMock.isOpen = false;
      render(<ActivityBar active="files" onToggle={() => {}} />);
      expect(screen.getByTestId('activity-bar-toggle-sidebar')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
    });

    it('is NOT a tab and lives outside the tablist (tab count stays 7)', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const toggle = screen.getByTestId('activity-bar-toggle-sidebar');
      // Regression guard: keeping the toggle out of the tablist preserves the
      // roving-tabindex keyboard navigation and the WAI-ARIA tab count.
      expect(toggle).not.toHaveAttribute('role', 'tab');
      expect(screen.getByRole('tablist')).not.toContainElement(toggle);
      expect(screen.getAllByRole('tab')).toHaveLength(7);
    });

    it('does not trigger the activity onToggle when the sidebar toggle is clicked', () => {
      const onToggle = vi.fn();
      render(<ActivityBar active="files" onToggle={onToggle} />);
      fireEvent.click(screen.getByTestId('activity-bar-toggle-sidebar'));
      expect(onToggle).not.toHaveBeenCalled();
    });
  });

  it('handles active=null gracefully (no aria-selected=true anywhere)', () => {
    render(<ActivityBar active={null} onToggle={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) {
      expect(tab).toHaveAttribute('aria-selected', 'false');
    }
  });

  it('does not set native title attribute on tabs (Issue #730)', () => {
    render(<ActivityBar active="files" onToggle={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    for (const tab of tabs) {
      // Either no title attribute or empty
      const t = tab.getAttribute('title');
      expect(t === null || t === '').toBe(true);
    }
  });

  describe('Tooltip integration (Issue #730)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows a custom Tooltip with the activity label after hover delay', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const tab = screen.getByTestId('activity-bar-button-git');
      // Hover over the button (mouseenter bubbles up to the wrapper span)
      fireEvent.mouseEnter(tab);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });
      const tooltip = screen.getByRole('tooltip', { hidden: true });
      expect(tooltip).toHaveAttribute('aria-hidden', 'true');
      expect(tooltip).toHaveTextContent(/git/i);
    });

    // Issue #1341: portalling the shared Tooltip must not regress the
    // ActivityBar, whose tooltips open to the `right` of the leftmost column
    // and were never clipped. The bubble now lives on document.body, but the
    // placement and the #730 a11y contract are unchanged.
    it('keeps placement="right" and the a11y contract after portalling', () => {
      render(<ActivityBar active="files" onToggle={() => {}} />);
      const tab = screen.getByTestId('activity-bar-button-git');
      fireEvent.mouseEnter(tab);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });
      const tooltip = screen.getByRole('tooltip', { hidden: true });
      expect(tooltip).toHaveAttribute('data-placement', 'right');
      expect(tooltip.parentElement).toBe(document.body);
      // The button keeps its own aria-label and gains no aria-describedby, so
      // screen readers announce the label exactly once.
      expect(tab).toHaveAttribute('aria-label');
      expect(tab).not.toHaveAttribute('aria-describedby');
    });
  });
});
