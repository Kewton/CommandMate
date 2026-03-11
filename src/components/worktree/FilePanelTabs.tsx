/**
 * FilePanelTabs Component
 *
 * Tab bar with close buttons and content area for the file panel.
 * Displays the active tab's content via FilePanelContent.
 *
 * Issue #438: PC file display panel with tabs
 * Issue #469: isDirty indicator for unsaved edits
 */

'use client';

import React, { memo, useCallback } from 'react';
import { X } from 'lucide-react';
import { FilePanelContent } from './FilePanelContent';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// ============================================================================
// Types
// ============================================================================

export interface FilePanelTabsProps {
  /** Array of open file tabs */
  tabs: FileTab[];
  /** Index of the currently active tab */
  activeIndex: number | null;
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Callback when a tab is closed */
  onClose: (path: string) => void;
  /** Callback when a tab is activated */
  onActivate: (path: string) => void;
  /** Callback when content is loaded */
  onLoadContent: (path: string, content: FileContent) => void;
  /** Callback when loading fails */
  onLoadError: (path: string, error: string) => void;
  /** Callback to set loading state */
  onSetLoading: (path: string, loading: boolean) => void;
  /** Callback when file is saved (refresh tree) */
  onFileSaved?: (path: string) => void;
  /** Callback when isDirty state changes (Issue #469) */
  onDirtyChange?: (path: string, isDirty: boolean) => void;
}

// ============================================================================
// Tab Button Sub-component
// ============================================================================

const TabButton = memo(function TabButton({
  tab,
  isActive,
  onActivate,
  onClose,
}: {
  tab: FileTab;
  isActive: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const handleClick = useCallback(() => {
    if (!isActive) {
      onActivate(tab.path);
    }
  }, [isActive, onActivate, tab.path]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(tab.path);
    },
    [onClose, tab.path],
  );

  const activeClasses = isActive
    ? 'border-cyan-500 text-cyan-600 dark:text-cyan-400 bg-white dark:bg-gray-800'
    : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100';

  return (
    <div
      data-testid={`file-tab-${tab.path}`}
      data-active={isActive}
      onClick={handleClick}
      className={`flex items-center gap-1 px-3 py-2 text-sm font-medium border-b-2 cursor-pointer flex-shrink-0 ${activeClasses}`}
    >
      <span className="truncate max-w-[120px]" title={tab.path}>
        {tab.name}
      </span>
      {/* [Issue #469] Unsaved changes indicator */}
      {tab.isDirty && (
        <span
          data-testid={`file-tab-dirty-${tab.path}`}
          className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0"
          title="Unsaved changes"
        />
      )}
      <button
        type="button"
        onClick={handleClose}
        className="ml-1 p-0.5 rounded-sm hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        aria-label={`Close ${tab.name}`}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================

/**
 * FilePanelTabs - Tab bar and content area for the file panel.
 */
export const FilePanelTabs = memo(function FilePanelTabs({
  tabs,
  activeIndex,
  worktreeId,
  onClose,
  onActivate,
  onLoadContent,
  onLoadError,
  onSetLoading,
  onFileSaved,
  onDirtyChange,
}: FilePanelTabsProps) {
  const activeTab = activeIndex !== null && activeIndex >= 0 && activeIndex < tabs.length
    ? tabs[activeIndex]
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-x-auto">
        {tabs.map((tab, index) => (
          <TabButton
            key={tab.path}
            tab={tab}
            isActive={index === activeIndex}
            onActivate={onActivate}
            onClose={onClose}
          />
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab && (
          <FilePanelContent
            key={activeTab.path}
            tab={activeTab}
            worktreeId={worktreeId}
            onLoadContent={onLoadContent}
            onLoadError={onLoadError}
            onSetLoading={onSetLoading}
            onFileSaved={onFileSaved}
            onDirtyChange={onDirtyChange}
          />
        )}
      </div>
    </div>
  );
});
