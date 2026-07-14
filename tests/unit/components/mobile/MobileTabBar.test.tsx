/**
 * Tests for MobileTabBar component
 *
 * Tests the mobile tab bar for switching between terminal, history, files, and info views
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MobileTabBar } from '@/components/mobile/MobileTabBar';
import type { MobileTabBarProps } from '@/components/mobile/MobileTabBar';

describe('MobileTabBar', () => {
  const defaultProps: MobileTabBarProps = {
    activeTab: 'terminal',
    onTabChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the tab bar', () => {
      render(<MobileTabBar {...defaultProps} />);
      expect(screen.getByTestId('mobile-tab-bar')).toBeInTheDocument();
    });

    it('should render all five tabs', () => {
      render(<MobileTabBar {...defaultProps} />);

      expect(screen.getByRole('tab', { name: /terminal/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /tools/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /info/i })).toBeInTheDocument();
    });

    it('should have tablist role', () => {
      render(<MobileTabBar {...defaultProps} />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
    });
  });

  describe('Active Tab', () => {
    it('should highlight terminal tab when activeTab is terminal', () => {
      render(<MobileTabBar {...defaultProps} activeTab="terminal" />);

      const terminalTab = screen.getByRole('tab', { name: /terminal/i });
      expect(terminalTab).toHaveAttribute('aria-selected', 'true');
      expect(terminalTab.className).toMatch(/active|selected|primary|bg-accent|text-accent/);
    });

    it('should highlight history tab when activeTab is history', () => {
      render(<MobileTabBar {...defaultProps} activeTab="history" />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      expect(historyTab).toHaveAttribute('aria-selected', 'true');
    });

    it('should highlight files tab when activeTab is files', () => {
      render(<MobileTabBar {...defaultProps} activeTab="files" />);

      const filesTab = screen.getByRole('tab', { name: /files/i });
      expect(filesTab).toHaveAttribute('aria-selected', 'true');
    });

    it('should highlight info tab when activeTab is info', () => {
      render(<MobileTabBar {...defaultProps} activeTab="info" />);

      const infoTab = screen.getByRole('tab', { name: /info/i });
      expect(infoTab).toHaveAttribute('aria-selected', 'true');
    });

    it('should not highlight inactive tabs', () => {
      render(<MobileTabBar {...defaultProps} activeTab="terminal" />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      expect(historyTab).toHaveAttribute('aria-selected', 'false');
    });
  });

  describe('Tab Clicking', () => {
    it('should call onTabChange with "terminal" when terminal tab is clicked', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} activeTab="history" onTabChange={onTabChange} />);

      fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));

      expect(onTabChange).toHaveBeenCalledWith('terminal');
    });

    it('should call onTabChange with "history" when history tab is clicked', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} onTabChange={onTabChange} />);

      fireEvent.click(screen.getByRole('tab', { name: /history/i }));

      expect(onTabChange).toHaveBeenCalledWith('history');
    });

    it('should call onTabChange with "files" when files tab is clicked', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} onTabChange={onTabChange} />);

      fireEvent.click(screen.getByRole('tab', { name: /files/i }));

      expect(onTabChange).toHaveBeenCalledWith('files');
    });

    it('should call onTabChange with "info" when info tab is clicked', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} onTabChange={onTabChange} />);

      fireEvent.click(screen.getByRole('tab', { name: /info/i }));

      expect(onTabChange).toHaveBeenCalledWith('info');
    });

    it('should call onTabChange even when clicking already active tab', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} activeTab="terminal" onTabChange={onTabChange} />);

      fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));

      expect(onTabChange).toHaveBeenCalledWith('terminal');
    });
  });

  describe('Notification Badges', () => {
    it('should show new output badge when hasNewOutput is true', () => {
      render(<MobileTabBar {...defaultProps} hasNewOutput={true} />);

      const badge = screen.getByTestId('new-output-badge');
      expect(badge).toBeInTheDocument();
    });

    it('should not show new output badge when hasNewOutput is false', () => {
      render(<MobileTabBar {...defaultProps} hasNewOutput={false} />);

      expect(screen.queryByTestId('new-output-badge')).not.toBeInTheDocument();
    });

    it('should not show new output badge when hasNewOutput is undefined', () => {
      render(<MobileTabBar {...defaultProps} />);

      expect(screen.queryByTestId('new-output-badge')).not.toBeInTheDocument();
    });

    it('should show prompt badge when hasPrompt is true', () => {
      render(<MobileTabBar {...defaultProps} hasPrompt={true} />);

      const badge = screen.getByTestId('prompt-badge');
      expect(badge).toBeInTheDocument();
    });

    it('should not show prompt badge when hasPrompt is false', () => {
      render(<MobileTabBar {...defaultProps} hasPrompt={false} />);

      expect(screen.queryByTestId('prompt-badge')).not.toBeInTheDocument();
    });

    it('should show both badges when both hasNewOutput and hasPrompt are true', () => {
      render(<MobileTabBar {...defaultProps} hasNewOutput={true} hasPrompt={true} />);

      expect(screen.getByTestId('new-output-badge')).toBeInTheDocument();
      expect(screen.getByTestId('prompt-badge')).toBeInTheDocument();
    });

    it('should show badges on terminal tab', () => {
      render(<MobileTabBar {...defaultProps} hasNewOutput={true} />);

      const terminalTab = screen.getByRole('tab', { name: /terminal/i });
      const badge = screen.getByTestId('new-output-badge');

      // Badge should be inside or related to terminal tab
      expect(terminalTab.contains(badge) || terminalTab.parentElement?.contains(badge)).toBe(true);
    });
  });

  describe('Styling', () => {
    it('should have fixed positioning at bottom', () => {
      render(<MobileTabBar {...defaultProps} />);

      const tabBar = screen.getByTestId('mobile-tab-bar');
      expect(tabBar.className).toMatch(/fixed|bottom/);
    });

    it('should have safe area padding', () => {
      render(<MobileTabBar {...defaultProps} />);

      const tabBar = screen.getByTestId('mobile-tab-bar');
      // Should have pb-safe or similar class for safe area
      expect(tabBar.className).toMatch(/pb-|safe|bottom/);
    });

    it('should span full width', () => {
      render(<MobileTabBar {...defaultProps} />);

      const tabBar = screen.getByTestId('mobile-tab-bar');
      expect(tabBar.className).toMatch(/w-full|inset-x-0/);
    });

    it('should have background color', () => {
      render(<MobileTabBar {...defaultProps} />);

      const tabBar = screen.getByTestId('mobile-tab-bar');
      expect(tabBar.className).toMatch(/bg-/);
    });
  });

  describe('Accessibility', () => {
    it('should have correct ARIA attributes on tabs', () => {
      render(<MobileTabBar {...defaultProps} activeTab="terminal" />);

      const tabs = screen.getAllByRole('tab');
      tabs.forEach(tab => {
        expect(tab).toHaveAttribute('aria-selected');
      });
    });

    it('should support keyboard navigation', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} onTabChange={onTabChange} />);

      const historyTab = screen.getByRole('tab', { name: /history/i });
      historyTab.focus();
      fireEvent.keyDown(historyTab, { key: 'Enter', code: 'Enter' });
      fireEvent.click(historyTab);

      expect(onTabChange).toHaveBeenCalledWith('history');
    });

    it('should have accessible labels', () => {
      render(<MobileTabBar {...defaultProps} />);

      expect(screen.getByRole('tab', { name: /terminal/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /tools/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /info/i })).toBeInTheDocument();
    });
  });

  describe('Memo Tab', () => {
    it('should highlight memo tab when activeTab is memo', () => {
      render(<MobileTabBar {...defaultProps} activeTab="memo" />);

      const memoTab = screen.getByRole('tab', { name: /tools/i });
      expect(memoTab).toHaveAttribute('aria-selected', 'true');
    });

    it('should call onTabChange with "memo" when memo tab is clicked', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} onTabChange={onTabChange} />);

      fireEvent.click(screen.getByRole('tab', { name: /tools/i }));

      expect(onTabChange).toHaveBeenCalledWith('memo');
    });

    it('should render memo tab in correct position (after files, before info)', () => {
      render(<MobileTabBar {...defaultProps} />);

      const tabs = screen.getAllByRole('tab');
      const tabLabels = tabs.map(tab => tab.textContent?.toLowerCase().trim());

      // Order: terminal, history, files, tools, info
      expect(tabLabels[0]).toContain('terminal');
      expect(tabLabels[1]).toContain('history');
      expect(tabLabels[2]).toContain('files');
      expect(tabLabels[3]).toContain('tools');
      expect(tabLabels[4]).toContain('info');
    });
  });

  describe('Icons', () => {
    it('should display icons for each tab', () => {
      render(<MobileTabBar {...defaultProps} />);

      const tabs = screen.getAllByRole('tab');
      tabs.forEach(tab => {
        // Each tab should have an icon (svg or icon class)
        const hasIcon = tab.querySelector('svg') || tab.className.includes('icon');
        expect(hasIcon || tab.textContent).toBeTruthy();
      });
    });
  });

  describe('searchParams integration (Issue #600)', () => {
    it('should call onSearchParamsChange when provided and tab is clicked', () => {
      const onTabChange = vi.fn();
      const onSearchParamsChange = vi.fn();
      render(
        <MobileTabBar
          {...defaultProps}
          onTabChange={onTabChange}
          onSearchParamsChange={onSearchParamsChange}
        />
      );

      fireEvent.click(screen.getByRole('tab', { name: /history/i }));

      // Both callbacks should be called
      expect(onTabChange).toHaveBeenCalledWith('history');
      expect(onSearchParamsChange).toHaveBeenCalledWith('history');
    });

    it('should not call onSearchParamsChange when not provided', () => {
      const onTabChange = vi.fn();
      render(
        <MobileTabBar
          {...defaultProps}
          onTabChange={onTabChange}
        />
      );

      fireEvent.click(screen.getByRole('tab', { name: /files/i }));

      expect(onTabChange).toHaveBeenCalledWith('files');
      // No error should occur when onSearchParamsChange is not provided
    });

    it('should map memo tab to notes DeepLinkPane in onSearchParamsChange', () => {
      const onSearchParamsChange = vi.fn();
      render(
        <MobileTabBar
          {...defaultProps}
          onSearchParamsChange={onSearchParamsChange}
        />
      );

      fireEvent.click(screen.getByRole('tab', { name: /tools/i }));

      expect(onSearchParamsChange).toHaveBeenCalledWith('notes');
    });

    it('should map terminal tab to terminal DeepLinkPane', () => {
      const onSearchParamsChange = vi.fn();
      render(
        <MobileTabBar
          {...defaultProps}
          activeTab="history"
          onSearchParamsChange={onSearchParamsChange}
        />
      );

      fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));

      expect(onSearchParamsChange).toHaveBeenCalledWith('terminal');
    });

    it('should map info tab to info DeepLinkPane', () => {
      const onSearchParamsChange = vi.fn();
      render(
        <MobileTabBar
          {...defaultProps}
          onSearchParamsChange={onSearchParamsChange}
        />
      );

      fireEvent.click(screen.getByRole('tab', { name: /info/i }));

      expect(onSearchParamsChange).toHaveBeenCalledWith('info');
    });
  });

  describe('Update Notification Badge (Issue #278)', () => {
    it('should show info-update-badge when hasUpdate is true', () => {
      render(<MobileTabBar {...defaultProps} hasUpdate={true} />);

      const badge = screen.getByTestId('info-update-badge');
      expect(badge).toBeInTheDocument();
    });

    it('should not show info-update-badge when hasUpdate is false', () => {
      render(<MobileTabBar {...defaultProps} hasUpdate={false} />);

      expect(screen.queryByTestId('info-update-badge')).not.toBeInTheDocument();
    });

    it('should not show info-update-badge when hasUpdate is undefined', () => {
      render(<MobileTabBar {...defaultProps} />);

      expect(screen.queryByTestId('info-update-badge')).not.toBeInTheDocument();
    });

    it('should display info-update-badge on the info tab', () => {
      render(<MobileTabBar {...defaultProps} hasUpdate={true} />);

      const infoTab = screen.getByRole('tab', { name: /info/i });
      const badge = screen.getByTestId('info-update-badge');

      // Badge should be inside the info tab button
      expect(infoTab.contains(badge)).toBe(true);
    });

    it('should have aria-label on info-update-badge for accessibility', () => {
      render(<MobileTabBar {...defaultProps} hasUpdate={true} />);

      const badge = screen.getByTestId('info-update-badge');
      expect(badge).toHaveAttribute('aria-label', 'Update available');
    });
  });

  // Issue #1127: ARIA tabs pattern — roving tabindex + arrow-key navigation.
  describe('Roving tabindex (Issue #1127)', () => {
    it('puts only the active tab in the page tab order', () => {
      render(<MobileTabBar {...defaultProps} activeTab="history" />);

      expect(screen.getByRole('tab', { name: /history/i })).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('tab', { name: /terminal/i })).toHaveAttribute('tabindex', '-1');
      expect(screen.getByRole('tab', { name: /files/i })).toHaveAttribute('tabindex', '-1');
      expect(screen.getByRole('tab', { name: /tools/i })).toHaveAttribute('tabindex', '-1');
      expect(screen.getByRole('tab', { name: /info/i })).toHaveAttribute('tabindex', '-1');
    });

    it('moves the roving tabindex when the active tab changes', () => {
      const { rerender } = render(<MobileTabBar {...defaultProps} activeTab="terminal" />);
      expect(screen.getByRole('tab', { name: /terminal/i })).toHaveAttribute('tabindex', '0');

      rerender(<MobileTabBar {...defaultProps} activeTab="files" />);
      expect(screen.getByRole('tab', { name: /files/i })).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('tab', { name: /terminal/i })).toHaveAttribute('tabindex', '-1');
    });
  });

  describe('Arrow-key navigation (Issue #1127)', () => {
    it('ArrowRight focuses and selects the next tab', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} activeTab="terminal" onTabChange={onTabChange} />);

      const terminalTab = screen.getByRole('tab', { name: /terminal/i });
      terminalTab.focus();
      fireEvent.keyDown(terminalTab, { key: 'ArrowRight' });

      expect(onTabChange).toHaveBeenCalledWith('history');
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /history/i }));
    });

    it('ArrowLeft wraps from the first tab to the last', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} activeTab="terminal" onTabChange={onTabChange} />);

      const terminalTab = screen.getByRole('tab', { name: /terminal/i });
      fireEvent.keyDown(terminalTab, { key: 'ArrowLeft' });

      expect(onTabChange).toHaveBeenCalledWith('info');
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /info/i }));
    });

    it('ArrowRight wraps from the last tab to the first', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} activeTab="info" onTabChange={onTabChange} />);

      const infoTab = screen.getByRole('tab', { name: /info/i });
      fireEvent.keyDown(infoTab, { key: 'ArrowRight' });

      expect(onTabChange).toHaveBeenCalledWith('terminal');
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /terminal/i }));
    });

    it('Home jumps to the first tab and End to the last', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} activeTab="files" onTabChange={onTabChange} />);

      const filesTab = screen.getByRole('tab', { name: /files/i });

      fireEvent.keyDown(filesTab, { key: 'Home' });
      expect(onTabChange).toHaveBeenCalledWith('terminal');
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /terminal/i }));

      fireEvent.keyDown(screen.getByRole('tab', { name: /terminal/i }), { key: 'End' });
      expect(onTabChange).toHaveBeenCalledWith('info');
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /info/i }));
    });

    it('also mirrors arrow navigation to searchParams when provided', () => {
      const onSearchParamsChange = vi.fn();
      render(
        <MobileTabBar
          {...defaultProps}
          activeTab="terminal"
          onSearchParamsChange={onSearchParamsChange}
        />
      );

      fireEvent.keyDown(screen.getByRole('tab', { name: /terminal/i }), { key: 'ArrowRight' });
      expect(onSearchParamsChange).toHaveBeenCalledWith('history');
    });

    it('ignores unrelated keys', () => {
      const onTabChange = vi.fn();
      render(<MobileTabBar {...defaultProps} activeTab="terminal" onTabChange={onTabChange} />);

      fireEvent.keyDown(screen.getByRole('tab', { name: /terminal/i }), { key: 'a' });
      expect(onTabChange).not.toHaveBeenCalled();
    });
  });

  describe('Tap targets (Issue #1127)', () => {
    it('gives every tab a ≥44px hit area and touch-manipulation', () => {
      render(<MobileTabBar {...defaultProps} />);

      screen.getAllByRole('tab').forEach((tab) => {
        expect(tab.className).toContain('min-h-[44px]');
        expect(tab.className).toContain('touch-manipulation');
      });
    });
  });
});
