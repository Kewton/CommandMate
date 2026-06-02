/**
 * WorktreeDetail Mobile Content (Issue #755)
 *
 * Extracted from WorktreeDetailSubComponents.tsx to split the mobile-only
 * presentational tree (MobileContent / MobileInfoContent) out of the shared
 * sub-components module, shrinking WorktreeDetailRefactored's dependency
 * surface (pure structural refactor — no behavior change).
 *
 * Ownership boundary (S3-004): only MobileContent / MobileInfoContent move
 * here. Shared helpers (useDescriptionEditor / WorktreeInfoFields) and
 * InfoModal / DesktopHeader stay in WorktreeDetailSubComponents and are
 * imported from there. WorktreeDetailSubComponents re-exports the two mobile
 * components for backward compatibility.
 */

'use client';

import React, { memo, useRef, useState } from 'react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { type MobileTab } from '@/components/mobile/MobileTabBar';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { FileTreeView } from '@/components/worktree/FileTreeView';
import { SearchBar } from '@/components/worktree/SearchBar';
import { NotesAndLogsPane } from '@/components/worktree/NotesAndLogsPane';
import { GitPane } from '@/components/worktree/GitPane';
import type { Worktree, ChatMessage } from '@/types/models';
import { type CLIToolType } from '@/lib/cli-tools/types';
import type { UseFileSearchReturn } from '@/hooks/useFileSearch';
import type { ShowToast } from '@/types/markdown-editor';
import type { HistoryDisplayLimit } from '@/config/history-display-config';
import {
  WorktreeInfoFields,
  useDescriptionEditor,
} from '@/components/worktree/WorktreeDetailSubComponents';

// ============================================================================
// Mobile Info Content
// ============================================================================

/** Props for MobileInfoContent component */
interface MobileInfoContentProps {
  worktreeId: string;
  worktree: Worktree | null;
  onWorktreeUpdate: (updated: Worktree) => void;
}

/**
 * Mobile Info tab content with description editing.
 * Uses useDescriptionEditor hook and WorktreeInfoFields for DRY compliance.
 */
