/**
 * Unit tests for GitPaneMobileTabs (Issue #818 A)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitPaneMobileTabs } from '@/components/worktree/git/GitPaneMobileTabs';
import { GIT_PANE_TABS } from '@/hooks/useGitPaneTabState';

describe('GitPaneMobileTabs', () => {
  const onTabChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a tablist with all four tabs', () => {
    render(<GitPaneMobileTabs activeTab="status" onTabChange={onTabChange} />);

    expect(screen.getByTestId('git-pane-mobile-tabs')).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    for (const tab of GIT_PANE_TABS) {
      expect(screen.getByTestId(`git-tab-${tab}`)).toBeInTheDocument();
    }
    // Exactly four tabs, no more.
    expect(screen.getAllByRole('tab')).toHaveLength(4);
  });

  it('marks the active tab with aria-selected', () => {
    render(<GitPaneMobileTabs activeTab="history" onTabChange={onTabChange} />);

    expect(screen.getByTestId('git-tab-history')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('git-tab-status')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('git-tab-changes')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('git-tab-advanced')).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onTabChange with the clicked tab id', () => {
    render(<GitPaneMobileTabs activeTab="status" onTabChange={onTabChange} />);

    fireEvent.click(screen.getByTestId('git-tab-changes'));
    expect(onTabChange).toHaveBeenCalledWith('changes');

    fireEvent.click(screen.getByTestId('git-tab-advanced'));
    expect(onTabChange).toHaveBeenCalledWith('advanced');
  });

  it('exposes accessible labels for each tab', () => {
    render(<GitPaneMobileTabs activeTab="status" onTabChange={onTabChange} />);

    expect(screen.getByRole('tab', { name: /status/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /changes/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /advanced/i })).toBeInTheDocument();
  });
});
