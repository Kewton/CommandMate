/**
 * WorktreeDetailDesktop (Issue #755)
 *
 * PC (desktop) orchestrator extracted from WorktreeDetailRefactored.tsx as a
 * pure structural refactor (no behavior change). Owns the PC-only memoized
 * panes (renderSplitPane / terminalSplitRegion / rightPaneSplitMemo /
 * activityBarMemo / activityContent / activityPaneMemo) and the 2-column
 * desktop layout body, delegating the layout frame to WorktreeDesktopLayout
 * (S1-003) and the terminal column to TerminalContainer.
 *
 * MarkdownEditor (dynamic, ssr:false) and its Editor Modal stay in the parent
 * orchestrator (S3-002); the parent renders the editor modal as a sibling of
 * this component. File editing is delegated up via onEditMarkdown elsewhere.
 *
 * Closure-dependency stability (S1-004): every value `renderSplitPane` closes
 * over (pendingInsertTextMap / handleInsertToSplit / handleInsertConsumed,
 * setFocusedSplitIndex, makeAutoYesToggleHandler, deriveCliStatus-derived
 * status) is received as a stable-reference prop so the useCallback dependency
 * array structure here matches the pre-refactor parent exactly, preserving the
 * #728/#740/#743 per-split re-render characteristics.
 */

'use client';

