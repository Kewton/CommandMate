/**
 * Tests for GitPaneLayout (Issue #818, extracted in #922).
 *
 * Pure layout: it composes five ready sections into the mobile 4-tab strip (only
 * the active group mounted; Status pairs Current Status + Quick actions) or the
 * desktop read / write / history / advanced grouping. isMobile is read from
 * GitPaneContext.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitPaneLayout } from '@/components/worktree/git/GitPaneLayout';
import { GitPaneProvider, type GitPaneContextValue } from '@/components/worktree/git/GitPaneContext';
import type { GitPaneTab } from '@/hooks/useGitPaneTabState';

const SECTIONS = {
  statusSection: <div data-testid="s-status">status</div>,
  quickActionsSection: <div data-testid="s-quick">quick</div>,
  changesSection: <div data-testid="s-changes">changes</div>,
  historySection: <div data-testid="s-history">history</div>,
  advancedSection: <div data-testid="s-advanced">advanced</div>,
};

function renderLayout(isMobile: boolean, activeTab: GitPaneTab = 'status') {
  const value: GitPaneContextValue = { isMobile, onDiffSelect: vi.fn(), onInsertToMessage: vi.fn() };
  return render(
    <GitPaneProvider value={value}>
      <GitPaneLayout activeTab={activeTab} onTabChange={vi.fn()} {...SECTIONS} />
    </GitPaneProvider>
  );
}

describe('GitPaneLayout (Issue #818 / #922)', () => {
  it('renders the desktop grouping with all sections visible', () => {
    renderLayout(false);
    expect(screen.getByTestId('git-pane-desktop')).toBeTruthy();
    expect(screen.getByTestId('git-group-read')).toBeTruthy();
    expect(screen.getByTestId('git-group-write')).toBeTruthy();
    expect(screen.getByTestId('git-group-history')).toBeTruthy();
    expect(screen.getByTestId('git-group-advanced')).toBeTruthy();
    // All five sections present at once on desktop.
    ['s-status', 's-quick', 's-changes', 's-history', 's-advanced'].forEach((id) =>
      expect(screen.getByTestId(id)).toBeTruthy()
    );
  });

  it('mobile Status tab mounts Current Status + Quick actions only', () => {
    renderLayout(true, 'status');
    expect(screen.getByTestId('git-pane-mobile')).toBeTruthy();
    expect(screen.getByTestId('git-pane-mobile-panel').getAttribute('data-active-tab')).toBe('status');
    expect(screen.getByTestId('s-status')).toBeTruthy();
    expect(screen.getByTestId('s-quick')).toBeTruthy();
    // Non-active groups are unmounted.
    expect(screen.queryByTestId('s-changes')).toBeNull();
    expect(screen.queryByTestId('s-history')).toBeNull();
    expect(screen.queryByTestId('s-advanced')).toBeNull();
  });

  it('mobile Advanced tab mounts only the advanced section', () => {
    renderLayout(true, 'advanced');
    expect(screen.getByTestId('s-advanced')).toBeTruthy();
    expect(screen.queryByTestId('s-status')).toBeNull();
    expect(screen.queryByTestId('s-changes')).toBeNull();
    expect(screen.queryByTestId('s-history')).toBeNull();
  });
});
