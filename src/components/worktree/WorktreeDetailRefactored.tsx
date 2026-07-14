/**
 * WorktreeDetailRefactored Component
 *
 * Integrates worktree UI components with responsive layout support:
 * - Desktop: 2-column split layout (History | Terminal) with resizable panes
 * - Mobile: Tab-based navigation with header and bottom tab bar
 *
 * Features:
 * - Real-time terminal output polling
 * - Prompt detection and response handling
 * - Error boundary protection
 * - useReducer-based state management
 *
 * Based on Issue #13 UX Improvement design specification
 */

'use client';

import React, { memo, useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { MoreHorizontal } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { MobileHeader } from '@/components/mobile/MobileHeader';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { StatusDot } from '@/components/ui/StatusDot';
import { MobileTabBar } from '@/components/mobile/MobileTabBar';
import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import { MobileTerminalActionsSheet } from '@/components/mobile/MobileTerminalActionsSheet';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { MessageInput } from '@/components/worktree/MessageInput';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { FileViewer } from '@/components/worktree/FileViewer';


/**
 * Dynamic import of MarkdownEditor with SSR disabled.
 * highlight.js / rehype-highlight require browser APIs during rendering.
 * Uses .then() pattern because MarkdownEditor is a named export.
 */
const MarkdownEditor = dynamic(
  () =>
    import('@/components/worktree/MarkdownEditor').then((mod) => ({
      default: mod.MarkdownEditor,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full bg-surface text-muted-foreground">
        <Spinner size="lg" className="mr-2" />
        <span>Loading editor...</span>
      </div>
    ),
  }
);
import {
  LoadingIndicator,
  ErrorDisplay,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { MobileContent } from '@/components/worktree/WorktreeDetailMobile';
import { WorktreeDetailDesktop } from '@/components/worktree/WorktreeDetailDesktop';
import { UPLOADABLE_EXTENSIONS } from '@/config/uploadable-extensions';
import { ToastContainer } from '@/components/common/Toast';
import { Modal } from '@/components/ui/Modal';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';
import { BranchMismatchAlert } from '@/components/worktree/BranchMismatchAlert';
import { getCliToolDisplayName, getInstanceLabel, getActiveInstanceLabel } from '@/lib/cli-tools/types';
import { deriveCliStatus } from '@/types/sidebar';
import { MoveDialog } from '@/components/worktree/MoveDialog';
import { NewFileDialog } from '@/components/worktree/NewFileDialog';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import { useVirtualKeyboard } from '@/hooks/useVirtualKeyboard';
import type { MobileTab } from '@/components/mobile/MobileTabBar';

// ============================================================================
// Types
// ============================================================================

/** Props for WorktreeDetailRefactored component */
export interface WorktreeDetailRefactoredProps {
  /** Worktree ID to display */
  worktreeId: string;
}

/**
 * Issue #874: Mobile agent selection is now driven by per-instance visibility
 * (useMobileSelectedInstances), so the legacy `onSelectedAgentsChange` callback
 * is never invoked on mobile. A stable module-level no-op keeps the prop
 * satisfied (it stays required for the PC-style AgentSettingsPane fallback)
 * without recreating a function on every render.
 */
const NOOP_SELECTED_AGENTS_CHANGE = (): void => {};

/**
 * Issue #1128: left-to-right order of the mobile tabs, matching MobileTabBar's
 * TABS array. Horizontal swipes step through this order (no wraparound) and the
 * MobileTabBar indicator stays in sync because both read the same `activeTab`.
 */
const MOBILE_TAB_ORDER: readonly MobileTab[] = ['terminal', 'history', 'files', 'memo', 'info'];

/**
 * Issue #1128: horizontal travel (px) required to switch tabs — deliberately
 * above the 50px default so a small horizontal wobble during a vertical scroll
 * never flips tabs (the direction lock is the primary guard; this is a backstop).
 */
const TAB_SWIPE_THRESHOLD = 60;

/**
 * Issue #1128: on the Terminal tab the swipe must start within this many pixels
 * of a screen edge. The terminal body supports text selection and reading, so
 * central swipes are ignored and only an intentional edge swipe changes tabs.
 */
const TERMINAL_SWIPE_EDGE_ZONE = 32;

// ============================================================================
// Main Component
// ============================================================================

/**
 * WorktreeDetailRefactored - Integrated worktree detail component
 *
 * @example
 * ```tsx
 * <WorktreeDetailRefactored worktreeId="feature-123" />
 * ```
 */
import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { useNewOutputIndicator } from '@/hooks/useNewOutputIndicator';
export const WorktreeDetailRefactored = memo(function WorktreeDetailRefactored({
  worktreeId,
}: WorktreeDetailRefactoredProps) {
  const {
    activeActivity,
    activeCliTab,
    activeInstanceId,
    activeTab,
    agentInstances,
    autoYesEnabled,
    autoYesExpiresAt,
    autoYesStateMap,
    diffContent,
    diffFilePath,
    disableAutoFollow,
    displayedInstances,
    editorFilePath,
    error,
    fetchCurrentOutput,
    fileInputRef,
    fileSearch,
    fileTreeRefresh,
    handleActivityToggle,
    handleAgentInstancesChange,
    handleAutoYesToggle,
    handleBackClick,
    handleCloseDiff,
    handleDelete,
    handleDiffSelect,
    handleDirtyChange,
    handleEditorClose,
    handleEditorSave,
    handleFileInputChange,
    handleFilePanelSave,
    handleFilePathClick,
    handleFileSelect,
    handleHistoryDisplayLimitChange,
    handleHistoryUserOnlyChange,
    handleInfoClick,
    handleInfoModalClose,
    handleInsertConsumed,
    handleInsertConsumedSingle,
    handleInsertToMessage,
    handleInsertToSplit,
    handleKillCancel,
    handleKillConfirm,
    openKillConfirm,
    openActiveKillConfirm,
    killTarget,
    isKillPending,
    handleLoadContent,
    handleLoadError,
    handleMessageSent,
    handleMobileFileViewerClose,
    handleMobileTabChange,
    handleMove,
    handleMoveCancel,
    handleMoveConfirm,
    handleNewDirectory,
    handleNewFile,
    handleNewFileCancel,
    handleNewFileConfirm,
    handleOpenFile,
    handlePromptDismiss,
    handlePromptRespond,
    handleRename,
    handleRetry,
    handleSetLoading,
    handleShowArchivedChange,
    handleUpload,
    handleVibeLocalContextWindowChange,
    handleVibeLocalModelChange,
    handleWorktreeStatusChange,
    hasUpdate,
    historyDisplayLimit,
    historySubTab,
    historyUserOnly,
    isEditorMaximized,
    isInfoModalOpen,
    isMobile,
    isMoveDialogOpen,
    isSelectionListActive,
    isPagerActive,
    lastAutoResponse,
    loading,
    makeAutoYesToggleHandler,
    mobileFileViewerPath,
    mobileSelectedAgents,
    moveTarget,
    newFileParentPath,
    openMobileDrawer,
    pendingInsertText,
    pendingInsertTextMap,
    removeToast,
    rosterReady,
    setActiveInstanceId,
    setEditorFilePath,
    setFocusedSplitIndex,
    setHistorySubTab,
    setIsEditorMaximized,
    setWorktree,
    showArchived,
    showNewFileDialog,
    showToast,
    state,
    tCommon,
    tWorktree,
    tabsActions,
    tabsState,
    resetFileTreeView,
    toasts,
    toggleInstanceVisible,
    vibeLocalContextWindow,
    vibeLocalModel,
    visibleInstanceIds,
    worktree,
    worktreeName,
    worktreeStatus,
  } = useWorktreeDetailController({ worktreeId });

  // Issue #1080: mobile terminal secondary actions (search + End) moved off the
  // sticky control row into a bottom sheet, opened from a "more actions" trigger.
  const [showActionsSheet, setShowActionsSheet] = useState(false);

  // Issue #1120: push-driven "new terminal output" badge on the mobile terminal tab.
  const hasNewOutput = useNewOutputIndicator({
    worktreeId,
    active: activeTab === 'terminal',
  });

  // Issue #1166: track the visible viewport height so the mobile shell can pin
  // its container to it. When the software keyboard opens, visualViewport.height
  // shrinks (Android resizes-visual / iOS Safari) while the layout viewport does
  // not; sizing the flex column to this height keeps the in-flow composer + tab
  // bar docked directly above the keyboard (replaces the fixed+translateY hack).
  const { viewportHeight } = useVirtualKeyboard();

  // Issue #1128: step to the previous/next mobile tab (no wraparound). Keeps the
  // MobileTabBar indicator synced since both derive from the same `activeTab`.
  const goToAdjacentTab = useCallback(
    (delta: number) => {
      const index = MOBILE_TAB_ORDER.indexOf(activeTab);
      if (index === -1) return;
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= MOBILE_TAB_ORDER.length) return;
      handleMobileTabChange(MOBILE_TAB_ORDER[nextIndex]);
    },
    [activeTab, handleMobileTabChange]
  );

  // Issue #1128: horizontal tab-swipe over the mobile content area. Constrained
  // to the horizontal axis with a direction lock so a vertical scroll never
  // flips tabs; suppressed inside horizontally-scrollable panes; and restricted
  // to the screen edges while the Terminal tab is active (text selection safe).
  const { ref: tabSwipeRef } = useSwipeGesture({
    axis: 'horizontal',
    threshold: TAB_SWIPE_THRESHOLD,
    edgeStartZone: activeTab === 'terminal' ? TERMINAL_SWIPE_EDGE_ZONE : 0,
    onSwipeLeft: () => goToAdjacentTab(1),
    onSwipeRight: () => goToAdjacentTab(-1),
  });

  // Render
  // ========================================================================

  // Handle loading state
  if (loading) {
    return <LoadingIndicator />;
  }

  // Handle error state
  if (error) {
    return <ErrorDisplay message={error} onRetry={handleRetry} />;
  }

  // Issue #956: the kill-session confirmation dialog must show the active
  // instance's user-defined alias (e.g. "レビュー担当"), not the bare CLI tool
  // name. Resolve via getActiveInstanceLabel (alias-aware; falls back to the CLI
  // display name when no alias is set or the active instance is stale).
  const activeInstanceLabel = getActiveInstanceLabel(agentInstances, activeInstanceId, activeCliTab);

  // Issue #1171: the kill-confirm dialog title uses the SNAPSHOTTED target label
  // (captured at button press) so it stays fixed even if the active instance /
  // focused split / Dropdown selection changes while the dialog is open. Falls
  // back to the active instance label when no target is set (dialog closed).
  const killDialogLabel = killTarget?.label ?? activeInstanceLabel;

  // Issue #960: derive the active session's running state per-instance優先
  // （PC版と整合）so the End button and MessageInput reflect the selected
  // instance rather than the per-CLI aggregate. Falls back to the per-CLI map
  // for backward compat (single-instance / legacy configs).
  const activeSessionRunning =
    (worktree?.sessionStatusByInstance?.[activeInstanceId] ?? worktree?.sessionStatusByCli?.[activeCliTab])
      ?.isRunning ?? false;

  // Render desktop layout
  if (!isMobile) {
    return (
      <>
        {/* Issue #755: PC desktop layout extracted to WorktreeDetailDesktop. */}
        <WorktreeDetailDesktop
          worktreeId={worktreeId}
          worktree={worktree}
          worktreeName={worktreeName}
          worktreeStatus={worktreeStatus}
          instances={agentInstances}
          rosterReady={rosterReady}
          activeInstanceId={activeInstanceId}
          setActiveInstanceId={setActiveInstanceId}
          hasUpdate={hasUpdate}
          lastAutoResponse={lastAutoResponse}
          activeActivity={activeActivity}
          onActivityToggle={handleActivityToggle}
          onBackClick={handleBackClick}
          onInfoClick={handleInfoClick}
          onWorktreeStatusChange={handleWorktreeStatusChange}
          pendingInsertTextMap={pendingInsertTextMap}
          setFocusedSplitIndex={setFocusedSplitIndex}
          handleInsertToSplit={handleInsertToSplit}
          handleInsertConsumed={handleInsertConsumed}
          handleInsertToMessage={handleInsertToMessage}
          autoYesStateMap={autoYesStateMap}
          makeAutoYesToggleHandler={makeAutoYesToggleHandler}
          showArchived={showArchived}
          onShowArchivedChange={handleShowArchivedChange}
          historyDisplayLimit={historyDisplayLimit}
          onHistoryDisplayLimitChange={handleHistoryDisplayLimitChange}
          historyUserOnly={historyUserOnly}
          onHistoryUserOnlyChange={handleHistoryUserOnlyChange}
          onMessageSent={handleMessageSent}
          onFilePathClick={handleFilePathClick}
          showToast={showToast}
          tabsState={tabsState}
          tabsActions={tabsActions}
          onLoadContent={handleLoadContent}
          onLoadError={handleLoadError}
          onSetLoading={handleSetLoading}
          onFilePanelSave={handleFilePanelSave}
          onDirtyChange={handleDirtyChange}
          onOpenFile={handleOpenFile}
          diffContent={diffContent}
          diffFilePath={diffFilePath}
          onCloseDiff={handleCloseDiff}
          fileSearch={fileSearch}
          fileTreeRefresh={fileTreeRefresh}
          onFileSelect={handleFileSelect}
          onNewFile={handleNewFile}
          onNewDirectory={handleNewDirectory}
          onRename={handleRename}
          onDelete={handleDelete}
          onUpload={handleUpload}
          onMove={handleMove}
          onFileTreeReset={resetFileTreeView}
          onDiffSelect={handleDiffSelect}
          onAgentInstancesChange={handleAgentInstancesChange}
          vibeLocalModel={vibeLocalModel}
          onVibeLocalModelChange={handleVibeLocalModelChange}
          vibeLocalContextWindow={vibeLocalContextWindow}
          onVibeLocalContextWindowChange={handleVibeLocalContextWindowChange}
          isInfoModalOpen={isInfoModalOpen}
          onInfoModalClose={handleInfoModalClose}
          onWorktreeUpdate={setWorktree}
          fileInputRef={fileInputRef}
          onFileInputChange={handleFileInputChange}
          onKillSession={openActiveKillConfirm}
          onRequestSessionEnd={openKillConfirm}
          killTarget={killTarget}
          isKillPending={isKillPending}
          onKillCancel={handleKillCancel}
          onKillConfirm={handleKillConfirm}
          moveTarget={moveTarget}
          isMoveDialogOpen={isMoveDialogOpen}
          onMoveCancel={handleMoveCancel}
          onMoveConfirm={handleMoveConfirm}
          showNewFileDialog={showNewFileDialog}
          newFileParentPath={newFileParentPath}
          onNewFileConfirm={handleNewFileConfirm}
          onNewFileCancel={handleNewFileCancel}
          toasts={toasts}
          onToastClose={removeToast}
          killDialogTitle={tWorktree('session.confirmEnd', { tool: killDialogLabel })}
          killDialogWarning={tWorktree('session.endWarning')}
          cancelLabel={tCommon('cancel')}
          endLabel={tCommon('end')}
        />
        {/* Issue #755 (S3-002): the Markdown Editor Modal stays in the parent
            orchestrator (dynamic import with ssr:false declared here) and is
            rendered alongside WorktreeDetailDesktop. */}
        {editorFilePath && (
          <Modal
            isOpen={true}
            onClose={handleEditorClose}
            title={editorFilePath.split('/').pop() || 'Editor'}
            size="full"
            disableClose={isEditorMaximized}
          >
            <div className="h-[80vh]">
              <MarkdownEditor
                worktreeId={worktreeId}
                filePath={editorFilePath}
                onClose={handleEditorClose}
                onSave={handleEditorSave}
                onMaximizedChange={setIsEditorMaximized}
              />
            </div>
          </Modal>
        )}
      </>
    );
  }

  // Render mobile layout
  //
  // Issue #1166: the mobile shell is a flex column whose height tracks the
  // *visible* viewport (visualViewport.height), mirroring the proven
  // FullScreenModal pattern. Header / instance-tabs / composer / tab bar are all
  // `flex-shrink-0` in normal flow and the scrollable content is `flex-1
  // min-h-0`, so when the keyboard opens the container shrinks and the composer
  // + tab bar stay docked directly above it — no `position: fixed` and no
  // `translateY` lift (which mis-referenced the layout-viewport bottom and made
  // the composer fly off-screen on Android Chrome). Falls back to `100%` (fill
  // the AppShell main) until visualViewport is measured / on unsupported
  // browsers, preserving the pre-#1166 full-height behavior.
  return (
    <ErrorBoundary componentName="WorktreeDetailRefactored">
      <div
        className="flex flex-col overflow-hidden"
        style={{ height: viewportHeight != null ? `${viewportHeight}px` : '100%' }}
        data-testid="mobile-worktree-shell"
      >
        <div className="flex-shrink-0">
          <MobileHeader
            worktreeName={worktreeName}
            repositoryName={worktree?.repositoryName}
            status={worktreeStatus}
            gitStatus={worktree?.gitStatus}
            onBackClick={handleBackClick}
            onMenuClick={openMobileDrawer}
          />
        </div>

        {/* Issue #111: Branch mismatch warning (Mobile) */}
        {worktree?.gitStatus && worktree.gitStatus.isBranchMismatch && (
          <div className="z-35 flex-shrink-0">
            <BranchMismatchAlert
              isBranchMismatch={worktree.gitStatus.isBranchMismatch}
              currentBranch={worktree.gitStatus.currentBranch}
              initialBranch={worktree.gitStatus.initialBranch}
            />
          </div>
        )}

        {/* Agent-instance tabs row (Mobile, Issue #1080) — dedicated to the
            per-instance tabs. Auto-Yes moved into the composer meta row; terminal
            search + End moved into the "more actions" bottom sheet.
            Issue #1166: `flex-shrink-0` in the viewport-height flex column (the
            row no longer needs `sticky` — the shell itself does not scroll). */}
        <div className="flex-shrink-0 z-30 flex items-center gap-2 px-3 py-1.5 bg-surface-2 border-b border-border">
          {/* CLI tool tabs — horizontally scrollable so 3+ agents never overflow
              off-screen (Issue #958). `min-w-0` releases the flex item's default
              min-width:auto so the nav scrolls instead of expanding.
              Issue #874: per-agent-instance (alias-aware) tabs mirror the PC
              header; `displayedInstances` is the per-device visible subset.
              Issue #960: status resolved per-instance優先（PC版と整合）. */}
          <nav
            className="flex gap-1 flex-1 min-w-0 overflow-x-auto scrollbar-hide"
            aria-label="Agent Instance Selection"
          >
            {displayedInstances.map((inst) => {
              const toolStatus = deriveCliStatus(
                worktree?.sessionStatusByInstance?.[inst.id] ?? worktree?.sessionStatusByCli?.[inst.cliTool]
              );
              const statusLabel = SIDEBAR_STATUS_CONFIG[toolStatus].label;
              const isActive = activeInstanceId === inst.id;
              return (
                <button
                  key={inst.id}
                  onClick={() => setActiveInstanceId(inst.id)}
                  // Issue #1127: min-h-[44px] + touch-manipulation give these
                  // densely-packed instance tabs a ≥44px tap target (text stays
                  // text-xs; only the hit area grows) and kill the double-tap
                  // zoom delay on touch devices.
                  className={`flex-shrink-0 whitespace-nowrap min-h-[44px] px-1.5 py-1 font-medium text-xs transition-colors flex items-center gap-1 border-b-2 touch-manipulation ${
                    isActive
                      ? 'text-accent-600 dark:text-accent-400 border-accent-500'
                      : 'text-muted-foreground hover:text-foreground border-transparent'
                  }`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {/* Issue #1078: unified StatusDot visual language (was blue spinner) */}
                  <StatusDot status={toolStatus} size="sm" label={`${getInstanceLabel(inst)}: ${statusLabel}`} />
                  {getInstanceLabel(inst)}
                </button>
              );
            })}
          </nav>
          {/* More actions (terminal search + End) — pinned, opens bottom sheet */}
          <button
            type="button"
            onClick={() => setShowActionsSheet(true)}
            className="flex-shrink-0 flex items-center justify-center min-h-[44px] min-w-[44px] rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors touch-manipulation"
            aria-label={tWorktree('terminal.moreActions')}
            data-testid="mobile-more-actions-button"
          >
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Issue #1166: `flex-1 min-h-0 overflow-y-auto` — the only element that
            absorbs the flex column's remaining space and scrolls internally, so
            the fixed-height header/tabs/composer/tab bar keep their size when the
            keyboard shrinks the shell. The old 12rem bottom padding is gone: the
            composer + tab bar are now in-flow siblings, not fixed overlays. */}
        <main
          className="flex-1 min-h-0 overflow-y-auto"
          ref={tabSwipeRef}
        >
          <MobileContent
            activeTab={activeTab}
            worktreeId={worktreeId}
            worktree={worktree}
            messages={state.messages}
            cliToolId={activeCliTab}
            instanceId={activeInstanceId}
            onFilePathClick={handleFilePathClick}
            onFileSelect={handleFileSelect}
            onWorktreeUpdate={setWorktree}
            onNewFile={handleNewFile}
            onNewDirectory={handleNewDirectory}
            onRename={handleRename}
            onDelete={handleDelete}
            onUpload={handleUpload}
            onMove={handleMove}
            onFileTreeReset={resetFileTreeView}
            refreshTrigger={fileTreeRefresh}
            fileSearch={fileSearch}
            showToast={showToast}
            // Issue #874 (折衷案): the Agent tab manages the shared instance
            // ROSTER (entity + alias → DB, consistent with PC via
            // handleAgentInstancesChange) PLUS a per-device "show as tabs"
            // selection that only writes localStorage (toggleInstanceVisible),
            // preserving the #837/#851 intent that narrowing tabs on mobile must
            // not shrink the PC view. `selectedAgents` is still passed for the
            // TimerPane; mobile selection itself is now instance-driven so the
            // legacy change callback is a no-op.
            selectedAgents={mobileSelectedAgents}
            onSelectedAgentsChange={NOOP_SELECTED_AGENTS_CHANGE}
            useInstanceManagement
            instances={agentInstances}
            onInstancesChange={handleAgentInstancesChange}
            visibleInstanceIds={visibleInstanceIds}
            onToggleInstanceVisible={toggleInstanceVisible}
            vibeLocalModel={vibeLocalModel}
            onVibeLocalModelChange={handleVibeLocalModelChange}
            vibeLocalContextWindow={vibeLocalContextWindow}
            onVibeLocalContextWindowChange={handleVibeLocalContextWindowChange}
            disableAutoFollow={disableAutoFollow}
            historySubTab={historySubTab}
            onHistorySubTabChange={setHistorySubTab}
            onDiffSelect={handleDiffSelect}
            onInsertToMessage={handleInsertToMessage}
            showArchived={showArchived}
            onShowArchivedChange={handleShowArchivedChange}
            historyDisplayLimit={historyDisplayLimit}
            onHistoryDisplayLimitChange={handleHistoryDisplayLimitChange}
            historyUserOnly={historyUserOnly}
            onHistoryUserOnlyChange={handleHistoryUserOnlyChange}
          />
        </main>

        {/* Message Input — Issue #1166: in-flow bottom bar (`flex-shrink-0`).
            The viewport-height shell keeps this docked above the software
            keyboard, so it no longer needs `position: fixed` + a translateY lift. */}
        <div className="flex-shrink-0 border-t border-border bg-surface z-30">
          {/* Issue #473: Navigation buttons for OpenCode TUI selection list (mobile) */}
          {isSelectionListActive && (
            <div className="px-2 pt-1 border-b border-border">
              <NavigationButtons
                worktreeId={worktreeId}
                cliToolId={activeCliTab}
                instanceId={activeInstanceId}
                onKeysSent={fetchCurrentOutput}
                showPagerKeys={isPagerActive}
              />
            </div>
          )}
          <div className="p-2">
            <MessageInput
              worktreeId={worktreeId}
              onMessageSent={handleMessageSent}
              cliToolId={activeCliTab}
              instanceId={activeInstanceId}
              isSessionRunning={activeSessionRunning}
              pendingInsertText={pendingInsertText}
              onInsertConsumed={handleInsertConsumedSingle}
              // Issue #1080: Auto-Yes now lives in the composer meta row (moved off
              // the sticky tab row). The active agent tab already names the tool, so
              // the parenthetical tool name is suppressed here (showToolName=false).
              autoYesSlot={
                <AutoYesToggle
                  enabled={autoYesEnabled}
                  expiresAt={autoYesExpiresAt}
                  onToggle={handleAutoYesToggle}
                  lastAutoResponse={lastAutoResponse}
                  cliToolName={activeCliTab}
                  inline
                  showToolName={false}
                />
              }
            />
          </div>
        </div>

        {/* Issue #1166: `inFlow` renders the tab bar as the bottom flex child
            (static) so it tracks the viewport-height shell above the keyboard. */}
        <MobileTabBar
          activeTab={activeTab}
          onTabChange={handleMobileTabChange}
          hasNewOutput={hasNewOutput}
          hasPrompt={state.prompt.visible}
          hasUpdate={hasUpdate}
          inFlow
        />

        {!autoYesEnabled && (
          <MobilePromptSheet
            promptData={state.prompt.data}
            visible={state.prompt.visible}
            answering={state.prompt.answering}
            onRespond={handlePromptRespond}
            onDismiss={handlePromptDismiss}
            cliToolName={getCliToolDisplayName(activeCliTab)}
          />
        )}

        {/* Issue #1080: terminal secondary actions (search + End) bottom sheet.
            Issue #1171: End defers to openActiveKillConfirm, which snapshots the
            active instance as the kill target and opens the confirm dialog. */}
        <MobileTerminalActionsSheet
          open={showActionsSheet}
          onClose={() => setShowActionsSheet(false)}
          onSearch={() => window.dispatchEvent(new CustomEvent('terminal-search-open'))}
          onEnd={openActiveKillConfirm}
          endDisabled={!activeSessionRunning}
        />

        {/* File Viewer Modal (Mobile only) */}
        <FileViewer
          isOpen={mobileFileViewerPath !== null}
          onClose={handleMobileFileViewerClose}
          worktreeId={worktreeId}
          filePath={mobileFileViewerPath ?? ''}
          onEditMarkdown={setEditorFilePath}
        />
        {/* Markdown Editor Modal (Mobile) - Issue #104: disableClose when editor is maximized */}
        {editorFilePath && (
          <Modal
            isOpen={true}
            onClose={handleEditorClose}
            title={editorFilePath.split('/').pop() || 'Editor'}
            size="full"
            disableClose={isEditorMaximized}
          >
            <div className="h-[80vh]">
              <MarkdownEditor
                worktreeId={worktreeId}
                filePath={editorFilePath}
                onClose={handleEditorClose}
                onSave={handleEditorSave}
                onMaximizedChange={setIsEditorMaximized}
                initialViewMode="split"
              />
            </div>
          </Modal>
        )}
        {/* Hidden file input for upload (Mobile) */}
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOADABLE_EXTENSIONS.join(',')}
          onChange={handleFileInputChange}
          className="hidden"
          aria-label="Upload file"
        />
        {/* Kill session confirmation dialog (Mobile) — Issue #1171: same
            target-snapshot model as PC (killTarget drives open-state + title;
            Confirm disabled while the POST is in flight). */}
        <Modal
          isOpen={killTarget !== null}
          onClose={handleKillCancel}
          title={tWorktree('session.confirmEnd', { tool: killDialogLabel })}
          size="sm"
          showCloseButton={true}
        >
          <div className="space-y-4">
            <p className="text-sm text-foreground">
              {tWorktree('session.endWarning')}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleKillCancel}
                className="px-4 py-2 text-sm font-medium rounded-md bg-muted hover:bg-muted/80 text-foreground"
              >
                {tCommon('cancel')}
              </button>
              <button
                type="button"
                onClick={handleKillConfirm}
                disabled={isKillPending}
                className="px-4 py-2 text-sm font-medium rounded-md bg-danger hover:bg-danger/90 text-white disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {tCommon('end')}
              </button>
            </div>
          </div>
        </Modal>
        {/* [Issue #162] Move Dialog (Mobile) */}
        {moveTarget && (
          <MoveDialog
            isOpen={isMoveDialogOpen}
            onClose={handleMoveCancel}
            onConfirm={handleMoveConfirm}
            worktreeId={worktreeId}
            sourcePath={moveTarget.path}
            sourceType={moveTarget.type}
          />
        )}
        {/* [Issue #646] New file dialog (Mobile) */}
        <NewFileDialog
          isOpen={showNewFileDialog}
          parentPath={newFileParentPath}
          onConfirm={handleNewFileConfirm}
          onCancel={handleNewFileCancel}
        />
        {/* Toast notifications (Mobile) */}
        <ToastContainer toasts={toasts} onClose={removeToast} />
      </div>
    </ErrorBoundary>
  );
});

export default WorktreeDetailRefactored;

