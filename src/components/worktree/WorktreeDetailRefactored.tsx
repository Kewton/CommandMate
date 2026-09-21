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

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { MoreHorizontal } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { MobileHeader } from '@/components/mobile/MobileHeader';
import { StatusDot } from '@/components/ui/StatusDot';
import { MobileTabBar } from '@/components/mobile/MobileTabBar';
import { MobilePromptSheet } from '@/components/mobile/MobilePromptSheet';
import {
  MobileTerminalActionsSheet,
  type DirectInputUnavailableReason,
} from '@/components/mobile/MobileTerminalActionsSheet';
import { MobileDirectInputKeyboard } from '@/components/mobile/MobileDirectInputKeyboard';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { MessageInput } from '@/components/worktree/MessageInput';
import type { ShowToast } from '@/types/markdown-editor';
import type { LivePromptData } from '@/types/models';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { Button } from '@/components/ui/Button';
import { FileViewer } from '@/components/worktree/FileViewer';


/**
 * Loading fallback for the dynamically imported MarkdownEditor.
 *
 * Issue #1277: extracted into a real component so it can call `useTranslations`
 * — next/dynamic renders `loading` as a component, and the main orchestrator's
 * `tWorktree` (from useWorktreeDetailController) is not in scope at module level.
 */
