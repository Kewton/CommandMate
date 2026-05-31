/**
 * TerminalSplitPaneContent (Issue #728, R3-005)
 *
 * Smart wrapper around `TerminalSplitPane`. Owns per-(worktreeId, cliToolId)
 * polling via `useTerminalPanePolling` and renders the full footer:
 *   - NavigationButtons (when CLI is in selection-list state, e.g. OpenCode)
 *   - PromptPanel (when /current-output reports isPromptWaiting)
 *   - MessageInput (always; carries draft persistence per splitIndex)
 *
 * This is the only consumer that translates polled split state into UI on PC.
 * Mobile keeps reading the shared `state.terminal.*` reducer slice and renders
 * its own footer near the bottom of the screen.
 *
 * Design note (per R3-005):
 *   The PC `WorktreeDetailRefactored` no longer reads `state.terminal.*` for
 *   any split. The reducer slice survives only because mobile still depends
 *   on it; deleting it is out of scope for #728 and tracked as a follow-up.
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
  useTerminalPanePolling,
  type PanePromptState,
} from '@/hooks/useTerminalPanePolling';
import { buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';

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
   * Whether auto-yes is currently enabled for THIS CLI. When true, the
   * PromptPanel is hidden because the auto-yes manager will respond instead.
   * Auto-yes itself is still globally keyed by activeCliTab in the parent.
   */
  autoYesEnabled?: boolean;
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
      terminal={terminalSlot}
      footer={footerSlot}
    />
  );
});

export default TerminalSplitPaneContent;

// Re-export for tests that want to inspect the polled-state shape.
export type { PanePromptState };
