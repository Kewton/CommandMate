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

import React, { memo } from 'react';
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import { MobileHeader } from '@/components/mobile/MobileHeader';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { MobileTabBar } from '@/components/mobile/MobileTabBar';
import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
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
      <div className="flex items-center justify-center h-full bg-white dark:bg-gray-900 text-gray-400 dark:text-gray-500">
        <Loader2 className="animate-spin h-6 w-6 mr-2" />
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
import { CLI_TOOL_IDS, getCliToolDisplayName } from '@/lib/cli-tools/types';
import { MOBILE_MAX_AGENTS } from '@/hooks/useMobileSelectedAgents';
import { deriveCliStatus } from '@/types/sidebar';
import { MoveDialog } from '@/components/worktree/MoveDialog';
import { NewFileDialog } from '@/components/worktree/NewFileDialog';

// ============================================================================
// Types
// ============================================================================

/** Props for WorktreeDetailRefactored component */
export interface WorktreeDetailRefactoredProps {
  /** Worktree ID to display */
  worktreeId: string;
}

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
    displayedAgents,
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
    handleKillSession,
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
    setActiveCliTab,
    setActiveInstanceId,
    setEditorFilePath,
    setFocusedSplitIndex,
    setHistorySubTab,
    setIsEditorMaximized,
    setMobileSelectedAgents,
    setWorktree,
    showArchived,
    showKillConfirm,
    showNewFileDialog,
    showToast,
    state,
    tCommon,
    tWorktree,
    tabsActions,
    tabsState,
    toasts,
    vibeLocalContextWindow,
    vibeLocalModel,
    worktree,
    worktreeName,
    worktreeStatus,
  } = useWorktreeDetailController({ worktreeId });

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
          onKillSession={handleKillSession}
          showKillConfirm={showKillConfirm}
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
          killDialogTitle={tWorktree('session.confirmEnd', { tool: getCliToolDisplayName(activeCliTab) })}
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
  return (
    <ErrorBoundary componentName="WorktreeDetailRefactored">
      <div className="h-full flex flex-col">
        <MobileHeader
          worktreeName={worktreeName}
          repositoryName={worktree?.repositoryName}
          status={worktreeStatus}
          gitStatus={worktree?.gitStatus}
          onBackClick={handleBackClick}
          onMenuClick={openMobileDrawer}
        />

        {/* Issue #111: Branch mismatch warning (Mobile) */}
        {worktree?.gitStatus && worktree.gitStatus.isBranchMismatch && (
          <div className="z-35">
            <BranchMismatchAlert
              isBranchMismatch={worktree.gitStatus.isBranchMismatch}
              currentBranch={worktree.gitStatus.currentBranch}
              initialBranch={worktree.gitStatus.initialBranch}
            />
          </div>
        )}

        {/* Auto Yes + CLI Tool Tabs combined row (Mobile) */}
        <div className="sticky top-0 z-30 flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          {/* Left: Auto Yes toggle (inline mode) */}
          <AutoYesToggle
            enabled={autoYesEnabled}
            expiresAt={autoYesExpiresAt}
            onToggle={handleAutoYesToggle}
            lastAutoResponse={lastAutoResponse}
            cliToolName={activeCliTab}
            inline
          />
          {/* Right: CLI tool tabs + End button */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <nav className="flex gap-2" aria-label="CLI Tool Selection">
              {displayedAgents.map((tool) => {
                const toolStatus = deriveCliStatus(worktree?.sessionStatusByCli?.[tool]);
                const statusConfig = SIDEBAR_STATUS_CONFIG[toolStatus];
                return (
                  <button
                    key={tool}
                    onClick={() => setActiveCliTab(tool)}
                    className={`px-1.5 py-0.5 rounded font-medium text-xs transition-colors flex items-center gap-1 ${
                      activeCliTab === tool
                        ? 'bg-blue-100 text-blue-700'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                    aria-current={activeCliTab === tool ? 'page' : undefined}
                  >
                    {statusConfig.type === 'spinner' ? (
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`}
                        title={statusConfig.label}
                      />
                    ) : (
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.className}`}
                        title={statusConfig.label}
                      />
                    )}
                    {getCliToolDisplayName(tool)}
                  </button>
                );
              })}
            </nav>
            {/* [Issue #47] Terminal search button (Mobile) */}
            <button
              onClick={() => {
                window.dispatchEvent(new CustomEvent('terminal-search-open'));
              }}
              className="flex items-center px-1.5 py-0.5 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
              aria-label="ターミナル内を検索"
              data-testid="terminal-search-button-mobile"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <button
              onClick={handleKillSession}
              disabled={!worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-medium rounded transition-colors ${
                worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning
                  ? 'text-red-600 hover:bg-red-50'
                  : 'invisible'
              }`}
              aria-label={`End ${activeCliTab} session`}
            >
              <span aria-hidden="true">&#x2715;</span>
              End
            </button>
          </div>
        </div>

        <main
          className="flex-1 overflow-y-auto"
          style={{
            paddingBottom: 'calc(12rem + env(safe-area-inset-bottom, 0px))',
          }}
        >
          <MobileContent
            activeTab={activeTab}
            worktreeId={worktreeId}
            worktree={worktree}
            messages={state.messages}
            cliToolId={activeCliTab}
            onFilePathClick={handleFilePathClick}
            onFileSelect={handleFileSelect}
            onWorktreeUpdate={setWorktree}
            onNewFile={handleNewFile}
            onNewDirectory={handleNewDirectory}
            onRename={handleRename}
            onDelete={handleDelete}
            onUpload={handleUpload}
            onMove={handleMove}
            refreshTrigger={fileTreeRefresh}
            fileSearch={fileSearch}
            showToast={showToast}
            // Issue #837/#851: the Agent tab edits the mobile-only localStorage
            // preference and never the DB. `availableAgents` is the full agent
            // pool so mobile can pick any of the CLI tools independently of the
            // PC, up to MOBILE_MAX_AGENTS.
            selectedAgents={mobileSelectedAgents}
            onSelectedAgentsChange={setMobileSelectedAgents}
            availableAgents={CLI_TOOL_IDS}
            maxAgents={MOBILE_MAX_AGENTS}
            persistToServer={false}
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

        {/* Message Input - fixed above tab bar */}
        <div
          className="fixed left-0 right-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 z-30"
          style={{ bottom: 'calc(4rem + env(safe-area-inset-bottom, 0px))' }}
        >
          {/* Issue #473: Navigation buttons for OpenCode TUI selection list (mobile) */}
          {isSelectionListActive && (
            <div className="px-2 pt-1 border-b border-gray-200 dark:border-gray-700">
              <NavigationButtons
                worktreeId={worktreeId}
                cliToolId={activeCliTab}
                onKeysSent={fetchCurrentOutput}
              />
            </div>
          )}
          <div className="p-2">
            <MessageInput
              worktreeId={worktreeId}
              onMessageSent={handleMessageSent}
              cliToolId={activeCliTab}
              isSessionRunning={worktree?.sessionStatusByCli?.[activeCliTab]?.isRunning ?? false}
              pendingInsertText={pendingInsertText}
              onInsertConsumed={handleInsertConsumedSingle}
            />
          </div>
        </div>

        <MobileTabBar
          activeTab={activeTab}
          onTabChange={handleMobileTabChange}
          hasNewOutput={false}
          hasPrompt={state.prompt.visible}
          hasUpdate={hasUpdate}
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
        {/* Kill session confirmation dialog (Mobile) */}
        <Modal
          isOpen={showKillConfirm}
          onClose={handleKillCancel}
          title={tWorktree('session.confirmEnd', { tool: getCliToolDisplayName(activeCliTab) })}
          size="sm"
          showCloseButton={true}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              {tWorktree('session.endWarning')}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleKillCancel}
                className="px-4 py-2 text-sm font-medium rounded-md bg-gray-200 hover:bg-gray-300 text-gray-700"
              >
                {tCommon('cancel')}
              </button>
              <button
                type="button"
                onClick={handleKillConfirm}
                className="px-4 py-2 text-sm font-medium rounded-md bg-red-600 hover:bg-red-700 text-white"
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