function MarkdownEditorLoading() {
  const tWorktree = useTranslations('worktree');
  return (
    <div className="flex items-center justify-center h-full bg-surface text-muted-foreground">
      <Spinner size="lg" className="mr-2" />
      <span>{tWorktree('detail.loadingEditor')}</span>
    </div>
  );
}

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
    loading: () => <MarkdownEditorLoading />,
  }
);
import {
  LoadingIndicator,
  ErrorDisplay,
  isWorktreeStatusUnclassified,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { MobileContent } from '@/components/worktree/WorktreeDetailMobile';
import { WorktreeDetailDesktop } from '@/components/worktree/WorktreeDetailDesktop';
import { UPLOADABLE_EXTENSIONS } from '@/config/uploadable-extensions';
import { Modal } from '@/components/ui/Modal';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';
import { AgentModeControl } from '@/components/worktree/AgentModeControl';
import { BranchMismatchAlert } from '@/components/worktree/BranchMismatchAlert';
import { getCliToolDisplayName, getInstanceLabel, getActiveInstanceLabel, type CLIToolType } from '@/lib/cli-tools/types';
import { deriveCliStatus, isUnclassifiedCliStatus } from '@/types/sidebar';
import {
  UNCLASSIFIED_STATUS_DOT_CLASS,
  UNCLASSIFIED_STATUS_LABEL_KEY,
  resolveUnclassifiedDot,
} from '@/components/sidebar/BranchStatusIndicator';
import { MoveDialog } from '@/components/worktree/MoveDialog';
import { NewFileDialog } from '@/components/worktree/NewFileDialog';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import { useVirtualKeyboard } from '@/hooks/useVirtualKeyboard';
import {
  WorktreeChatSendProvider,
  useChatOptimisticSend,
} from '@/contexts/WorktreeChatSendContext';
import {
  ChatFileLinkProvider,
  type ChatFileLinkScope,
} from '@/lib/chat/chat-file-link-scope';
import type { MobileTab } from '@/components/mobile/MobileTabBar';
import { VerificationStatusChip } from '@/components/worktree/VerificationStatusChip';
import type { SubTabRequest } from '@/components/worktree/NotesAndLogsPane';
import { DEFAULT_SURFACE_MODE, type SurfaceMode } from '@/types/ui-state';

// ============================================================================
// Types
// ============================================================================

/** Props for WorktreeDetailRefactored component */
export interface WorktreeDetailRefactoredProps {
  /** Worktree ID to display */
  worktreeId: string;
}

/**
 * Issue #2498: "this screen is stale and we are still trying".
 *
 * Deliberately an overlay (`fixed`, out of normal flow) rather than a strip
 * inserted into the layout: the PC and mobile shells below both size their
 * children against a full-height flex column, and a banner that consumed a row
 * would shift the terminal every time a phone dipped out of signal. Floating it
 * keeps the fix to what it claims to be — the screen underneath, composer draft
 * included, does not move at all.
 */
const ReconnectingBanner = memo(function ReconnectingBanner({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="worktree-detail-reconnecting-banner"
      className="fixed top-2 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-warning-border bg-warning-subtle px-3 py-1 text-xs text-warning-foreground shadow-sm"
    >
      <Spinner size="xs" />
      <span>{label}</span>
    </div>
  );
});

/**
 * Issue #2498: the expired-session screen.
 *
 * Not `ErrorDisplay`: an expired session is not a failure to retry into, and
 * the message it used to carry was the SyntaxError from parsing the /login HTML
 * ("Unexpected token <"). The one action that resolves it is logging in again,
 * so that is the only action offered.
 */
const SessionExpiredNotice = memo(function SessionExpiredNotice({
  message,
  loginLabel,
  onLogin,
}: {
  message: string;
  loginLabel: string;
  onLogin: () => void;
}) {
  return (
    <div
      className="flex h-full min-h-[200px] items-center justify-center"
      role="alert"
      aria-live="assertive"
      data-testid="worktree-detail-session-expired"
    >
      <div className="max-w-md rounded-lg border border-border bg-surface p-6 text-center">
        <p className="font-medium text-foreground">{message}</p>
        <Button
          variant="primary"
          type="button"
          onClick={onLogin}
          className="mt-4"
          data-testid="worktree-detail-relogin"
        >
          {loginLabel}
        </Button>
      </div>
    </div>
  );
});

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

/**
 * The phone's docked composer (Issue #2213).
 *
 * Its own component for one reason: `useChatOptimisticSend` has to be called
 * *inside* `WorktreeChatSendProvider`, and the provider is rendered by the
 * screen component below. Everything else is the same `MessageInput` the mobile
 * shell has always docked here.
 *
 * The hook returns `undefined` whenever no chat surface is showing this agent's
 * transcript — the terminal surface, another mobile tab, a just-switched
 * instance — and `MessageInput` reads a missing `onOptimisticSend` as "await the
 * API, then clear", which is exactly the pre-#2213 behavior. So the optimistic
 * bubble appears when, and only when, there is a transcript on screen to put it
 * in.
 */
const MobileComposer = memo(function MobileComposer({
  worktreeId,
  cliToolId,
  instanceId,
  onMessageSent,
  isSessionRunning,
  isProcessing,
  showToast,
  pendingInsertText,
  onInsertConsumed,
  autoYesSlot,
  agentModeSlot,
}: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  onMessageSent?: (cliToolId: CLIToolType) => void;
  isSessionRunning?: boolean;
  /**
   * Issue #2406: "the agent is generating", the gate on the queued-send toast
   * (#806). A different question from `isSessionRunning` above, which asks
   * whether a tmux session exists and drives the send button's enabled state.
   */
  isProcessing?: boolean;
  /** Issue #2406: toast surface for the queued-send hint. */
  showToast?: ShowToast;
  pendingInsertText?: string | null;
  onInsertConsumed?: () => void;
  autoYesSlot?: React.ReactNode;
  /** Issue #2592: the permission-mode control, in the composer's action row. */
  agentModeSlot?: React.ReactNode;
}) {
  const optimisticSend = useChatOptimisticSend({ cliToolId, instanceId });
  return (
    <MessageInput
      worktreeId={worktreeId}
      onMessageSent={onMessageSent}
      cliToolId={cliToolId}
      instanceId={instanceId}
      isSessionRunning={isSessionRunning}
      isProcessing={isProcessing}
      showToast={showToast}
      pendingInsertText={pendingInsertText}
      onInsertConsumed={onInsertConsumed}
      onOptimisticSend={optimisticSend}
      autoYesSlot={autoYesSlot}
      agentModeSlot={agentModeSlot}
    />
  );
});

// ============================================================================
// Main Component
// ============================================================================

/**
 * Is this a CHECKBOX question? (Issue #2755)
 *
 * The same predicate `TerminalSplitPaneContent` applies to its own Auto-Yes
 * gate, restated here for the phone sheet. It is the one prompt shape Auto-Yes
 * never answers — `resolveBaseAnswer` returns null, because a digit ticks a box
 * and the confirm is a separate row — so hiding its sheet under Auto-Yes left a
 * live question answerable by nobody.
 */
