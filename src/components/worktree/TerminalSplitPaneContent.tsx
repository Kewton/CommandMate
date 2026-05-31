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
import type { CLIToolType } from '@/lib/cli-tools/types';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { MessageInput } from '@/components/worktree/MessageInput';
import {
  AutoYesToggle,
  type AutoYesToggleParams,
} from '@/components/worktree/AutoYesToggle';
import {
  useTerminalPanePolling,
  type PanePromptState,
} from '@/hooks/useTerminalPanePolling';
import { buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import type { BranchStatus } from '@/types/sidebar';

export interface TerminalSplitPaneContentProps {
  worktreeId: string;
  splitIndex: number;
  cliToolId: CLIToolType;
  availableCliTools: CLIToolType[];
  onCliToolChange: (id: CLIToolType) => void;
  onFocus: () => void;
  /** Set to true to suppress polling (e.g. component is currently hidden). */
  disabled?: boolean;
  /** Pending insert text targeted at this split (per-split Map lookup). */
  pendingInsertText?: string | null;
  /** Called by MessageInput when it consumes the pendingInsertText. */
  onInsertConsumed?: () => void;
  /**
   * Called after a message is successfully sent so the parent can also
   * refresh the (activeCliTab-scoped) message history.
   */
  onMessageSent?: (cliToolId: CLIToolType) => void;
  /**
   * Whether auto-yes is currently enabled for THIS CLI (Issue #740). When
   * true, the PromptPanel is hidden because the auto-yes manager will respond
   * instead. State is sourced from the parent's per-CLI `autoYesStateMap`, so
   * each split toggles auto-yes independently for its own cliToolId.
   */
  autoYesEnabled?: boolean;
  /**
   * Expiration timestamp (ms since epoch) for THIS CLI's auto-yes, used by the
   * footer AutoYesToggle countdown (Issue #740). Resolved per-CLI by the parent.
   */
  autoYesExpiresAt?: number | null;
  /**
   * Last auto-response answer for the AutoYesToggle notification (Issue #740).
   * Sourced from the parent's `useAutoYes` (activeCliTab-scoped); per-split
   * client-side auto-response is intentionally NOT introduced (Issue #501's
   * server poller owns auto-responses).
   */
  lastAutoResponse?: string | null;
  /**
   * Toggle handler bound to THIS split's cliToolId (Issue #740). The parent
   * supplies a per-CLI curried handler so toggling one split's auto-yes does
   * not affect the others.
   */
  onAutoYesToggle: (params: AutoYesToggleParams) => Promise<void>;
  /**
   * Derived AI agent status for THIS split's CLI (Issue #743). Resolved by the
   * parent from `worktree.sessionStatusByCli[cliToolId]` via `deriveCliStatus`
   * and rendered as a dot/spinner in the split header (headerExtras). Optional
   * so existing call sites/tests that never pass it keep working unchanged
   * (defaults to 'idle' = gray dot). Mirrors the Mobile canonical span at
   * WorktreeDetailRefactored.tsx:1947-1974.
   */
  cliStatus?: BranchStatus;
}

export const TerminalSplitPaneContent = memo(function TerminalSplitPaneContent({
  worktreeId,
  splitIndex,
  cliToolId,
  availableCliTools,
  onCliToolChange,
  onFocus,
  disabled = false,
  pendingInsertText,
  onInsertConsumed,
  onMessageSent,
  autoYesEnabled = false,
  autoYesExpiresAt = null,
  lastAutoResponse = null,
  onAutoYesToggle,
  cliStatus = 'idle',
}: TerminalSplitPaneContentProps) {
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
    enabled: !disabled,
  });

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
      onMessageSent?.(sentCli);
    },
    [refresh, onMessageSent],
  );

  const handlePromptRespond = useCallback(
    async (answer: string): Promise<void> => {
      setPromptAnswering(true);
      try {
        const requestBody = buildPromptResponseBody(answer, cliToolId, prompt.data);
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
    [worktreeId, cliToolId, prompt.data, setPromptAnswering, clearPrompt, refresh],
  );

  const handlePromptDismiss = useCallback(() => {
    clearPrompt();
  }, [clearPrompt]);

  const showNav = terminal.isSelectionListActive;
  const showPrompt = prompt.visible && !autoYesEnabled;

  // Issue #743: AI agent status indicator (dot/spinner) for the split header.
  // Uses the same inline span markup as the Mobile canonical implementation
  // (WorktreeDetailRefactored.tsx:1947-1974): title-only a11y (no aria-label,
  // to avoid duplicate readout / S3-006), spinner for running/generating.
  const statusConfig = SIDEBAR_STATUS_CONFIG[cliStatus];
  const statusIndicator = useMemo(
    () =>
      statusConfig.type === 'spinner' ? (
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${statusConfig.className}`}
          title={statusConfig.label}
          data-testid={`split-status-indicator-${splitIndex}`}
        />
      ) : (
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${statusConfig.className}`}
          title={statusConfig.label}
          data-testid={`split-status-indicator-${splitIndex}`}
        />
      ),
    [statusConfig.type, statusConfig.className, statusConfig.label, splitIndex],
  );

  const terminalSlot = useMemo(
    () => (
      <TerminalDisplay
        output={terminal.output}
        isActive={terminal.isRunning}
        isThinking={terminal.isThinking}
        autoScroll={terminal.autoScroll}
        onScrollChange={handleAutoScrollChange}
        disableAutoFollow={disableAutoFollow}
      />
    ),
    [
      terminal.output,
      terminal.isRunning,
      terminal.isThinking,
      terminal.autoScroll,
      handleAutoScrollChange,
      disableAutoFollow,
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
          isSessionRunning={terminal.isRunning}
          pendingInsertText={pendingInsertText ?? null}
          onInsertConsumed={onInsertConsumed}
          splitIndex={splitIndex}
          onFocus={onFocus}
        />
      </div>
    ),
    [
      showNav,
      showPrompt,
      worktreeId,
      cliToolId,
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
    ],
  );

  return (
    <TerminalSplitPane
      worktreeId={worktreeId}
      splitIndex={splitIndex}
      cliToolId={cliToolId}
      availableCliTools={availableCliTools}
      onCliToolChange={onCliToolChange}
      onFocus={onFocus}
      attaching={terminal.attaching}
      headerExtras={statusIndicator}
      terminal={terminalSlot}
      footer={footerSlot}
    />
  );
});

export default TerminalSplitPaneContent;

// Re-export for tests that want to inspect the polled-state shape.
export type { PanePromptState };
