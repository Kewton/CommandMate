/**
 * GitPaneMobileTabs (Issue #818 A)
 *
 * A 4-tab strip rendered at the top of the GitPane on mobile layouts only. The
 * GitPane renders just the active tab's content so non-active groups unmount
 * (less DOM, shorter vertical scroll). The active tab is persisted by the
 * caller via {@link useGitPaneTabState}.
 *
 * Pure presentation: it owns no state and only reports tab clicks.
 */

'use client';

import React, { memo } from 'react';
import { GIT_PANE_TABS, type GitPaneTab } from '@/hooks/useGitPaneTabState';

/** Common props for the inline SVG icons (mirrors the MobileTabBar pattern). */
interface IconProps {
  /** SVG path `d` attribute. */
  path: string;
}

const TabIcon = memo(function TabIcon({ path }: IconProps) {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={path} />
    </svg>
  );
});

/** Icon path per tab. */
const ICON_PATHS: Record<GitPaneTab, string> = {
  // info circle
  status: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  // pencil / edit
  changes:
    'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
  // clock / history
  history: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  // gear / advanced
  advanced:
    'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
};

/** Tab labels (kept here so order matches GIT_PANE_TABS). */
const TAB_LABELS: Record<GitPaneTab, string> = {
  status: 'Status',
  changes: 'Changes',
  history: 'History',
  advanced: 'Advanced',
};

/** Props for {@link GitPaneMobileTabs}. */
export interface GitPaneMobileTabsProps {
  /** Currently active tab. */
  activeTab: GitPaneTab;
  /** Called when a tab is selected. */
  onTabChange: (tab: GitPaneTab) => void;
}

/**
 * Mobile tab bar for the GitPane. Renders a `tablist` of the four GitPane tabs.
 */
export const GitPaneMobileTabs = memo(function GitPaneMobileTabs({
  activeTab,
  onTabChange,
}: GitPaneMobileTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Git pane sections"
      data-testid="git-pane-mobile-tabs"
      className="flex shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 sticky top-0 z-30"
    >
      {GIT_PANE_TABS.map((tab) => {
        const isActive = tab === activeTab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={TAB_LABELS[tab]}
            data-testid={`git-tab-${tab}`}
            onClick={() => onTabChange(tab)}
            className={`flex flex-1 flex-col items-center justify-center gap-1 py-2 px-1 text-xs transition-colors border-b-2 ${
              isActive
                ? 'text-cyan-600 dark:text-cyan-400 border-cyan-500 bg-cyan-50 dark:bg-cyan-900/30'
                : 'text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            <TabIcon path={ICON_PATHS[tab]} />
            <span>{TAB_LABELS[tab]}</span>
          </button>
        );
      })}
    </div>
  );
});

export default GitPaneMobileTabs;
