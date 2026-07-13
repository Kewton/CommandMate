/**
 * TerminalSplitPaneContent (Issue #728, R3-005)
 *
 * Smart wrapper around `TerminalSplitPane`. Owns per-(worktreeId, cliToolId)
 * polling via `useTerminalPanePolling` and renders the full footer:
 *   - AutoYesToggle (Issue #740; per-split, keyed by this split's cliToolId so
 *     each CLI toggles auto-yes independently)
 *   - NavigationButtons (when CLI is in selection-list state, e.g. OpenCode)
 *   - PromptPanel (when /current-output reports isPromptWaiting)
 *   - MessageInput (always; carries draft persistence per splitIndex)
 *
 * This is the consumer that translates polled split state into UI on PC.
 * Mobile renders its own footer near the bottom of the screen and (since
 * Issue #736) drives the terminal display through the same
 * `useTerminalPanePolling` hook via `MobileTerminalTab`.
 *
 * Design note (per R3-005 / Issue #736):
 *   Neither PC nor mobile read a terminal reducer slice anymore — the slice
 *   was removed in #736 and both layouts now source terminal output from
 *   `useTerminalPanePolling`.
 */

'use client';

import React, { memo, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { MessageInput } from '@/components/worktree/MessageInput';
import { HistoryPane, splitHistorySlotId } from '@/components/worktree/HistoryPane';
import { PaneResizer } from '@/components/worktree/PaneResizer';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';
import {
  useTerminalPanePolling,
  type PanePromptState,
} from '@/hooks/useTerminalPanePolling';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import { useHistoryPaneState } from '@/hooks/useHistoryPaneState';
import { buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import type {
  TerminalSplitPaneCoreProps,
  SplitAutoYesProps,
  HistoryPaneProps,
} from '@/types/terminal-split-pane';

/**
 * Issue #756: props are grouped into domain types. `TerminalSplitPaneContent`
 * keeps the split identity/status (via `TerminalSplitPaneCoreProps`) plus a few
 * direct wiring props, and nests Auto-Yes (`autoYes`) and the embedded
 * HistoryPane (`history`) under their own domain objects. This drops the direct
 * prop count to 13 (<= 15) with no behavior change.
 */
export interface TerminalSplitPaneContentProps extends TerminalSplitPaneCoreProps {
  /** Issue #869: instances selectable for this split (excludes other-split instances; includes own). */
  availableInstances: AgentInstance[];
  /** Issue #869: called when the instance selector picks a different instance. */
  onInstanceChange: (instanceId: string) => void;
  onFocus: () => void;
  /** Set to true to suppress polling (e.g. component is currently hidden). */
  disabled?: boolean;
  /** Pending insert text targeted at this split (per-split Map lookup). */
  pendingInsertText?: string | null;
  /** Called by MessageInput when it consumes the pendingInsertText. */
  onInsertConsumed?: () => void;
  /**
   * Called after a message is successfully sent so the parent can also
   * refresh the (active-instance-scoped) message history.
   */
  onMessageSent?: (cliToolId: CLIToolType) => void;
  /** AutoYes domain group (Issue #756). 'onToggle' required; rest optional. */
  autoYes: SplitAutoYesProps;
  /** History domain group (Issue #756). Optional; pre-#744 callers omit it. */
  history?: HistoryPaneProps;
  /**
   * Issue #786 / #869: drag-drop. Threaded straight through to
   * `TerminalSplitPane`. Optional (backward compat / D-4) — drag-drop is inert
   * when omitted. The hover ring state stays inside `TerminalSplitPane`
   * (child-local) so this pass-through does not introduce a new re-render
   * source here (D-3). The payload is now an agent `instanceId`.
   */
  onDropInstance?: (instanceId: string) => void;
  /** Issue #786 / #869 (D-2): published instanceId being dragged, for the dragOver ring. */
  draggedInstanceId?: string | null;
}

export const TerminalSplitPaneContent = memo(function TerminalSplitPaneContent({
  worktreeId,
  splitIndex,
  cliToolId,
  instanceId,
  instance,
  availableInstances,
  onInstanceChange,
  onFocus,
  disabled = false,
  pendingInsertText,
  onInsertConsumed,
  onMessageSent,
  cliStatus = 'idle',
  autoYes,
  history,
  onDropInstance,
  draggedInstanceId,
}: TerminalSplitPaneContentProps) {
  // Issue #869: resolve the instance id this split targets. Defaults to the
  // primary instance (`=== cliToolId`) so pre-#869 single-instance behavior —
  // and every primary-instance request — stays byte-for-byte identical.
  const resolvedInstanceId = instanceId ?? cliToolId;
  // Issue #756: re-derive the legacy local names from the new domain groups so
  // the entire component body below stays byte-for-byte unchanged (all
  // useMemo/useCallback deps and JSX identical). Defaults match the previous
  // per-prop defaults.
  const autoYesEnabled = autoYes.enabled ?? false;
  const autoYesExpiresAt = autoYes.expiresAt ?? null;
  const lastAutoResponse = autoYes.lastAutoResponse ?? null;
  const onAutoYesToggle = autoYes.onToggle;
  const showArchived = history?.showArchived ?? false;
  const onShowArchivedChange = history?.onShowArchivedChange;
  const historyDisplayLimit = history?.historyDisplayLimit;
  const onHistoryDisplayLimitChange = history?.onHistoryDisplayLimitChange;
  const historyUserOnly = history?.historyUserOnly ?? false;
  const onHistoryUserOnlyChange = history?.onHistoryUserOnlyChange;
  const onHistoryInsertToMessage = history?.onInsertToMessage;
  const onFilePathClick = history?.onFilePathClick;
  const showToast = history?.showToast;

  const t = useTranslations('worktree');

  const {
    terminal,
    prompt,
    setAutoScroll,
    setPromptAnswering,
    clearPrompt,
    refresh,
  } = useTerminalPanePolling({
    worktreeId,
    cliToolId,
    instanceId: resolvedInstanceId,
    enabled: !disabled,
  });

  // Issue #744: this split's OWN message history, fetched independently by its
  // cliToolId. `state.messages` in the parent is server-filtered to the active
  // CLI tab, so it cannot represent split A=Claude and split B=Codex at once.
  const {
    messages: splitMessages,
    isLoading: splitMessagesLoading,
    refresh: refreshSplitMessages,
  } = useSplitMessages({
    worktreeId,
    cliToolId,
    instanceId: resolvedInstanceId,
    limit: historyDisplayLimit,
    includeArchived: showArchived,
    enabled: !disabled,
  });

  // Issue #744: History visible/width. MVP keeps this common across splits
  // (single useHistoryPaneState instance per pane, all reading the same
  // localStorage-backed state). Width is applied relative to THIS split's inner
  // area, not the whole desktop.
  const { visible: historyVisible, width: historyWidth, toggle: toggleHistory, setWidth: setHistoryWidth } =
    useHistoryPaneState();
  const historyContainerRef = React.useRef<HTMLDivElement>(null);

  const handleHistoryResize = useCallback(
    (deltaPx: number) => {
      const container = historyContainerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const percentDelta = (deltaPx / w) * 100;
      setHistoryWidth(historyWidth + percentDelta);
    },
    [historyWidth, setHistoryWidth],
  );

  // OpenCode / Copilot render TUIs in alternate screen mode; auto-following
  // would hide the menus at the top of the screen.
  const disableAutoFollow = cliToolId === 'opencode' || cliToolId === 'copilot';

  const handleAutoScrollChange = useCallback(
    (enabled: boolean) => setAutoScroll(enabled),
    [setAutoScroll],
  );

  const handleMessageSent = useCallback(
    (sentCli: CLIToolType) => {
      void refresh();
      // Issue #744 / S1-006: refresh THIS split's history immediately rather
      // than relying on the parent's activeCliTab-scoped refresh.
      void refreshSplitMessages();
      onMessageSent?.(sentCli);
    },
    [refresh, refreshSplitMessages, onMessageSent],
  );

  const handlePromptRespond = useCallback(
    async (answer: string): Promise<void> => {
      setPromptAnswering(true);
      try {
        const requestBody = buildPromptResponseBody(answer, cliToolId, prompt.data, resolvedInstanceId);
        const response = await fetch(
          `/api/worktrees/${worktreeId}/prompt-response`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          },
        );
        if (!response.ok) {
          throw new Error(`Failed to send prompt response: ${response.status}`);
        }
        clearPrompt();
        await refresh();
      } catch (err) {
        console.error('[TerminalSplitPaneContent] prompt response error:', err);
      } finally {
        setPromptAnswering(false);
      }
    },
    [worktreeId, cliToolId, resolvedInstanceId, prompt.data, setPromptAnswering, clearPrompt, refresh],
  );

  const handlePromptDismiss = useCallback(() => {
    clearPrompt();
  }, [clearPrompt]);

  const showNav = terminal.isSelectionListActive;
  const showPrompt = prompt.visible && !autoYesEnabled;

  // Issue #1017 (C-lite): detection-independent Esc/q safety net. Shown only when
  // the session is interactive but detection could not classify the frame
  // (isUnclassifiedActive) — the "stuck in an unrecognized TUI mode" case — and no
  // selection list / prompt panel is already driving it. Stays hidden during normal
  // generation ('thinking_indicator') and at an idle input prompt ('ready'), so it
  // is neither noisy nor able to insert a stray 'q' at the composer.
  const showEscapeHatch =
    terminal.isUnclassifiedActive &&
    !showNav &&
    !showPrompt;

  // Issue #744: the embedded HistoryPane for THIS split. Receives this split's
  // own messages (useSplitMessages) and the per-split highlight namespace via
  // `splitIndex`. Insert routing targets this split (S3-005). No client-side
  // cliToolId filter — messages are pre-filtered by the fetch (S1-008).
  const historyPaneSlot = useMemo(
    () => (
      <HistoryPane
        messages={splitMessages}
        worktreeId={worktreeId}
        onFilePathClick={onFilePathClick ?? (() => {})}
        isLoading={splitMessagesLoading}
        className="h-full"
        showToast={showToast}
        onInsertToMessage={onHistoryInsertToMessage}
        showArchived={showArchived}
        onShowArchivedChange={onShowArchivedChange}
        historyDisplayLimit={historyDisplayLimit}
        onHistoryDisplayLimitChange={onHistoryDisplayLimitChange}
        historyUserOnly={historyUserOnly}
        onHistoryUserOnlyChange={onHistoryUserOnlyChange}
        onCollapse={toggleHistory}
        splitIndex={splitIndex}
        cliToolId={cliToolId}
      />
    ),
    [
      splitMessages,
      worktreeId,
      onFilePathClick,
      splitMessagesLoading,
      showToast,
      onHistoryInsertToMessage,
      showArchived,
      onShowArchivedChange,
      historyDisplayLimit,
      onHistoryDisplayLimitChange,
      historyUserOnly,
      onHistoryUserOnlyChange,
      toggleHistory,
      splitIndex,
      cliToolId,
    ],
  );

  const terminalDisplaySlot = useMemo(
    () => (
      <TerminalDisplay
        output={terminal.output}
        isActive={terminal.isRunning}
        attaching={terminal.attaching}
        isThinking={terminal.isThinking}
        autoScroll={terminal.autoScroll}
        onScrollChange={handleAutoScrollChange}
        disableAutoFollow={disableAutoFollow}
      />
    ),
    [
      terminal.output,
      terminal.isRunning,
      terminal.attaching,
      terminal.isThinking,
      terminal.autoScroll,
      handleAutoScrollChange,
      disableAutoFollow,
    ],
  );

  // Issue #744: compose [HistoryPane | PaneResizer | TerminalDisplay]. When the
  // history is collapsed, a compact expand bar replaces it.
  const terminalSlot = useMemo(
    () => (
      <div ref={historyContainerRef} className="flex h-full min-h-0 w-full">
        {historyVisible ? (
          <>
            <div
              // Issue #744: real DOM id so the embedded HistoryPane collapse
              // button's per-split `aria-controls` resolves to this region
              // (the PC-wide HISTORY_PANE_ID is not rendered inside splits).
              id={splitHistorySlotId(splitIndex)}
              data-testid={`split-history-slot-${splitIndex}`}
              aria-label="History pane"
              style={{ width: `${historyWidth}%` }}
              className="flex-shrink-0 overflow-hidden min-h-0"
            >
              {historyPaneSlot}
            </div>
            <PaneResizer
              onResize={handleHistoryResize}
              orientation="horizontal"
              ariaValueNow={historyWidth}
            />
          </>
        ) : (
          <div
            data-testid={`split-history-expand-bar-${splitIndex}`}
            className="flex-shrink-0 flex items-start justify-center w-9 bg-gray-50 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700"
          >
            <button
              type="button"
              data-testid={`split-history-expand-${splitIndex}`}
              aria-label={t('terminal.showHistory')}
              title={t('terminal.showHistory')}
              aria-expanded="false"
              onClick={toggleHistory}
              className="flex flex-col items-center gap-2 w-full pt-2 text-gray-500 dark:text-gray-400 hover:text-accent-600 dark:hover:text-accent-400 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <svg
                className="w-4 h-4 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
              <span
                className="text-xs font-medium tracking-wide select-none"
                style={{ writingMode: 'vertical-rl' }}
                aria-hidden="true"
              >
                {t('terminal.historyLabel')}
              </span>
            </button>
          </div>
        )}
        <div className="flex-grow overflow-hidden min-w-0 min-h-0 relative">
          {terminalDisplaySlot}
        </div>
      </div>
    ),
    [
      historyVisible,
      historyWidth,
      historyPaneSlot,
      handleHistoryResize,
      toggleHistory,
      terminalDisplaySlot,
      splitIndex,
      t,
    ],
  );

  const footerSlot = useMemo(
    () => (
      <div className="space-y-2">
        {/* Issue #740: per-split Auto-Yes toggle, keyed by this split's CLI. */}
        <AutoYesToggle
          enabled={autoYesEnabled}
          expiresAt={autoYesExpiresAt ?? null}
          onToggle={onAutoYesToggle}
          lastAutoResponse={lastAutoResponse ?? null}
          cliToolName={cliToolId}
          inline
        />
        {showNav ? (
          <NavigationButtons
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={resolvedInstanceId}
            onKeysSent={refresh}
            showPagerKeys={terminal.isPagerActive}
          />
        ) : null}
        {showEscapeHatch ? (
          <TerminalEscapeHatch
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={resolvedInstanceId}
            onKeysSent={refresh}
          />
        ) : null}
        {showPrompt ? (
          <PromptPanel
            promptData={prompt.data}
            messageId={prompt.messageId}
            visible={prompt.visible}
            answering={prompt.answering}
            onRespond={handlePromptRespond}
            onDismiss={handlePromptDismiss}
            cliToolName={getCliToolDisplayName(cliToolId)}
          />
        ) : null}
        <MessageInput
          worktreeId={worktreeId}
          onMessageSent={handleMessageSent}
          cliToolId={cliToolId}
          instanceId={resolvedInstanceId}
          isSessionRunning={terminal.isRunning}
          pendingInsertText={pendingInsertText ?? null}
          onInsertConsumed={onInsertConsumed}
          splitIndex={splitIndex}
          onFocus={onFocus}
          // Issue #806: surface a "queued (session busy)" toast when sending to
          // a session that is still processing the previous task. isProcessing
          // is sourced from this split's own poller (terminal.isRunning), and
          // showToast reuses the existing history toast surface.
          isProcessing={terminal.isRunning}
          showToast={showToast}
        />
      </div>
    ),
    [
      showNav,
      showPrompt,
      showEscapeHatch,
      terminal.isPagerActive,
      worktreeId,
      cliToolId,
      resolvedInstanceId,
      refresh,
      prompt.data,
      prompt.messageId,
      prompt.visible,
      prompt.answering,
      handlePromptRespond,
      handlePromptDismiss,
      handleMessageSent,
      terminal.isRunning,
      pendingInsertText,
      onInsertConsumed,
      splitIndex,
      onFocus,
      autoYesEnabled,
      autoYesExpiresAt,
      lastAutoResponse,
      onAutoYesToggle,
      // Issue #806: toast surface for the "queued (session busy)" hint.
      showToast,
    ],
  );

  return (
    <TerminalSplitPane
      worktreeId={worktreeId}
      splitIndex={splitIndex}
      cliToolId={cliToolId}
      instanceId={resolvedInstanceId}
      instance={instance}
      availableInstances={availableInstances}
      onInstanceChange={onInstanceChange}
      // Issue #1079: the derived agent status now renders as a StatusDot inside
      // the selector trigger (session title bar). BranchStatus ⊂ StatusDotStatus.
      status={cliStatus}
      onFocus={onFocus}
      attaching={terminal.attaching}
      terminal={terminalSlot}
      footer={footerSlot}
      // Issue #786 / #869: drag-drop pass-through (optional; inert when omitted).
      onDropInstance={onDropInstance}
      draggedInstanceId={draggedInstanceId}
    />
  );
});

export default TerminalSplitPaneContent;

// Re-export for tests that want to inspect the polled-state shape.
export type { PanePromptState };