export const MobileInfoContent = memo(function MobileInfoContent({
  worktreeId,
  worktree,
  onWorktreeUpdate,
}: MobileInfoContentProps) {
  const [showLogs, setShowLogs] = useState(false);

  // Track previous worktree ID to detect worktree changes
  const prevWorktreeIdRef = useRef(worktree?.id);
  // Track editing state via ref to avoid circular dependency with useDescriptionEditor
  const isEditingRef = useRef(false);

  const descriptionEditor = useDescriptionEditor(
    worktree,
    onWorktreeUpdate,
    worktree?.id,
    () => {
      const worktreeChanged = worktree?.id !== prevWorktreeIdRef.current;
      prevWorktreeIdRef.current = worktree?.id;
      return worktreeChanged && !isEditingRef.current;
    },
  );

  // Keep ref in sync with hook state
  isEditingRef.current = descriptionEditor.isEditing;

  if (!worktree) {
    return (
      <div className="text-gray-500 text-center py-8">
        Loading worktree info...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <WorktreeInfoFields
        worktreeId={worktreeId}
        worktree={worktree}
        cardClassName="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4"
        descriptionEditor={descriptionEditor}
        showLogs={showLogs}
        onToggleLogs={() => setShowLogs(!showLogs)}
        onWorktreeUpdate={onWorktreeUpdate}
      />
    </div>
  );
});

// ============================================================================
// Mobile Content Component
// ============================================================================

/** Props for MobileContent component */
interface MobileContentProps {
  activeTab: MobileTab;
  worktreeId: string;
  worktree: Worktree | null;
  messages: ChatMessage[];
  /**
   * [Issue #736] Active CLI tool for the mobile terminal tab. The terminal
   * output is now sourced from `useTerminalPanePolling` (per the #728 PC
   * architecture) instead of the removed terminal reducer slice.
   */
  cliToolId: CLIToolType;
  onFilePathClick: (path: string) => void;
  onFileSelect: (path: string) => void;
  onWorktreeUpdate: (updated: Worktree) => void;
  onNewFile: (parentPath: string) => void;
  onNewDirectory: (parentPath: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onUpload: (targetDir: string) => void;
  /** [Issue #162] Move callback */
  onMove?: (path: string, type: 'file' | 'directory') => void;
  refreshTrigger: number;
  /** [Issue #21] File search hook return object */
  fileSearch: UseFileSearchReturn;
  /** [Issue #211] Toast notification callback for copy feedback.
   *  Issue #786 (D-5): widened to the shared `ShowToast` alias for type parity. */
  showToast?: ShowToast;
  /** [Issue #294] CMATE setup callback */
  onCmateSetup?: () => void;
  /** [Issue #368] Selected agents for Agent tab */
  selectedAgents: CLIToolType[];
  /** [Issue #368] Callback when selected agents change */
  onSelectedAgentsChange: (agents: CLIToolType[]) => void;
  /** [Issue #368] Current vibe-local model selection */
  vibeLocalModel: string | null;
  /** [Issue #368] Callback when vibe-local model changes */
  onVibeLocalModelChange: (model: string | null) => void;
  /** [Issue #374] Current vibe-local context window (null = default) */
  vibeLocalContextWindow: number | null;
  /** [Issue #374] Callback when vibe-local context window changes */
  onVibeLocalContextWindowChange: (value: number | null) => void;
  /** [Issue #379] Disable auto-follow for TUI tools (OpenCode) */
  disableAutoFollow?: boolean;
  /** [Issue #447] History sub-tab state */
  historySubTab: 'message' | 'git';
  /** [Issue #447] History sub-tab change handler */
  onHistorySubTabChange: (tab: 'message' | 'git') => void;
  /** [Issue #447] Diff select handler for GitPane */
  onDiffSelect: (diff: string, filePath: string) => void;
  /** [Issue #485] Insert to message callback */
  onInsertToMessage?: (content: string) => void;
  /** [Issue #168] Whether to show archived messages */
  showArchived?: boolean;
  /** [Issue #168] Callback when showArchived toggle changes */
  onShowArchivedChange?: (show: boolean) => void;
  /** [Issue #701] Current history display limit */
  historyDisplayLimit?: HistoryDisplayLimit;
  /** [Issue #701] Callback when history display limit changes */
  onHistoryDisplayLimitChange?: (limit: HistoryDisplayLimit) => void;
  /** [Issue #725] Whether the HistoryPane "User only" filter is active */
  historyUserOnly?: boolean;
  /** [Issue #725] Callback when the "User only" toggle changes */
  onHistoryUserOnlyChange?: (userOnly: boolean) => void;
}

/**
 * [Issue #736] Mobile terminal tab content.
 *
 * Owns a per-(worktreeId, cliToolId) `useTerminalPanePolling` instance — the
 * same hook the PC split panes use (#728) — replacing the removed
 * terminal reducer slice. Mounted only while the terminal tab is
 * active, so the poller stops when the user is on another mobile tab (and the
 * hook self-resets on a cliToolId change, mirroring the PC compositeKey reset).
 */
const MobileTerminalTab = memo(function MobileTerminalTab({
  worktreeId,
  cliToolId,
  disableAutoFollow,
}: {
  worktreeId: string;
  cliToolId: CLIToolType;
  disableAutoFollow?: boolean;
}) {
  const { terminal, setAutoScroll } = useTerminalPanePolling({ worktreeId, cliToolId });
  return (
    <TerminalDisplay
      output={terminal.output}
      isActive={terminal.isRunning}
      isThinking={terminal.isThinking}
      autoScroll={terminal.autoScroll}
      onScrollChange={setAutoScroll}
      disableAutoFollow={disableAutoFollow}
      className="h-full"
    />
  );
});

/** Renders content based on active mobile tab */
export const MobileContent = memo(function MobileContent({
  activeTab,
  worktreeId,
  worktree,
  messages,
  cliToolId,
  onFilePathClick,
  onFileSelect,
  onWorktreeUpdate,
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  onMove,
  refreshTrigger,
  fileSearch,
  showToast,
  onCmateSetup,
  selectedAgents,
  onSelectedAgentsChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  disableAutoFollow,
  historySubTab,
  onHistorySubTabChange,
  onDiffSelect,
  onInsertToMessage,
  showArchived,
  onShowArchivedChange,
  historyDisplayLimit,
  onHistoryDisplayLimitChange,
  historyUserOnly,
  onHistoryUserOnlyChange,
}: MobileContentProps) {
  switch (activeTab) {
    case 'terminal':
      return (
        <ErrorBoundary componentName="TerminalDisplay">
          <MobileTerminalTab
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            disableAutoFollow={disableAutoFollow}
          />
        </ErrorBoundary>
      );
    case 'history':
      return (
        <div className="h-full flex flex-col">
          {/* History sub-tab switcher: Message | Git (Issue #447) */}
          <div className="flex border-b border-gray-200 dark:border-gray-700 shrink-0">
            <button
              type="button"
              onClick={() => onHistorySubTabChange('message')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                historySubTab === 'message'
                  ? 'text-cyan-600 dark:text-cyan-400 border-b-2 border-cyan-600 dark:border-cyan-400 bg-cyan-50 dark:bg-cyan-900/30'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Message
            </button>
            <button
              type="button"
              onClick={() => onHistorySubTabChange('git')}
              className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                historySubTab === 'git'
                  ? 'text-cyan-600 dark:text-cyan-400 border-b-2 border-cyan-600 dark:border-cyan-400 bg-cyan-50 dark:bg-cyan-900/30'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              Git
            </button>
          </div>
          {historySubTab === 'message' ? (
            <ErrorBoundary componentName="HistoryPane">
              <HistoryPane
                messages={messages}
                worktreeId={worktreeId}
                onFilePathClick={onFilePathClick}
                className="flex-1 min-h-0"
                showToast={showToast}
                onInsertToMessage={onInsertToMessage}
                showArchived={showArchived}
                onShowArchivedChange={onShowArchivedChange}
                historyDisplayLimit={historyDisplayLimit}
                onHistoryDisplayLimitChange={onHistoryDisplayLimitChange}
                historyUserOnly={historyUserOnly}
                onHistoryUserOnlyChange={onHistoryUserOnlyChange}
              />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary componentName="GitPane">
              <GitPane
                worktreeId={worktreeId}
                onDiffSelect={onDiffSelect}
                isMobile={true}
                className="flex-1 min-h-0"
              />
            </ErrorBoundary>
          )}
        </div>
      );
    case 'files':
      return (
        <ErrorBoundary componentName="FileTreeView">
          <div className="h-full flex flex-col overflow-hidden">
            {/* [Issue #21] Search Bar - Mobile */}
            <SearchBar
              query={fileSearch.query}
              mode={fileSearch.mode}
              isSearching={fileSearch.isSearching}
              error={fileSearch.error}
              onQueryChange={fileSearch.setQuery}
              onModeChange={fileSearch.setMode}
              onClear={fileSearch.clearSearch}
            />
            <FileTreeView
              worktreeId={worktreeId}
              onFileSelect={onFileSelect}
              onNewFile={onNewFile}
              onNewDirectory={onNewDirectory}
              onRename={onRename}
              onDelete={onDelete}
              onUpload={onUpload}
              onMove={onMove}
              onCmateSetup={onCmateSetup}
              refreshTrigger={refreshTrigger}
              searchQuery={fileSearch.query}
              searchMode={fileSearch.mode}
              searchResults={fileSearch.results?.results}
              className="flex-1 min-h-0"
            />
          </div>
        </ErrorBoundary>
      );
    case 'memo':
      return (
        <ErrorBoundary componentName="NotesAndLogsPane">
          <NotesAndLogsPane
            worktreeId={worktreeId}
            className="h-full"
            selectedAgents={selectedAgents}
            onSelectedAgentsChange={onSelectedAgentsChange}
            vibeLocalModel={vibeLocalModel}
            onVibeLocalModelChange={onVibeLocalModelChange}
            vibeLocalContextWindow={vibeLocalContextWindow}
            onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
            onInsertToMessage={onInsertToMessage}
          />
        </ErrorBoundary>
      );
    case 'info':
      return (
        <MobileInfoContent
          worktreeId={worktreeId}
          worktree={worktree}
          onWorktreeUpdate={onWorktreeUpdate}
        />
      );
    default:
      return null;
  }
});
