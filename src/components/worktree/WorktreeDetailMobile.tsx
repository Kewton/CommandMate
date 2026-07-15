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
import { type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
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
      <div className="text-muted-foreground text-center py-8">
        Loading worktree info...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <WorktreeInfoFields
        worktreeId={worktreeId}
        worktree={worktree}
        cardClassName="bg-surface rounded-lg border border-border p-4"
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
  /**
   * [Issue #874] Active agent instance id for the mobile terminal tab. Defaults
   * to the primary instance (`=== cliToolId`); additional instances (e.g.
   * `claude-2`) target their own session via the `instance` query param.
   */
  instanceId?: string;
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
  /** [Issue #1108] Reset the controller-owned Files view state (search + mobile viewer/editor). */
  onFileTreeReset?: () => void;
  refreshTrigger: number;
  /** [Issue #21] File search hook return object */
  fileSearch: UseFileSearchReturn;
  /** [Issue #211] Toast notification callback for copy feedback.
   *  Issue #786 (D-5): widened to the shared `ShowToast` alias for type parity. */
  showToast?: ShowToast;
  /**
   * [Issue #368 / #837] Agents for the Agent tab. On mobile this is the
   * localStorage-backed mobile preference, not the DB `selectedAgents`.
   */
  selectedAgents: CLIToolType[];
  /** [Issue #368 / #837] Callback when selected agents change (mobile: localStorage) */
  onSelectedAgentsChange: (agents: CLIToolType[]) => void;
  /** [Issue #837 / #851] Selectable agent pool for AgentSettingsPane (all CLI tools on mobile) */
  availableAgents?: readonly CLIToolType[];
  /** [Issue #837 / #851] Maximum agents selectable in the Agent tab (6 / all on mobile) */
  maxAgents?: number;
  /** [Issue #837] When false, Agent tab changes are not persisted to the DB */
  persistToServer?: boolean;
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
  /**
   * [Issue #874] When true, the Agent sub-tab in the memo tab renders the
   * instance-management UI (MobileAgentInstancesPane) instead of the legacy
   * checkbox AgentSettingsPane. Requires the instance props below.
   */
  useInstanceManagement?: boolean;
  /** [Issue #874] Shared agent instance roster (instance-management mode). */
  instances?: AgentInstance[];
  /** [Issue #874] Callback when the roster changes (after a successful PATCH). */
  onInstancesChange?: (instances: AgentInstance[]) => void;
  /** [Issue #874] Per-device visible instance ids (localStorage, never the DB). */
  visibleInstanceIds?: string[];
  /** [Issue #874] Toggle one instance's per-device visibility. */
  onToggleInstanceVisible?: (instanceId: string) => void;
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
  instanceId,
  disableAutoFollow,
}: {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Issue #874: agent instance id for this tab (defaults to primary === cliToolId). */
  instanceId?: string;
  disableAutoFollow?: boolean;
}) {
  const { terminal, setAutoScroll } = useTerminalPanePolling({ worktreeId, cliToolId, instanceId });
  // Issue #1172: compact the 1000-row layout padding for Claude/Codex (display only).
  const compactTuiLayoutPadding = cliToolId === 'claude' || cliToolId === 'codex';
  return (
    <TerminalDisplay
      output={terminal.output}
      isActive={terminal.isRunning}
      isThinking={terminal.isThinking}
      autoScroll={terminal.autoScroll}
      onScrollChange={setAutoScroll}
      disableAutoFollow={disableAutoFollow}
      compactTuiLayoutPadding={compactTuiLayoutPadding}
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
  instanceId,
  onFilePathClick,
  onFileSelect,
  onWorktreeUpdate,
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  onMove,
  onFileTreeReset,
  refreshTrigger,
  fileSearch,
  showToast,
  selectedAgents,
  onSelectedAgentsChange,
  availableAgents,
  maxAgents,
  persistToServer,
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
  useInstanceManagement,
  instances,
  onInstancesChange,
  visibleInstanceIds,
  onToggleInstanceVisible,
}: MobileContentProps) {
  switch (activeTab) {
    case 'terminal':
      return (
        <ErrorBoundary componentName="TerminalDisplay">
          <MobileTerminalTab
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={instanceId}
            disableAutoFollow={disableAutoFollow}
          />
        </ErrorBoundary>
      );
    case 'history':
      return (
        <div className="h-full flex flex-col">
          {/* History sub-tab switcher: Message | Git (Issue #447) */}
          <div className="flex border-b border-border shrink-0">
            <button
              type="button"
              onClick={() => onHistorySubTabChange('message')}
              // Issue #1127: min-h-[44px] + touch-manipulation — ≥44px tap
              // target (text stays text-xs) and no double-tap zoom delay.
              className={`flex-1 min-h-[44px] px-3 py-1.5 text-xs font-medium transition-colors touch-manipulation ${
                historySubTab === 'message'
                  ? 'text-accent-600 dark:text-accent-400 border-b-2 border-accent-600 dark:border-accent-400 bg-accent-50 dark:bg-accent-900/30'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Message
            </button>
            <button
              type="button"
              onClick={() => onHistorySubTabChange('git')}
              // Issue #1127: min-h-[44px] + touch-manipulation — ≥44px tap
              // target (text stays text-xs) and no double-tap zoom delay.
              className={`flex-1 min-h-[44px] px-3 py-1.5 text-xs font-medium transition-colors touch-manipulation ${
                historySubTab === 'git'
                  ? 'text-accent-600 dark:text-accent-400 border-b-2 border-accent-600 dark:border-accent-400 bg-accent-50 dark:bg-accent-900/30'
                  : 'text-muted-foreground hover:text-foreground'
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
                worktree={worktree ?? undefined}
                onInsertToMessage={onInsertToMessage}
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
              onResetView={onFileTreeReset}
              refreshTrigger={refreshTrigger}
              pollingEnabled={activeTab === 'files'}
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
            availableAgents={availableAgents}
            maxAgents={maxAgents}
            persistToServer={persistToServer}
            vibeLocalModel={vibeLocalModel}
            onVibeLocalModelChange={onVibeLocalModelChange}
            vibeLocalContextWindow={vibeLocalContextWindow}
            onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
            onInsertToMessage={onInsertToMessage}
            useInstanceManagement={useInstanceManagement}
            instances={instances}
            onInstancesChange={onInstancesChange}
            visibleInstanceIds={visibleInstanceIds}
            onToggleInstanceVisible={onToggleInstanceVisible}
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