import React, { memo, useCallback, useMemo } from 'react';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';
import { TerminalContainer } from '@/components/worktree/TerminalContainer';
import { type WorktreeStatus } from '@/components/mobile/MobileHeader';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { SearchBar } from '@/components/worktree/SearchBar';
import { ActivityBar } from '@/components/worktree/ActivityBar';
import { ActivityPane, type ActivityContentMap } from '@/components/worktree/ActivityPane';
import type { ActivityId } from '@/config/activity-bar-config';
import { FileTreeView } from '@/components/worktree/FileTreeView';
import { FilePanelSplit } from '@/components/worktree/FilePanelSplit';
import { TerminalSplitContainer } from '@/components/worktree/TerminalSplitContainer';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MemoPane } from '@/components/worktree/MemoPane';
import { ExecutionLogPane } from '@/components/worktree/ExecutionLogPane';
import { TimerPane } from '@/components/worktree/TimerPane';
import { AgentSettingsPane } from '@/components/worktree/AgentSettingsPane';
import { GitPane } from '@/components/worktree/GitPane';
import { Modal } from '@/components/ui/Modal';
import { BranchMismatchAlert } from '@/components/worktree/BranchMismatchAlert';
import { MoveDialog } from '@/components/worktree/MoveDialog';
import { NewFileDialog } from '@/components/worktree/NewFileDialog';
import { ToastContainer, type ToastItem } from '@/components/common/Toast';
import { DesktopHeader, InfoModal } from '@/components/worktree/WorktreeDetailSubComponents';
import { UPLOADABLE_EXTENSIONS } from '@/config/uploadable-extensions';
import { deriveCliStatus } from '@/types/sidebar';
import { getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';
import type { AutoYesToggleParams } from '@/components/worktree/AutoYesToggle';
import type { ShowToast } from '@/types/markdown-editor';
import type { Worktree, FileContent } from '@/types/models';
import type { UseFileSearchReturn } from '@/hooks/useFileSearch';
import type { FileTabsState, FileTabsActions } from '@/hooks/useFileTabs';
import type { HistoryDisplayLimit } from '@/config/history-display-config';
import type { MoveTarget } from '@/hooks/useFileOperations';

/** Props for WorktreeDetailDesktop. */
export interface WorktreeDetailDesktopProps {
  worktreeId: string;
  worktree: Worktree | null;
  worktreeName: string;
  worktreeStatus: WorktreeStatus;
  activeCliTab: CLIToolType;
  setActiveCliTab: (tool: CLIToolType) => void;
  selectedAgents: CLIToolType[];
  hasUpdate: boolean;
  lastAutoResponse: string | null;

  // Activity Bar
  activeActivity: ActivityId | null;
  onActivityToggle: (id: ActivityId) => void;

  // Header actions
  onBackClick: () => void;
  onInfoClick: () => void;
  onWorktreeStatusChange: (status: 'ready' | 'in_progress' | 'in_review' | 'done' | null) => void;

  // Pending insert text (usePendingInsertText, Issue #755)
  pendingInsertTextMap: Map<number, string | null>;
  setFocusedSplitIndex: (idx: number) => void;
  handleInsertToSplit: (splitIndex: number, text: string) => void;
  handleInsertConsumed: (idx: number) => void;
  handleInsertToMessage: (text: string) => void;

  // Auto-yes (per-CLI)
  autoYesStateMap: Map<string, { enabled: boolean; expiresAt: number | null }>;
  makeAutoYesToggleHandler: (cliToolId: CLIToolType) => (params: AutoYesToggleParams) => Promise<void>;

  // History controls
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
  historyDisplayLimit: HistoryDisplayLimit;
  onHistoryDisplayLimitChange: (limit: HistoryDisplayLimit) => void;
  historyUserOnly: boolean;
  onHistoryUserOnlyChange: (userOnly: boolean) => void;

  // Messaging
  onMessageSent: () => void;
  onFilePathClick: (path: string) => void;
  /** Issue #786 (D-5): shared `ShowToast` alias (`'warning'` included for drop reject toast). */
  showToast: ShowToast;

  // File tabs / right pane
  tabsState: FileTabsState;
  tabsActions: FileTabsActions;
  onLoadContent: (path: string, content: FileContent) => void;
  onLoadError: (path: string, errorMsg: string) => void;
  onSetLoading: (path: string, isLoading: boolean) => void;
  onFilePanelSave: (savedPath: string) => void;
  onDirtyChange: (path: string, isDirty: boolean) => void;
  onOpenFile: (path: string) => void;
  diffContent: string | null;
  diffFilePath: string | null;
  onCloseDiff: () => void;

  // Files activity (tree + search)
  fileSearch: UseFileSearchReturn;
  fileTreeRefresh: number;
  onFileSelect: (path: string) => void;
  onNewFile: (parentPath: string) => void;
  onNewDirectory: (parentPath: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onUpload: (targetDir: string) => void;
  onMove: (path: string, type: 'file' | 'directory') => void;

  // Git activity
  onDiffSelect: (diff: string, filePath: string) => void;

  // Agent activity
  onSelectedAgentsChange: (agents: CLIToolType[]) => void;
  vibeLocalModel: string | null;
  onVibeLocalModelChange: (model: string | null) => void;
  vibeLocalContextWindow: number | null;
  onVibeLocalContextWindowChange: (value: number | null) => void;

  // Info modal
  isInfoModalOpen: boolean;
  onInfoModalClose: () => void;
  onWorktreeUpdate: (updated: Worktree) => void;

  // File input
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // Kill session confirmation
  /** Opens the kill confirmation modal for the active CLI session (Issue #784). */
  onKillSession: () => void;
  showKillConfirm: boolean;
  onKillCancel: () => void;
  onKillConfirm: () => void;

  // Move dialog
  moveTarget: MoveTarget | null;
  isMoveDialogOpen: boolean;
  onMoveCancel: () => void;
  onMoveConfirm: (destPath: string) => void;

  // New file dialog
  showNewFileDialog: boolean;
  newFileParentPath: string;
  onNewFileConfirm: (finalName: string) => void;
  onNewFileCancel: () => void;

  // Toasts
  toasts: ToastItem[];
  onToastClose: (id: string) => void;

  // i18n strings (resolved by parent to avoid duplicate translation namespaces)
  killDialogTitle: string;
  killDialogWarning: string;
  cancelLabel: string;
  endLabel: string;
}

/**
 * WorktreeDetailDesktop - PC orchestrator for the worktree detail screen.
 */
export const WorktreeDetailDesktop = memo(function WorktreeDetailDesktop({
  worktreeId,
  worktree,
  worktreeName,
  worktreeStatus,
  activeCliTab,
  setActiveCliTab,
  selectedAgents,
  hasUpdate,
  lastAutoResponse,
  activeActivity,
  onActivityToggle,
  onBackClick,
  onInfoClick,
  onWorktreeStatusChange,
  pendingInsertTextMap,
  setFocusedSplitIndex,
  handleInsertToSplit,
  handleInsertConsumed,
  handleInsertToMessage,
  autoYesStateMap,
  makeAutoYesToggleHandler,
  showArchived,
  onShowArchivedChange,
  historyDisplayLimit,
  onHistoryDisplayLimitChange,
  historyUserOnly,
  onHistoryUserOnlyChange,
  onMessageSent,
  onFilePathClick,
  showToast,
  tabsState,
  tabsActions,
  onLoadContent,
  onLoadError,
  onSetLoading,
  onFilePanelSave,
  onDirtyChange,
  onOpenFile,
  diffContent,
  diffFilePath,
  onCloseDiff,
  fileSearch,
  fileTreeRefresh,
  onFileSelect,
  onNewFile,
  onNewDirectory,
  onRename,
  onDelete,
  onUpload,
  onMove,
  onDiffSelect,
  onSelectedAgentsChange,
  vibeLocalModel,
  onVibeLocalModelChange,
  vibeLocalContextWindow,
  onVibeLocalContextWindowChange,
  isInfoModalOpen,
  onInfoModalClose,
  onWorktreeUpdate,
  fileInputRef,
  onFileInputChange,
  onKillSession,
  showKillConfirm,
  onKillCancel,
  onKillConfirm,
  moveTarget,
  isMoveDialogOpen,
  onMoveCancel,
  onMoveConfirm,
  showNewFileDialog,
  newFileParentPath,
  onNewFileConfirm,
  onNewFileCancel,
  toasts,
  onToastClose,
  killDialogTitle,
  killDialogWarning,
  cancelLabel,
  endLabel,
}: WorktreeDetailDesktopProps) {
  /**
   * Issue #786: the cliId currently being dragged from a DesktopHeader agent
   * indicator. Published here so each split can drive its dragOver
   * allowed/forbidden ring (D-2; getData is unreadable during dragover in real
   * browsers). This is React state, not a ref, because the splits must re-render
   * to show the ring while a drag is in flight. That transient re-render only
   * happens at drag start/end — NOT on the polling cadence — so it does not
   * regress the #743/#756 memo stability (which concerns the steady state).
   */
  const [draggedCliTool, setDraggedCliTool] = React.useState<CLIToolType | null>(null);
  const handleAgentDragStart = useCallback(
    (cliId: CLIToolType) => setDraggedCliTool(cliId),
    [],
  );
  const handleAgentDragEnd = useCallback(() => setDraggedCliTool(null), []);

  /**
   * Issue #728 (R3-005): PC-only per-split polling fan-out.
   *
   * Each `TerminalSplitPaneContent` owns its own
   * `useTerminalPanePolling({ worktreeId, cliToolId })` instance, so
   *   split 0 (Claude) and split 1 (Codex) hit /current-output for their own
   *   CLI independently. NavigationButtons / PromptPanel / MessageInput are
   *   rendered for every split.
   *
   * The activeCliTab still tracks split 0 so HistoryPane / Auto-Yes UI / kill
   * session controls (which are CLI-tab-scoped, not split-scoped) continue
   * working. We only sync activeCliTab when split 0's CLI changes.
   */
  const renderSplitPane = useCallback(
    ({
      splitIndex,
      cliToolId: paneCli,
      availableCliTools: paneAvailable,
      onCliToolChange,
      onFocus: onPaneFocus,
      onDropCliTool,
    }: {
      splitIndex: number;
      cliToolId: CLIToolType;
      availableCliTools: CLIToolType[];
      onCliToolChange: (id: CLIToolType) => void;
      onFocus: () => void;
      isFocused: boolean;
      onDropCliTool: (cliId: CLIToolType) => void;
    }) => {
      const panePendingInsert = pendingInsertTextMap.get(splitIndex) ?? null;
      // Issue #525 / #740: auto-yes state is per-CLI in autoYesStateMap; each
      // split resolves its own enabled/expiresAt by its own cliToolId.
      const paneAutoYes = autoYesStateMap.get(paneCli);
      const paneAutoYesEnabled = paneAutoYes?.enabled ?? false;
      const paneAutoYesExpiresAt = paneAutoYes?.expiresAt ?? null;
      // Issue #743: derive THIS pane's AI agent status from the per-CLI session
      // flags. Only the resolved BranchStatus string is handed to the child, so
      // a polling tick that leaves the status unchanged does not break the
      // child's memo (S3-001 memo-safe).
      const paneCliStatus = deriveCliStatus(worktree?.sessionStatusByCli?.[paneCli]);
      return (
        <TerminalSplitPaneContent
          worktreeId={worktreeId}
          splitIndex={splitIndex}
          cliToolId={paneCli}
          availableCliTools={paneAvailable}
          onCliToolChange={(id) => {
            onCliToolChange(id);
            // Sync the (worktree-global) activeCliTab so HistoryPane / Auto-Yes
            // toggle UI / kill-session controls follow split 0.
            if (splitIndex === 0) setActiveCliTab(id);
          }}
          onFocus={onPaneFocus}
          pendingInsertText={panePendingInsert}
          onInsertConsumed={() => handleInsertConsumed(splitIndex)}
          onMessageSent={onMessageSent}
          // Issue #743: derived per-CLI status string for the split header dot.
          cliStatus={paneCliStatus}
          // Issue #756: Auto-Yes domain group. Issue #740: enabled/expiresAt are
          // per-CLI; lastAutoResponse is activeCliTab-scoped (useAutoYes), shared
          // across splits for the toggle notification (Issue #501 owns per-split
          // client-side notification, which is out of scope). onToggle is the
          // per-split toggle bound to THIS pane's CLI. Plain inline object: this
          // is a render-prop callback so hooks (useMemo) are illegal here, and
          // the call site already passed unstable inline fns (re-render unchanged).
          autoYes={{
            enabled: paneAutoYesEnabled,
            expiresAt: paneAutoYesExpiresAt,
            lastAutoResponse: lastAutoResponse,
            onToggle: makeAutoYesToggleHandler(paneCli),
          }}
          // Issue #756: History domain group. Issue #744: embedded per-split
          // HistoryPane. Each split fetches its OWN cliToolId's messages
          // (useSplitMessages) and shows them only in its own pane. History
          // display controls are common (MVP); the insert handler is bound to
          // THIS splitIndex so an "Insert" click targets this split's
          // MessageInput directly (S3-005), not focusedSplitIndex.
          history={{
            showArchived: showArchived,
            onShowArchivedChange: onShowArchivedChange,
            historyDisplayLimit: historyDisplayLimit,
            onHistoryDisplayLimitChange: onHistoryDisplayLimitChange,
            historyUserOnly: historyUserOnly,
            onHistoryUserOnlyChange: onHistoryUserOnlyChange,
            onInsertToMessage: (text) => handleInsertToSplit(splitIndex, text),
            onFilePathClick: onFilePathClick,
            showToast: showToast,
          }}
          // Issue #786: drag-drop. onDropCliTool is the container-owned drop
          // handler (no-op/reject/apply classification) supplied via renderPane
          // args — passed through unchanged. draggedCliTool drives the dragOver
          // ring (D-2). The hover ring state itself stays child-local (D-3).
          onDropCliTool={onDropCliTool}
          draggedCliTool={draggedCliTool}
        />
      );
    },
    [
      worktreeId,
      pendingInsertTextMap,
      autoYesStateMap,
      handleInsertConsumed,
      onMessageSent,
      setActiveCliTab,
      lastAutoResponse,
      makeAutoYesToggleHandler,
      // Issue #743: re-create renderPane when the per-CLI session status map
      // changes so the derived `cliStatus` stays current. The child only
      // re-renders when its resolved status string actually changes (memo-safe).
      worktree?.sessionStatusByCli,
      // Issue #744: embedded HistoryPane wiring deps.
      onFilePathClick,
      showToast,
      handleInsertToSplit,
      showArchived,
      onShowArchivedChange,
      historyDisplayLimit,
      onHistoryDisplayLimitChange,
      historyUserOnly,
      onHistoryUserOnlyChange,
      // Issue #786: re-create renderPane when the dragged cliId changes so each
      // split's dragOver ring reflects the in-flight drag (drag-time only, not a
      // polling-cadence re-render).
      draggedCliTool,
    ],
  );

  const terminalSplitRegion = useMemo(
    () => (
      <TerminalSplitContainer
        worktreeId={worktreeId}
        renderPane={renderSplitPane}
        onFocusedSplitChange={setFocusedSplitIndex}
        // Issue #786: the container is the drop validation owner; it fires the
        // success/reject toast and syncs activeCliTab on an applied drop.
        showToast={showToast}
        onActiveCliTabChange={setActiveCliTab}
      />
    ),
    // setFocusedSplitIndex / setActiveCliTab are stable callbacks, and showToast
    // is a stable parent callback, so listing them does not destabilize the memo
    // beyond the existing per-render cadence.
    [worktreeId, renderSplitPane, setFocusedSplitIndex, showToast, setActiveCliTab],
  );

  /**
   * Issue #728: PC right pane variant. Uses TerminalSplitContainer in the
   * terminal slot of FilePanelSplit and passes terminalHeader={null}.
   */
  const rightPaneSplitMemo = useMemo(
    () => (
      <FilePanelSplit
        terminal={terminalSplitRegion}
        terminalHeader={null}
        fileTabs={tabsState}
        worktreeId={worktreeId}
        onCloseTab={tabsActions.closeTab}
        onActivateTab={tabsActions.activateTab}
        onLoadContent={onLoadContent}
        onLoadError={onLoadError}
        onSetLoading={onSetLoading}
        onFileSaved={onFilePanelSave}
        diffContent={diffContent}
        diffFilePath={diffFilePath}
        onCloseDiff={onCloseDiff}
        onDirtyChange={onDirtyChange}
        onMoveToFront={tabsActions.moveToFront}
        onOpenFile={onOpenFile}
      />
    ),
    [
      terminalSplitRegion,
      tabsState,
      worktreeId,
      tabsActions.closeTab,
      tabsActions.activateTab,
      onLoadContent,
      onLoadError,
      onSetLoading,
      onFilePanelSave,
      diffContent,
      diffFilePath,
      onCloseDiff,
      onDirtyChange,
      tabsActions.moveToFront,
      onOpenFile,
    ],
  );

  /**
   * Issue #727: Activity Bar (memoized).
   *
   * MAINTENANCE NOTE (Issue #411 R3-007 / Issue #727):
   * The dependency array below lists every prop and callback referenced
   * inside the JSX. When adding a new prop, add it to this array.
   */
  const activityBarMemo = useMemo(
    () => <ActivityBar active={activeActivity} onToggle={onActivityToggle} />,
    [activeActivity, onActivityToggle]
  );

  /**
   * Issue #727: Activity Pane content map (memoized).
   *
   * MAINTENANCE NOTE (Issue #411 R3-007 / Issue #727):
   * Add every prop / state / callback used inside any activity child to the
   * deps array below or the memoized child output will be stale.
   */
  const activityContent = useMemo<ActivityContentMap>(
    () => ({
      files: (
        <div className="h-full flex flex-col">
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
            refreshTrigger={fileTreeRefresh}
            searchQuery={fileSearch.query}
            searchMode={fileSearch.mode}
            searchResults={fileSearch.results?.results}
            className="flex-1 min-h-0"
          />
        </div>
      ),
      git: (
        <GitPane
          worktreeId={worktreeId}
          onDiffSelect={onDiffSelect}
          isMobile={false}
          worktree={worktree ?? undefined}
          onInsertToMessage={handleInsertToMessage}
          className="h-full"
        />
      ),
      notes: (
        <MemoPane
          worktreeId={worktreeId}
          className="h-full"
          onInsertToMessage={handleInsertToMessage}
        />
      ),
      schedules: (
        <ExecutionLogPane
          worktreeId={worktreeId}
          className="h-full"
          onInsertToMessage={handleInsertToMessage}
        />
      ),
      agent: (
        <AgentSettingsPane
          worktreeId={worktreeId}
          selectedAgents={selectedAgents}
          onSelectedAgentsChange={onSelectedAgentsChange}
          maxAgents={5}
          vibeLocalModel={vibeLocalModel}
          onVibeLocalModelChange={onVibeLocalModelChange}
          vibeLocalContextWindow={vibeLocalContextWindow}
          onVibeLocalContextWindowChange={onVibeLocalContextWindowChange}
        />
      ),
      timer: <TimerPane worktreeId={worktreeId} />,
    }),
    [
      worktreeId,
      worktree,
      fileSearch.query,
      fileSearch.mode,
      fileSearch.isSearching,
      fileSearch.error,
      fileSearch.setQuery,
      fileSearch.setMode,
      fileSearch.clearSearch,
      fileSearch.results?.results,
      onFileSelect,
      onNewFile,
      onNewDirectory,
      onRename,
      onDelete,
      onUpload,
      onMove,
      fileTreeRefresh,
      onDiffSelect,
      handleInsertToMessage,
      selectedAgents,
      onSelectedAgentsChange,
      vibeLocalModel,
      onVibeLocalModelChange,
      vibeLocalContextWindow,
      onVibeLocalContextWindowChange,
    ]
  );

  const activityPaneMemo = useMemo(
    () =>
      activeActivity === null ? null : (
        <ActivityPane active={activeActivity} activities={activityContent} />
      ),
    [activeActivity, activityContent]
  );

  // Issue #744: the top-level HistoryPane (historyPaneMemo) was removed — the
  // History pane now lives inside each PC terminal split
  // (`TerminalSplitPaneContent`), fetching its own cliToolId's messages. The
  // mobile path renders its own HistoryPane via `MobileContent` (unchanged).

  return (
    <ErrorBoundary componentName="WorktreeDetailRefactored">
      {/*
        Issue #730: Outer flex puts the ActivityBar as a full-height column
        on the left (Header bottom → viewport bottom, VS Code style). The
        inner column hosts DesktopHeader / BranchMismatchAlert /
        WorktreeDesktopLayout (now a 2-column layout) / NavigationButtons /
        MessageInput / PromptPanel.

        History now lives inside `TerminalContainer` (passed as `rightPane`),
        so the desktop layout itself no longer takes a `historyPane` prop.
      */}
      <div className="flex h-full overflow-hidden relative">
        {activityBarMemo}
        {/* Issue #732: min-w-0 主因。flex-row(L1738) の直接 flex item のため
            main 軸に min-width:auto が効き、子孫 FilePanelSplit の固定幅ペインの
            コンテンツ要求まで膨張して FilePanel が viewport 外へ押し出される問題を防ぐ */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
          {/* Desktop Header with back button, status, and info */}
          <DesktopHeader
            worktreeName={worktreeName}
            repositoryName={worktree?.repositoryDisplayName ?? worktree?.repositoryName ?? 'Unknown'}
            description={worktree?.description}
            status={worktreeStatus}
            gitStatus={worktree?.gitStatus}
            onBackClick={onBackClick}
            onInfoClick={onInfoClick}
            hasUpdate={hasUpdate}
            worktreeStatus={worktree?.status ?? null}
            onWorktreeStatusChange={onWorktreeStatusChange}
            sessionStatusByCli={worktree?.sessionStatusByCli}
            selectedAgents={selectedAgents}
            activeCliTab={activeCliTab}
            onActiveCliTabChange={setActiveCliTab}
            // Issue #786: publish the dragged agent's cliId so each terminal
            // split can show its dragOver allowed/forbidden ring (D-2).
            onAgentDragStart={handleAgentDragStart}
            onAgentDragEnd={handleAgentDragEnd}
            onKillSession={onKillSession}
          />
          {/* Issue #111: Branch mismatch warning */}
          {worktree?.gitStatus && (
            <BranchMismatchAlert
              isBranchMismatch={worktree.gitStatus.isBranchMismatch}
              currentBranch={worktree.gitStatus.currentBranch}
              initialBranch={worktree.gitStatus.initialBranch}
            />
          )}
          {/* Issue #732: min-w-0 防御的補強。横溢れ防止のため main 軸主因(L1740)と
              併せて付与。将来のクリーンアップで誤削除しないこと */}
          <div className="flex-1 min-h-0 min-w-0">
            <WorktreeDesktopLayout
              activityPane={activityPaneMemo}
              rightPane={
                // Issue #744: History moved into each terminal split, so the
                // top-level History column is no longer rendered on PC.
                <TerminalContainer terminal={rightPaneSplitMemo} />
              }
            />
          </div>
          {/*
            Issue #728: MessageInput / NavigationButtons / PromptPanel were
            moved into each TerminalSplitPane (`rightPaneSplitMemo`). No
            shared footer rendering on PC anymore.
          */}
        </div>
        {/* Info Modal */}
        <InfoModal
          worktreeId={worktreeId}
          worktree={worktree}
          isOpen={isInfoModalOpen}
          onClose={onInfoModalClose}
          onWorktreeUpdate={onWorktreeUpdate}
        />
        {/* Issue #438: Desktop FileViewer modal replaced by FilePanelSplit in rightPaneMemo */}
        {/* Issue #755 (S3-002): the Markdown Editor Modal stays in the parent
            orchestrator and is rendered alongside this component. */}
        {/* Hidden file input for upload */}
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOADABLE_EXTENSIONS.join(',')}
          onChange={onFileInputChange}
          className="hidden"
          aria-label="Upload file"
        />
        {/* Kill session confirmation dialog */}
        <Modal
          isOpen={showKillConfirm}
          onClose={onKillCancel}
          title={killDialogTitle}
          size="sm"
          showCloseButton={true}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              {killDialogWarning}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onKillCancel}
                className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onKillConfirm}
                className="px-4 py-2 text-sm font-medium rounded-md bg-red-600 hover:bg-red-700 text-white"
              >
                {endLabel}
              </button>
            </div>
          </div>
        </Modal>
        {/* [Issue #162] Move Dialog */}
        {moveTarget && (
          <MoveDialog
            isOpen={isMoveDialogOpen}
            onClose={onMoveCancel}
            onConfirm={onMoveConfirm}
            worktreeId={worktreeId}
            sourcePath={moveTarget.path}
            sourceType={moveTarget.type}
          />
        )}
        {/* [Issue #646] New file dialog */}
        <NewFileDialog
          isOpen={showNewFileDialog}
          parentPath={newFileParentPath}
          onConfirm={onNewFileConfirm}
          onCancel={onNewFileCancel}
        />
        {/* Toast notifications */}
        <ToastContainer toasts={toasts} onClose={onToastClose} />
      </div>
    </ErrorBoundary>
  );
});

// Note: getCliToolDisplayName is re-exported indirectly via the parent; keeping
// it imported here documents the kill-dialog title source (resolved by parent).
void getCliToolDisplayName;
