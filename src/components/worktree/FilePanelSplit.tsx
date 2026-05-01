/**
 * FilePanelSplit Component
 *
 * Splits the right pane into terminal and file panel using PaneResizer.
 * When no file tabs are open, shows terminal at full width.
 *
 * Issue #438: PC file display panel with tabs
 */

'use client';

import React, { memo, useState, useCallback, useRef, useMemo } from 'react';
import { PaneResizer } from './PaneResizer';
import { FilePanelTabs } from './FilePanelTabs';
import { DiffViewer } from './DiffViewer';
import type { FileTabsState } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// ============================================================================
// Types
// ============================================================================

export interface FilePanelSplitProps {
  /** Terminal display element */
  terminal: React.ReactNode;
  /** Optional header rendered above the terminal (e.g. CLI tool tabs) */
  terminalHeader?: React.ReactNode;
  /** File tabs state */
  fileTabs: FileTabsState;
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Callback when a tab is closed */
  onCloseTab: (path: string) => void;
  /** Callback when a tab is activated */
  onActivateTab: (path: string) => void;
  /** Callback when content is loaded */
  onLoadContent: (path: string, content: FileContent) => void;
  /** Callback when loading fails */
  onLoadError: (path: string, error: string) => void;
  /** Callback to set loading state */
  onSetLoading: (path: string, loading: boolean) => void;
  /** Callback when file is saved (refresh tree) */
  onFileSaved?: (path: string) => void;
  /** Diff content to display in the file panel area (Issue #447) */
  diffContent?: string | null;
  /** File path of the diff being displayed (Issue #447) */
  diffFilePath?: string | null;
  /** Callback to close the diff view (Issue #447) */
  onCloseDiff?: () => void;
  /** Callback when isDirty state changes (Issue #469) */
  onDirtyChange?: (path: string, isDirty: boolean) => void;
  /** Callback to move a tab to front (Issue #505) */
  onMoveToFront?: (path: string) => void;
  /** Callback to open a file from a link (Issue #505) */
  onOpenFile?: (path: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Initial terminal width as percentage */
const INITIAL_TERMINAL_WIDTH = 50;

/** Minimum terminal width as percentage */
const MIN_TERMINAL_WIDTH = 20;

/** Maximum terminal width as percentage */
const MAX_TERMINAL_WIDTH = 80;

/** Width of the collapse/expand bar for the file panel (px) */
const FILE_PANEL_BAR_WIDTH_PX = 24;

// ============================================================================
// Main Component
// ============================================================================

/**
 * FilePanelSplit - Horizontal split between terminal and file panel.
 *
 * When no tabs are open, terminal takes full width.
 * When tabs are open, uses PaneResizer for adjustable split.
 */
export const FilePanelSplit = memo(function FilePanelSplit({
  terminal,
  terminalHeader,
  fileTabs,
  worktreeId,
  onCloseTab,
  onActivateTab,
  onLoadContent,
  onLoadError,
  onSetLoading,
  onFileSaved,
  diffContent,
  diffFilePath,
  onCloseDiff,
  onDirtyChange,
  onMoveToFront,
  onOpenFile,
}: FilePanelSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [terminalWidth, setTerminalWidth] = useState(INITIAL_TERMINAL_WIDTH);
  const [filePanelCollapsed, setFilePanelCollapsed] = useState(false);

  const toggleFilePanel = useCallback(() => setFilePanelCollapsed((v) => !v), []);

  const handleResize = useCallback((delta: number) => {
    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.offsetWidth;
    if (containerWidth === 0) return;

    const percentageDelta = (delta / containerWidth) * 100;

    setTerminalWidth((prev) => {
      const newWidth = prev + percentageDelta;
      return Math.min(MAX_TERMINAL_WIDTH, Math.max(MIN_TERMINAL_WIDTH, newWidth));
    });
  }, []);

  // Memoize pane width styles (must be before early return per Rules of Hooks)
  const terminalStyle = useMemo(() => ({ width: `${terminalWidth}%` }), [terminalWidth]);
  const filePanelStyle = useMemo(() => ({ width: `${100 - terminalWidth}%` }), [terminalWidth]);

  /** Terminal with optional header */
  const terminalWithHeader = (
    <div className="h-full flex flex-col">
      {terminalHeader}
      <div className="flex-1 min-h-0">{terminal}</div>
    </div>
  );

  // Determine if the right panel should show (file tabs or diff)
  const hasRightPanel = fileTabs.tabs.length > 0 || (diffContent && diffFilePath);

  // No tabs and no diff: terminal at full width
  if (!hasRightPanel) {
    return (
      <div className="h-full">
        {terminalWithHeader}
      </div>
    );
  }

  // File panel collapsed: terminal fills width, narrow expand bar on the right
  if (filePanelCollapsed) {
    return (
      <div ref={containerRef} className="flex h-full min-h-0">
        <div
          data-testid="terminal-pane"
          style={{ width: `calc(100% - ${FILE_PANEL_BAR_WIDTH_PX}px)` }}
          className="flex-shrink-0 overflow-hidden"
        >
          {terminalWithHeader}
        </div>
        <div
          data-testid="file-panel-expand-bar"
          style={{ width: `${FILE_PANEL_BAR_WIDTH_PX}px` }}
          className="flex-shrink-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700"
        >
          <button
            type="button"
            aria-label="Show file panel"
            onClick={toggleFilePanel}
            className="flex items-center justify-center w-full h-10 text-gray-500 dark:text-gray-400 hover:text-cyan-600 dark:hover:text-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0">
      {/* Terminal pane */}
      <div
        data-testid="terminal-pane"
        style={terminalStyle}
        className="flex-shrink-0 overflow-hidden"
      >
        {terminalWithHeader}
      </div>

      {/* Resizer */}
      <PaneResizer
        onResize={handleResize}
        orientation="horizontal"
        ariaValueNow={terminalWidth}
      />

      {/* File panel pane */}
      <div
        data-testid="file-panel-pane"
        style={filePanelStyle}
        className="flex-grow overflow-hidden flex"
      >
        {/* Collapse button strip — always visible at the left edge of the file panel */}
        <button
          type="button"
          aria-label="Hide file panel"
          onClick={toggleFilePanel}
          className="flex-shrink-0 flex items-center justify-center w-5 h-full bg-gray-50 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 hover:text-cyan-600 dark:hover:text-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        {/* File panel content */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {/* Diff view takes priority when active (Issue #447) */}
          {diffContent && diffFilePath && onCloseDiff ? (
            <DiffViewer
              diff={diffContent}
              filePath={diffFilePath}
              onClose={onCloseDiff}
            />
          ) : (
            <FilePanelTabs
              tabs={fileTabs.tabs}
              activeIndex={fileTabs.activeIndex}
              worktreeId={worktreeId}
              onClose={onCloseTab}
              onActivate={onActivateTab}
              onLoadContent={onLoadContent}
              onLoadError={onLoadError}
              onSetLoading={onSetLoading}
              onFileSaved={onFileSaved}
              onDirtyChange={onDirtyChange}
              onMoveToFront={onMoveToFront}
              onOpenFile={onOpenFile}
            />
          )}
        </div>
      </div>
    </div>
  );
});
