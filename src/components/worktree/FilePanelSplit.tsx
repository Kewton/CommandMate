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
import {
  useFilePanelState,
  FILE_PANEL_PANE_ID,
  OpenFilesContext,
  type OpenFilesSnapshot,
} from '@/hooks/useFilePanelState';
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

/*
 * Issue #2259 removed `FILE_PANEL_BAR_WIDTH_PX` (the 36px collapsed strip) and
 * the 20px in-panel collapse column. Both drove the same
 * `useFilePanelState.toggle` the Action bar's "Open Files" button drives, so
 * they were two extra places to look for one switch — and the collapsed strip
 * charged 36px of terminal width for the privilege. The Action bar is now the
 * only control; the panel is either fully open or fully gone.
 */

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
  // Issue #840: collapsed state is persisted to localStorage so it survives
  // reload / re-mount (previously a local useState that reset to default).
  // Issue #2259: read-only here. The toggle moved entirely to the Action bar
  // (`TerminalSplitContainer`); this component no longer renders a control.
  const { collapsed: filePanelCollapsed } = useFilePanelState();

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

  /**
   * Issue #2259: publish what the panel holds to the Action bar living inside
   * `terminal`. The bar's "Open Files" toggle is disabled — and its badge
   * empty — while there is nothing to show, because before this it toggled a
   * panel that renders nothing and looked broken.
   */
  const openFiles = useMemo<OpenFilesSnapshot>(
    () => ({
      tabCount: fileTabs.tabs.length,
      hasDiff: Boolean(diffContent && diffFilePath),
    }),
    [fileTabs.tabs.length, diffContent, diffFilePath],
  );

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
      <OpenFilesContext.Provider value={openFiles}>
        <div className="h-full">
          {terminalWithHeader}
        </div>
      </OpenFilesContext.Provider>
    );
  }

  // File panel hidden: the terminal takes the full width, with nothing beside
  // it (Issue #2259 — the 36px expand strip that used to live here is gone).
  if (filePanelCollapsed) {
    return (
      <OpenFilesContext.Provider value={openFiles}>
        <div ref={containerRef} className="flex h-full min-h-0">
          <div
            data-testid="terminal-pane"
            style={{ width: '100%' }}
            className="flex-shrink-0 overflow-hidden"
          >
            {terminalWithHeader}
          </div>
        </div>
      </OpenFilesContext.Provider>
    );
  }

  return (
    <OpenFilesContext.Provider value={openFiles}>
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

        {/* File panel pane. `id` so the Action bar's "Open Files" toggle — the
            only control for this panel since Issue #2259 — can name the region it
            controls in `aria-controls`. */}
        <div
          id={FILE_PANEL_PANE_ID}
          data-testid="file-panel-pane"
          style={filePanelStyle}
          className="flex-grow overflow-hidden flex"
        >
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
    </OpenFilesContext.Provider>
  );
});
