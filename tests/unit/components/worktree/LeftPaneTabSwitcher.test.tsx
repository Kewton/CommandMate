/**
 * Tests for LeftPaneTabSwitcher component
 *
 * Tests the desktop left pane tab switcher between 'history' and 'files' views
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LeftPaneTabSwitcher, type LeftPaneTab } from '@/components/worktree/LeftPaneTabSwitcher';

describe('LeftPaneTabSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic rendering', () => {
    it('should render tab buttons for history, files, and memo', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /memo/i })).toBeInTheDocument();
    });

    it('should render with tablist role', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      expect(screen.getByRole('tablist')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      const onTabChange = vi.fn();
      render(
        <LeftPaneTabSwitcher
          activeTab="history"
          onTabChange={onTabChange}
          className="custom-class"
        />
      );

      const tablist = screen.getByRole('tablist');
      expect(tablist).toHaveClass('custom-class');
    });
  });

  describe('Active tab indication', () => {
    it('should indicate history tab as active when activeTab is history', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      const filesTab = screen.getByRole('tab', { name: /files/i });

      expect(historyTab).toHaveAttribute('aria-selected', 'true');
      expect(filesTab).toHaveAttribute('aria-selected', 'false');
    });

    it('should indicate files tab as active when activeTab is files', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="files" onTabChange={onTabChange} />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      const filesTab = screen.getByRole('tab', { name: /files/i });

      expect(historyTab).toHaveAttribute('aria-selected', 'false');
      expect(filesTab).toHaveAttribute('aria-selected', 'true');
    });

    it('should apply active styling to active tab', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      expect(historyTab).toHaveClass('bg-blue-50');
      expect(historyTab).toHaveClass('text-blue-600');
    });

    it('should apply inactive styling to inactive tab', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const filesTab = screen.getByRole('tab', { name: /files/i });
      expect(filesTab).not.toHaveClass('bg-blue-50');
    });
  });

  describe('Tab interaction', () => {
    it('should call onTabChange with "files" when files tab is clicked', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const filesTab = screen.getByRole('tab', { name: /files/i });
      fireEvent.click(filesTab);

      expect(onTabChange).toHaveBeenCalledWith('files');
    });

    it('should call onTabChange with "history" when history tab is clicked', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="files" onTabChange={onTabChange} />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      fireEvent.click(historyTab);

      expect(onTabChange).toHaveBeenCalledWith('history');
    });

    it('should not call onTabChange when clicking already active tab', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      fireEvent.click(historyTab);

      // Should still call onTabChange even for the same tab
      expect(onTabChange).toHaveBeenCalledWith('history');
    });
  });

  describe('Icons', () => {
    it('should show clock icon for history tab', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      expect(historyTab.querySelector('svg')).toBeInTheDocument();
    });

    it('should show folder icon for files tab', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const filesTab = screen.getByRole('tab', { name: /files/i });
      expect(filesTab.querySelector('svg')).toBeInTheDocument();
    });
  });

  describe('Keyboard navigation', () => {
    it('should switch tabs on Enter key', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const filesTab = screen.getByRole('tab', { name: /files/i });
      fireEvent.keyDown(filesTab, { key: 'Enter' });

      expect(onTabChange).toHaveBeenCalledWith('files');
    });

    it('should switch tabs on Space key', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const filesTab = screen.getByRole('tab', { name: /files/i });
      fireEvent.keyDown(filesTab, { key: ' ' });

      expect(onTabChange).toHaveBeenCalledWith('files');
    });

    it('should have tabIndex for keyboard navigation', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      const filesTab = screen.getByRole('tab', { name: /files/i });

      expect(historyTab).toHaveAttribute('tabIndex');
      expect(filesTab).toHaveAttribute('tabIndex');
    });
  });

  describe('Accessibility', () => {
    it('should have aria-label on tablist', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const tablist = screen.getByRole('tablist');
      expect(tablist).toHaveAttribute('aria-label', 'Left pane view switcher');
    });

    it('should have descriptive labels for tabs', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /memo/i })).toBeInTheDocument();
    });
  });

  describe('Memo tab', () => {
    it('should indicate memo tab as active when activeTab is memo', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="memo" onTabChange={onTabChange} />);

      const memoTab = screen.getByRole('tab', { name: /memo/i });
      expect(memoTab).toHaveAttribute('aria-selected', 'true');
    });

    it('should call onTabChange with "memo" when memo tab is clicked', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const memoTab = screen.getByRole('tab', { name: /memo/i });
      fireEvent.click(memoTab);

      expect(onTabChange).toHaveBeenCalledWith('memo');
    });

    it('should show memo icon', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const memoTab = screen.getByRole('tab', { name: /memo/i });
      expect(memoTab.querySelector('svg')).toBeInTheDocument();
    });
  });

  describe('Styling', () => {
    it('should have border styling', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const tablist = screen.getByRole('tablist');
      expect(tablist).toHaveClass('border-b');
    });

    it('should have proper layout with flex', () => {
      const onTabChange = vi.fn();
      render(<LeftPaneTabSwitcher activeTab="history" onTabChange={onTabChange} />);

      const tablist = screen.getByRole('tablist');
      expect(tablist).toHaveClass('flex');
    });
  });
});
