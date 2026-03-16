/**
 * FilePanelTabs Component
 *
 * Tab bar with close buttons and content area for the file panel.
 * Displays the active tab's content via FilePanelContent.
 *
 * Issue #438: PC file display panel with tabs
 * Issue #469: isDirty indicator for unsaved edits
 * Issue #505: Dropdown for 6+ tabs, onMoveToFront, onOpenFile passthrough
 */

'use client';

import React, { memo, useCallback, useState, useEffect, useRef } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { FilePanelContent } from './FilePanelContent';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// ============================================================================
// Constants
// ============================================================================

/** Number of tabs shown in the tab bar before overflow into dropdown */
const VISIBLE_TAB_COUNT = 5;

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
  /** Callback to move a tab to front (Issue #505, DR1-009) */
  onMoveToFront?: (path: string) => void;
  /** Callback to open a file from a link (Issue #505, DR2-009 passthrough) */
  onOpenFile?: (path: string) => void;
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
 *
 * Shows first 5 tabs in the tab bar. When 6+ tabs are open, additional
 * tabs are accessible via a dropdown menu. Dropdown selection dispatches
 * MOVE_TO_FRONT to bring the selected tab to the front. [DR1-008, DR1-009]
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
  onMoveToFront,
  onOpenFile,
}: FilePanelTabsProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeTab = activeIndex !== null && activeIndex >= 0 && activeIndex < tabs.length
    ? tabs[activeIndex]
    : null;

  const visibleTabs = tabs.length > VISIBLE_TAB_COUNT ? tabs.slice(0, VISIBLE_TAB_COUNT) : tabs;
  const overflowTabs = tabs.length > VISIBLE_TAB_COUNT ? tabs.slice(VISIBLE_TAB_COUNT) : [];

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  const handleDropdownSelect = useCallback((path: string) => {
    setDropdownOpen(false);
    onMoveToFront?.(path);
  }, [onMoveToFront]);

  const handleDropdownToggle = useCallback(() => {
    setDropdownOpen(prev => !prev);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 min-w-0">
        <div className="flex min-w-0 overflow-hidden flex-1">
          {visibleTabs.map((tab, index) => (
            <TabButton
              key={tab.path}
              tab={tab}
              isActive={index === activeIndex}
              onActivate={onActivate}
              onClose={onClose}
            />
          ))}
        </div>
        {/* Dropdown button for overflow tabs [DR1-008] */}
        {overflowTabs.length > 0 && (
          <div className="relative flex-shrink-0" ref={dropdownRef}>
            <button
              type="button"
              data-testid="tab-dropdown-button"
              onClick={handleDropdownToggle}
              className="flex items-center gap-0.5 px-2 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 border-b-2 border-transparent transition-colors"
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
              <span>+{overflowTabs.length}</span>
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50 min-w-[200px] max-h-[300px] overflow-y-auto">
                {overflowTabs.map(tab => (
                  <button
                    key={tab.path}
                    type="button"
                    data-testid={`tab-dropdown-item-${tab.path}`}
                    onClick={() => handleDropdownSelect(tab.path)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 truncate"
                    title={tab.path}
                  >
                    {tab.name}
                    {tab.isDirty && (
                      <span className="ml-1 w-2 h-2 inline-block rounded-full bg-amber-500" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
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
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </div>
  );
});
