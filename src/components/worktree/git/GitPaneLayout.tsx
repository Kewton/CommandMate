/**
 * GitPaneLayout (Issue #818, extracted in #922)
 *
 * Composes the five pre-built GitPane sections into either the mobile 4-tab strip
 * (only the active group mounted) or the desktop read / write / advanced visual
 * grouping. The sections are passed in as ready ReactNodes so this file owns ONLY
 * layout — no data, no handlers. `isMobile` is read from GitPaneContext; the
 * mobile active-tab state is owned by the GitPane body (useGitPaneTabState) and
 * passed through.
 */

'use client';

import React from 'react';
import { GitPaneMobileTabs } from '@/components/worktree/git/GitPaneMobileTabs';
import type { GitPaneTab } from '@/hooks/useGitPaneTabState';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';

export interface GitPaneLayoutProps {
  activeTab: GitPaneTab;
  onTabChange: (tab: GitPaneTab) => void;
  className?: string;
  statusSection: React.ReactNode;
  quickActionsSection: React.ReactNode;
  changesSection: React.ReactNode;
  historySection: React.ReactNode;
  advancedSection: React.ReactNode;
}

export function GitPaneLayout({
  activeTab,
  onTabChange,
  className = '',
  statusSection,
  quickActionsSection,
  changesSection,
  historySection,
  advancedSection,
}: GitPaneLayoutProps) {
  const { isMobile } = useGitPaneContext();

  // --------------------------------------------------------------------------
  // Issue #818 A: mobile = a 4-tab strip with only the active group mounted
  // (non-active groups unmount → less DOM + shorter scroll). Status tab pairs
  // Current Status with Quick actions per the issue spec.
  // --------------------------------------------------------------------------
  if (isMobile) {
    return (
      <div className={`flex flex-col overflow-hidden ${className}`} data-testid="git-pane-mobile">
        <GitPaneMobileTabs activeTab={activeTab} onTabChange={onTabChange} />
        <div
          className="flex-1 flex flex-col min-h-0"
          data-testid="git-pane-mobile-panel"
          data-active-tab={activeTab}
        >
          {activeTab === 'status' && (
            <div className="flex-1 overflow-y-auto min-h-0">
              {statusSection}
              {quickActionsSection}
            </div>
          )}
          {activeTab === 'changes' && (
            <div className="flex-1 overflow-y-auto min-h-0">{changesSection}</div>
          )}
          {activeTab === 'history' && historySection}
          {activeTab === 'advanced' && (
            <div className="flex-1 overflow-y-auto min-h-0">{advancedSection}</div>
          )}
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // Issue #818 B: desktop = visual grouping into read / write / advanced
  // blocks (background tint + accent border). Section order is unchanged so
  // the overflow-hidden + flex-1 history layout keeps working.
  // --------------------------------------------------------------------------
  return (
    <div className={`flex flex-col overflow-hidden ${className}`} data-testid="git-pane-desktop">
      {/* Read · orientation (sky tint) */}
      <div
        data-testid="git-group-read"
        data-git-group="read"
        className="border-l-2 border-info-border bg-info-subtle"
      >
        {statusSection}
      </div>

      {/* Write · actions (neutral tint) */}
      <div
        data-testid="git-group-write"
        data-git-group="write"
        className="border-l-2 border-input bg-muted/70 dark:bg-muted/30"
      >
        {quickActionsSection}
        {changesSection}
      </div>

      {/* Read · history (sky tint, grows to fill the pane) */}
      <div
        data-testid="git-group-history"
        data-git-group="read"
        className="flex-1 flex flex-col min-h-0 border-l-2 border-info-border bg-info-subtle"
      >
        {historySection}
      </div>

      {/* Advanced · gray block with a heavier divider */}
      <div
        data-testid="git-group-advanced"
        data-git-group="advanced"
        className="border-l-2 border-t-2 border-input bg-muted/50 dark:bg-muted/40"
      >
        {advancedSection}
      </div>
    </div>
  );
}

export default GitPaneLayout;