function isMultiSelectPrompt(promptData: LivePromptData | null | undefined): boolean {
  return promptData?.type === 'multiple_choice' && promptData.multiSelect === true;
}

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
    handleActivityOpen,
    handleActivityToggle,
    handleAgentInstancesChange,
    handleAutoYesToggle,
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
    handleReLogin,
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
    isAuthExpired,
    isEditorMaximized,
    isInfoModalOpen,
    isMobile,
    isMoveDialogOpen,
    isReconnecting,
    isSelectionListActive,
    isPagerActive,
    offersPlanApprove,
    // Issue #2592: the composer's permission-mode control reads these. The
    // phone's composer is docked outside `MobileTerminalTab` — which owns the
    // pane hook the PC split reads the same facts from — so they come off this
    // controller's own poll instead.
    isDismissablePanelActive,
    isUnclassifiedActive,
    sessionStatus,
    agentMode,
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
    rosterReady,
    instanceSelectionRequest,
    acknowledgeInstanceSelection,
    setActiveInstanceId,
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
    toggleInstanceVisible,
    verification,
    vibeLocalContextWindow,
    vibeLocalModel,
    visibleInstanceIds,
    worktree,
    worktreeName,
    worktreeStatus,
  } = useWorktreeDetailController({ worktreeId });

  // Issue #2498: the re-login button's label. The screen's other namespaces
  // arrive from the controller; `auth` is only needed for this one string.
  const tAuth = useTranslations('auth');

  // Issue #1080: mobile terminal secondary actions (search + End) moved off the
  // sticky control row into a bottom sheet, opened from a "more actions" trigger.
  const [showActionsSheet, setShowActionsSheet] = useState(false);

  // Issue #1816: the mobile header chip opens the Tools tab on its Verification
  // sub-tab. Held here rather than inside NotesAndLogsPane because the mobile
  // shell unmounts that pane whenever another tab is active, so the request has
  // to survive the tab switch that the chip itself causes.
  const [toolsSubTabRequest, setToolsSubTabRequest] = useState<SubTabRequest | null>(null);

  // Issue #2254: which output surface the mobile terminal tab is showing.
  //
  // The docked `NavigationButtons` below sit above the composer, OUTSIDE
  // `MobileContent`, so they cannot see the per-worktree mode `MobileTerminalTab`
  // owns. Since #2254 the chat surface draws its own pad inside the dialog card,
  // directly under the frame it acts on, and two pads for one selection list is
  // worse than either — so the tab reports its mode up (on mount and on every
  // change) and the docked copy stands down while chat is showing.
  //
  // Defaults to `terminal`, which is what a screen whose tab has not mounted (or
  // has not reported yet) should assume: it reproduces the pre-#2254 behaviour
  // rather than hiding a control nothing has replaced.
  const [mobileSurfaceMode, setMobileSurfaceMode] = useState<SurfaceMode>(DEFAULT_SURFACE_MODE);

  /** The terminal tab is open AND it is showing chat. See the docked pad below. */
  const isMobileChatSurface = activeTab === 'terminal' && mobileSurfaceMode === 'chat';

  /** Leaving the Tools tab drops the request so a later visit opens on Notes. */
  const handleMobileTabSelect = useCallback(
    (tab: MobileTab) => {
      if (tab !== 'memo') setToolsSubTabRequest(null);
      handleMobileTabChange(tab);
    },
    [handleMobileTabChange]
  );

  const handleOpenVerificationMobile = useCallback(() => {
    setToolsSubTabRequest((prev) => ({ tab: 'verification', token: (prev?.token ?? 0) + 1 }));
    handleMobileTabChange('memo');
  }, [handleMobileTabChange]);

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
      handleMobileTabSelect(MOBILE_TAB_ORDER[nextIndex]);
    },
    [activeTab, handleMobileTabSelect]
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

  // Issue #2345: the screen's file-link scope, published to every chat surface
  // and History pane below — on BOTH layouts, because the same reply is read
  // through both. It carries two things the transcript cannot derive:
  //
  //  - `worktreePath`, without which an absolute path a reply names cannot be
  //    recognized as living inside this worktree, and is requested as
  //    `files//Users/…` — a URL Next 308s into a relative read that 404s;
  //  - `openFile`, which on the phone had no owner at all: the transcript lives
  //    inside `MobileTerminalTab` while the viewer is this component's
  //    `mobileFileViewerPath`, and the tab was passing `() => {}`.
  //
  // Declared here rather than threaded down because the components in between
  // (`TerminalSplitPaneContent`, `MobileContent`) each build their children's
  // props as one frozen object — the same ownership shape `WorktreeChatSendProvider`
  // above exists for.
  const chatFileLinkScope: ChatFileLinkScope = useMemo(
    () => ({ worktreePath: worktree?.path, openFile: handleFilePathClick }),
    [worktree?.path, handleFilePathClick],
  );

  // Issue #960: derive the active session's running state per-instance優先
  // （PC版と整合）so the End button and MessageInput reflect the selected
  // instance rather than the per-CLI aggregate. Falls back to the per-CLI map
  // for backward compat (single-instance / legacy configs).
  const activeSessionRunning =
    (worktree?.sessionStatusByInstance?.[activeInstanceId] ?? worktree?.sessionStatusByCli?.[activeCliTab])
      ?.isRunning ?? false;

  // --------------------------------------------------------------------------
  // Issue #2799: the phone's direct-input keyboard
  // --------------------------------------------------------------------------
  // The last way out of a frame the detector cannot read, so it is gated on
  // WHERE the user is, never on a detection flag (a prompt may well be up):
  // the Terminal tab, the terminal surface (chat does not draw the frame the
  // keys are aimed at), and a running session (the route 404s without one).
  // The first reason that applies is the one the actions sheet shows.
  const [directInputOpen, setDirectInputOpen] = useState(false);
  const directInputUnavailableReason: DirectInputUnavailableReason | null =
    activeTab !== 'terminal'
      ? 'tab'
      : mobileSurfaceMode === 'chat'
        ? 'chat'
        : !activeSessionRunning
          ? 'session'
          : null;
  /**
   * The keyboard is on screen. Gated on the same conditions as the sheet row,
   * so the render never shows it against a target or surface it was not opened
   * for, even in the one render before the effects below close the mode.
   */
  const showDirectInputKeyboard = directInputOpen && directInputUnavailableReason === null;

  // Close — and so discard the staged keys, which live in the keyboard — when
  // the target changes. The instance tabs stay visible while the keyboard is
  // open, and staged keys carried across a switch would reach another agent.
  // Same rule as PC's `DirectInputBar` (#2766, `TerminalSplitPaneContent`).
  useEffect(() => {
    setDirectInputOpen(false);
  }, [worktreeId, activeCliTab, activeInstanceId]);

  // Close when the session goes away. Its own effect, not the one above: in one
  // effect keyed on both, a session coming BACK would close the mode too.
  useEffect(() => {
    if (!activeSessionRunning) setDirectInputOpen(false);
  }, [activeSessionRunning]);

  // Close on leaving the Terminal tab, and on the chat surface. The latter is
  // defensive — the surface pill is locked while the keyboard is open — but
  // the surface is also restored from localStorage.
  useEffect(() => {
    if (activeTab !== 'terminal' || mobileSurfaceMode === 'chat') setDirectInputOpen(false);
  }, [activeTab, mobileSurfaceMode]);

  const openDirectInput = useCallback(() => setDirectInputOpen(true), []);
  const closeDirectInput = useCallback(() => setDirectInputOpen(false), []);

  // Render
  // ========================================================================

  // Handle loading state
  if (loading) {
    return <LoadingIndicator />;
  }

  // Issue #2498: an expired session is a re-login, not an error. It used to
  // reach ErrorDisplay carrying the HTML parse failure, which told the user
  // nothing they could act on.
  if (isAuthExpired) {
    return (
      <SessionExpiredNotice
        message={tWorktree('editor.sessionExpired')}
        loginLabel={tAuth('login.submitButton')}
        onLogin={handleReLogin}
      />
    );
  }

  // Handle error state.
  //
  // Issue #2498: `error` is now raised only by a FIRST load that produced
  // nothing — there is no screen to keep, so the full-screen card plus Retry is
  // still the right answer. A poll that fails once a worktree is on screen no
  // longer lands here; it raises `isReconnecting` and the screen stays put.
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

  // Issue #2406: the generating verdict for the same instance, kept beside
  // `activeSessionRunning` because the composer needs BOTH and they answer
  // different questions. `isProcessing` on this payload is
  // `sessionStatusToActivityFlags(status, unclassified).isProcessing` — true for
  // `status === 'running'` (`lib/session/status-mapping.ts`), which is the same
  // verdict PC's split reads off its own poller as `sessionStatus === 'running'`,
  // except when no rule could read the frame (Issue #2775): that `running` is
  // the detector's floor, and it no longer raises the "queued behind a busy
  // agent" toast here — nor, since Issue #2810, on PC's split.
  const activeSessionProcessing =
    (worktree?.sessionStatusByInstance?.[activeInstanceId] ?? worktree?.sessionStatusByCli?.[activeCliTab])
      ?.isProcessing ?? false;

  // Render desktop layout
  if (!isMobile) {
    return (
      // [#2345] The file-link scope wraps the PC layout too: its split builds
      // one frozen prop object for both the chat surface and the History
      // column, so neither can be handed `worktreePath` from here directly.
      <ChatFileLinkProvider value={chatFileLinkScope}>
        {/* Issue #2498: overlay, so a poll failing mid-session never reflows
            the split below it. */}
        {isReconnecting && <ReconnectingBanner label={tCommon('connection.reconnecting')} />}
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
          instanceSelectionRequest={instanceSelectionRequest}
          onInstanceSelectionHandled={acknowledgeInstanceSelection}
          hasUpdate={hasUpdate}
          lastAutoResponse={lastAutoResponse}
          activeActivity={activeActivity}
          onActivityToggle={handleActivityToggle}
          onActivityOpen={handleActivityOpen}
          verification={verification}
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
            title={editorFilePath.split('/').pop() || tWorktree('fileViewer.editor')}
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
      </ChatFileLinkProvider>
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
      {/* Issue #2213: the screen-scoped seam between the chat surface inside the
          terminal tab and the composer docked below it. The surface registers its
          `usePendingMessages` send here; `MobileComposer` reads it. Scoped to this
          screen deliberately — Epic #2192 ruled out a global send bus, and PC
          never renders this provider at all (its split owns both halves and wires
          `onOptimisticSend` directly). `onInsertToComposer` gives a discarded
          failed send the same draft-restore PC has. */}
      <WorktreeChatSendProvider onInsertToComposer={handleInsertToMessage}>
        {/* [#2345] `MobileContent` builds the terminal tab's props, so the tab's
            file-path routing (and the worktree root the transcript normalizes
            against) arrives over this scope instead. */}
        <ChatFileLinkProvider value={chatFileLinkScope}>
          {/* Issue #2498: see the PC branch — the phone is the case this was
              written for, and the shell below is height-critical. */}
          {isReconnecting && <ReconnectingBanner label={tCommon('connection.reconnecting')} />}
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
                // Issue #2810: the PC header's "cannot tell" question, asked of
                // the entry `worktreeStatus` was derived from (`activeCliTab`).
                statusUnclassified={isWorktreeStatusUnclassified(
                  worktreeStatus,
                  worktree?.sessionStatusByCli,
                  activeCliTab
                )}
                gitStatus={worktree?.gitStatus}
                onMenuClick={openMobileDrawer}
              />
            </div>

            {/* Issue #1816: task contract / verification verdict. Renders nothing
                when the branch has no task row, so this strip only appears for
                worktrees that were actually delegated with a contract.
                Issue #2824: stands aside while the direct-input keyboard is open,
                with the branch-mismatch alert below — the only two bands above
                <main> that come and go. With them a 360x640 screen left the
                terminal 85px under the open keyboard (#2799 §8 wants 120px);
                without them it is 132px whatever the worktree's state. Both come
                back on 閉じる. */}
            {verification.task && !showDirectInputKeyboard && (
              <div className="flex-shrink-0 border-b border-border bg-surface px-3 py-1.5">
                <VerificationStatusChip
                  task={verification.task}
                  latestRun={verification.latestRun}
                  latestRunGates={
                    verification.selectedRun !== null &&
                    verification.selectedRun.id === verification.latestRun?.id
                      ? verification.selectedRun.gates
                      : null
                  }
                  onOpen={handleOpenVerificationMobile}
                  className="w-full justify-start"
                />
              </div>
            )}

            {/* Issue #111: Branch mismatch warning (Mobile). Issue #2824: hidden
                while the direct-input keyboard is open (see the strip above). */}
            {worktree?.gitStatus && worktree.gitStatus.isBranchMismatch && !showDirectInputKeyboard && (
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
                aria-label={tWorktree('detail.agentInstanceSelection')}
              >
                {displayedInstances.map((inst) => {
                  const toolEntry =
                    worktree?.sessionStatusByInstance?.[inst.id] ?? worktree?.sessionStatusByCli?.[inst.cliTool];
                  const toolStatus = deriveCliStatus(toolEntry);
                  // Issue #2775: a `ready` nothing actually read is drawn and
                  // worded as "cannot tell", the same ring the PC header uses.
                  const toolUnclassified = resolveUnclassifiedDot(
                    toolStatus,
                    isUnclassifiedCliStatus(toolEntry)
                  );
                  // Issue #1277: the status wording comes from the generic
                  // `common.status.*` keys (#1273) — one source of truth, shared
                  // with SIDEBAR_STATUS_CONFIG's labelKey (#1304).
                  const statusLabel = tCommon(
                    toolUnclassified ? UNCLASSIFIED_STATUS_LABEL_KEY : `status.${toolStatus}`
                  );
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
                      <StatusDot
                        status={toolStatus}
                        size="sm"
                        label={tWorktree('detail.statusPill', {
                          label: getInstanceLabel(inst),
                          status: statusLabel,
                        })}
                        className={toolUnclassified ? UNCLASSIFIED_STATUS_DOT_CLASS : undefined}
                        data-unclassified={toolUnclassified ? 'true' : undefined}
                      />
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
                verification={verification}
                toolsSubTabRequest={toolsSubTabRequest}
                onSurfaceModeChange={setMobileSurfaceMode}
                directInputOpen={showDirectInputKeyboard}
              />
            </main>

            {/* Message Input — Issue #1166: in-flow bottom bar (`flex-shrink-0`).
                The viewport-height shell keeps this docked above the software
                keyboard, so it no longer needs `position: fixed` + a translateY lift. */}
            <div className="flex-shrink-0 border-t border-border bg-surface z-30">
              {/* Issue #473: Navigation buttons for OpenCode TUI selection list (mobile).
                  Issue #2254: not while the terminal tab is showing the CHAT
                  surface — that surface draws its own pad inside the dialog card,
                  directly under the frame, and this docked copy would be a second
                  one twelve rows away from the list it drives. Both terms are
                  required: `activeTab` because the mode only describes the
                  terminal tab (History / Files / Tools keep the docked pad), and
                  `mobileSurfaceMode` because that is which half of it is on. */}
              {/* Issue #2799: the direct-input keyboard, docked HERE rather than
                  in the terminal tab. `<main>` above scrolls (the keyboard would
                  scroll with it) and carries the #1128 tab swipe, whose 32px edge
                  bands overlap ESC / TAB / PGUP / PGDN at 360px — a sideways
                  mis-tap would switch tabs and, by the rule above, throw the
                  staged keys away. Pointer capture does not stop the swipe: it
                  reads touch events. While it is open it stands in for the
                  navigation pad (unmounted — it holds no state) and the
                  composer (hidden, NOT unmounted: see below). */}
              {showDirectInputKeyboard ? (
                <MobileDirectInputKeyboard
                  // Keyed on the target, so staged keys can never outlive it —
                  // not even for the one render before the close effect runs.
                  key={`${worktreeId}:${activeCliTab}:${activeInstanceId}`}
                  worktreeId={worktreeId}
                  cliToolId={activeCliTab}
                  instanceId={activeInstanceId}
                  onKeysSent={fetchCurrentOutput}
                  onClose={closeDirectInput}
                />
              ) : null}
              {isSelectionListActive && !isMobileChatSurface && !showDirectInputKeyboard && (
                <div className="px-2 pt-1 border-b border-border">
                  <NavigationButtons
                    worktreeId={worktreeId}
                    cliToolId={activeCliTab}
                    instanceId={activeInstanceId}
                    onKeysSent={fetchCurrentOutput}
                    showPagerKeys={isPagerActive}
                    // Issue #2809: no `Enter` on a plan review (see ChatSurface, #2793).
                    hideEnterKey={offersPlanApprove}
                  />
                </div>
              )}
              {/* Issue #2799: hidden with `display:none` while the keyboard is
                  open — never unmounted. `MessageInput` saves its draft 500ms
                  after the last keystroke and drops the pending save on unmount,
                  so unmounting it would lose what was typed just before. Not
                  `opacity-0` / `h-0` either: those keep it in the tab order (so
                  `aria-hidden` would be a real ARIA violation) and take height.
                  Nothing re-measures the textarea while it is hidden: its height
                  effect runs on a value change, and a hidden textarea gets none. */}
              <div
                className={showDirectInputKeyboard ? 'p-2 hidden' : 'p-2'}
                aria-hidden={showDirectInputKeyboard ? true : undefined}
                data-testid="mobile-composer-wrapper"
              >
                {/* Issue #2213: `MobileComposer` is `MessageInput` plus the one line
                    that reads the screen's registered optimistic send. It has to be a
                    child component because that read is a hook and the provider is
                    rendered by THIS component. */}
                <MobileComposer
                  worktreeId={worktreeId}
                  onMessageSent={handleMessageSent}
                  cliToolId={activeCliTab}
                  instanceId={activeInstanceId}
                  isSessionRunning={activeSessionRunning}
                  // Issue #2406: the phone never passed `isProcessing` at all, so
                  // the queued-send toast (#806) could not fire here even while
                  // the agent was mid-turn. Wired to the generating verdict — the
                  // same source PC now reads — rather than to `isRunning`.
                  isProcessing={activeSessionProcessing}
                  showToast={showToast}
                  pendingInsertText={pendingInsertText}
                  onInsertConsumed={handleInsertConsumedSingle}
                  // Issue #2592: the permission-mode button + chip, in the row
                  // the composer already draws (slash / attach / interrupt).
                  // Deliberately NOT a strip of its own next to the quick keys:
                  // this screen's vertical budget is spent (#2106 keeps
                  // `TerminalDisplay` above 250px at 360x640, and #2131 measured
                  // the strip against it), and a control in an existing row
                  // costs the terminal nothing.
                  agentModeSlot={
                    <AgentModeControl
                      worktreeId={worktreeId}
                      cliToolId={activeCliTab}
                      instanceId={activeInstanceId}
                      agentMode={agentMode}
                      sessionStatus={sessionStatus}
                      isPromptWaiting={state.prompt.visible}
                      isSelectionListActive={isSelectionListActive}
                      isDismissablePanelActive={isDismissablePanelActive}
                      isUnclassifiedActive={isUnclassifiedActive}
                      onKeysSent={fetchCurrentOutput}
                    />
                  }
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
              onTabChange={handleMobileTabSelect}
              hasNewOutput={hasNewOutput}
              hasPrompt={state.prompt.visible}
              hasUpdate={hasUpdate}
              inFlow
            />

            {/* Issue #2755: a checkbox question is shown whatever Auto-Yes is
                doing — it is the one prompt Auto-Yes is measured never to
                answer, so hiding it left the screen answerable by nobody.
                Issue #2799: EXCEPT while the direct-input keyboard is open. The
                sheet is a full-screen overlay with a focus trap; drawn over the
                keyboard it would block the one way out that does not depend on
                detection, on the strength of a detection. This deliberately
                narrows #2755 for the duration of the mode — not a regression to
                "fix": the tab bar's prompt badge (`hasPrompt`) stays up, and
                `閉じる` brings the sheet straight back. */}
            {!showDirectInputKeyboard && (!autoYesEnabled || isMultiSelectPrompt(state.prompt.data)) && (
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
              onDirectInput={openDirectInput}
              directInputUnavailableReason={directInputUnavailableReason}
            />

            {/* Issue #1519: single mobile file screen — markdown viewing and editing
                now live inside FileViewer, so there is no separate editor modal. */}
            <FileViewer
              isOpen={mobileFileViewerPath !== null}
              onClose={handleMobileFileViewerClose}
              worktreeId={worktreeId}
              filePath={mobileFileViewerPath ?? ''}
              onFileSaved={handleEditorSave}
              onOpenFile={handleFilePathClick}
            />
            {/* Hidden file input for upload (Mobile) */}
            <input
              ref={fileInputRef}
              type="file"
              accept={UPLOADABLE_EXTENSIONS.join(',')}
              onChange={handleFileInputChange}
              className="hidden"
              aria-label={tWorktree('detail.uploadFile')}
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
          </div>
        </ChatFileLinkProvider>
      </WorktreeChatSendProvider>
    </ErrorBoundary>
  );
});

export default WorktreeDetailRefactored;

