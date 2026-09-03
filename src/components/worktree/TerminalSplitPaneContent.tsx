/**
 * TerminalSplitPaneContent (Issue #728, R3-005)
 *
 * Smart wrapper around `TerminalSplitPane`. Owns per-(worktreeId, cliToolId)
 * polling via `useTerminalPanePolling` and renders the full footer:
 *   - AutoYesToggle (Issue #740; per-split, keyed by this split's cliToolId so
 *     each CLI toggles auto-yes independently)
 *   - NavigationButtons (when CLI is in selection-list state, e.g. OpenCode)
 *   - OpencodeQuickKeys (opencode only, Issue #2046; collapsible since #2131)
 *   - PromptPanel (when /current-output reports isPromptWaiting)
 *   - MessageInput (always; carries draft persistence per splitIndex)
 *
 * Issue #2193: the pane's OUTPUT half is switchable. `surfaceMode === 'chat'`
 * puts the split's own `HistoryPane` where `TerminalDisplay` would be and drops
 * the collapsible History column (the same transcript, twice, is not a layout).
 * Everything below the output — nav / hatch / prompt / quick keys / composer /
 * Auto-Yes — is identical in both modes, which is why a send, a prompt answer
 * and an interrupt all keep working from the chat surface.
 *
 * Issue #2194: that chat body is now `ChatSurface` rather than a bare
 * `HistoryPane` — same transcript, plus the live region (generating row, the
 * "open the terminal" banner for frames chat cannot drive, the empty-state line)
 * and follow-the-tail. The #1121 pending bubble it shows on send is the existing
 * `usePendingMessages` merge below; nothing new sends from here.
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

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { isAnswerablePromptData } from '@/types/models';
import { TerminalSplitPane } from '@/components/worktree/TerminalSplitPane';
import {
  formatAgentModelLabel,
  formatAgentSessionTooltip,
  formatAgentSessionUsage,
} from '@/components/worktree/WorktreeDetailSubComponents';
import type { AgentSessionSnapshot } from '@/types/agent-session';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { getTerminalDisplayCompaction } from '@/config/terminal-display-compaction';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { OpencodeQuickKeys } from '@/components/worktree/OpencodeQuickKeys';
import { UnsentComposerBar, hasUnsentComposerText } from '@/components/worktree/UnsentComposerBar';
import {
  OpencodeSidebarNotice,
  hasOpenCodeSidebarObstruction,
} from '@/components/worktree/OpencodeSidebarNotice';
import { PromptPanel } from '@/components/worktree/PromptPanel';
import { MessageInput } from '@/components/worktree/MessageInput';
import { OpencodeTurnDiffPanel } from '@/components/worktree/OpencodeTurnDiffPanel';
import { HistoryPane, splitHistorySlotId } from '@/components/worktree/HistoryPane';
import { ChatSurface } from '@/components/worktree/ChatSurface';
import { PaneResizer } from '@/components/worktree/PaneResizer';
import { AutoYesToggle } from '@/components/worktree/AutoYesToggle';
import {
  useTerminalPanePolling,
  type PanePromptState,
} from '@/hooks/useTerminalPanePolling';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import { usePendingMessages, type OptimisticSendOptions } from '@/hooks/usePendingMessages';
import { useHistoryPaneState } from '@/hooks/useHistoryPaneState';
import { emitSurfaceModeChange } from '@/hooks/useSplitSurfaceModes';
import { worktreeApi } from '@/lib/api-client';
import { buildPromptResponseBody } from '@/lib/prompt-response-body-builder';
import { readPromptDecisionId } from '@/components/worktree/prompt-decision-id';
import { getCliToolDisplayName, getInstanceLabel } from '@/lib/cli-tools/types';
import type {
  TerminalSplitPaneCoreProps,
  SplitAutoYesProps,
  HistoryPaneProps,
  SessionKillTarget,
} from '@/types/terminal-split-pane';
import { DEFAULT_SURFACE_MODE, type SurfaceMode } from '@/types/ui-state';
import {
  getSplitSurfaceModeStorageKey,
  resolveSurfaceMode,
  writeSurfaceMode,
} from '@/config/surface-mode-config';

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
  /**
   * Issue #1171: request ending THIS split's session. The split builds its own
   * {@link SessionKillTarget} snapshot (its cliToolId / resolved instanceId /
   * alias-first label) and hands it up so the confirm dialog terminates exactly
   * the session this split shows — never the globally-active one. Optional; when
   * omitted the End (×) button is not rendered (backward compatible).
   */
  onRequestSessionEnd?: (target: SessionKillTarget) => void;
  /**
   * Issue #1783: this split's agent model, passed straight to
   * `TerminalSplitPane`. Declared here rather than in
   * `TerminalSplitPaneCoreProps` so the shared core type keeps its pre-#1783
   * shape; the parent resolves it from
   * `worktree.sessionStatusByInstance[instanceId].model`. Optional — omitting it
   * renders no model, which is the correct display for a tool that reports none.
   */
  agentModel?: string | null;
  /**
   * Issue #2042: published when this split's agent changes what it says about
   * its own session (persona / cost / context), so the surfaces above — the
   * desktop header's instance pills — can show it too.
   *
   * The pane's own `current-output` poll is the only path this data takes to the
   * browser, so a header pill for an instance with no open split has nothing to
   * show; that is why this is handed up rather than fetched again. Called only
   * when a rendered value actually changed (`useTerminalPanePolling` holds the
   * identity stable otherwise), so a parent may keep it in state without
   * re-rendering every split twice a second.
   */
  onAgentSessionChange?: (instanceId: string, snapshot: AgentSessionSnapshot) => void;
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
  onRequestSessionEnd,
  agentModel,
  onAgentSessionChange,
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
  const locale = useLocale();

  // Issue #2193: this split's output surface. Per split, not per worktree —
  // watching one agent's transcript while the other's TUI is on screen is the
  // whole point of a split.
  const surfaceStorageKey = useMemo(
    () => getSplitSurfaceModeStorageKey(worktreeId, splitIndex),
    [worktreeId, splitIndex],
  );
  // SSR-safe first render: the deterministic default, replaced by the effect
  // below once `?view=` / localStorage can actually be read (same shape as
  // `useActivityBarState`, so there is no hydration mismatch to chase).
  const [surfaceMode, setSurfaceModeState] = useState<SurfaceMode>(DEFAULT_SURFACE_MODE);
  useEffect(() => {
    setSurfaceModeState(resolveSurfaceMode(surfaceStorageKey));
  }, [surfaceStorageKey]);

  const handleSurfaceModeChange = useCallback(
    (mode: SurfaceMode) => {
      setSurfaceModeState(mode);
      writeSurfaceMode(surfaceStorageKey, mode);
      // Issue #2259: the Action bar disables its History toggle while EVERY
      // split shows chat (the chat surface has no History column). It reads the
      // modes out of the same storage, but a same-window write fires no
      // `storage` event, so the change is announced explicitly.
      emitSurfaceModeChange({ worktreeId, splitIndex, mode });
    },
    [surfaceStorageKey, worktreeId, splitIndex],
  );

  // Read by the keydown listener so the listener itself never has to be torn
  // down and rebuilt on a mode change.
  const surfaceModeRef = useRef(surfaceMode);
  surfaceModeRef.current = surfaceMode;

  // Issue #2193: Mod+Shift+M toggles the surface, registered in
  // `src/config/keyboard-shortcuts.ts` so the `?` overlay lists it.
  //
  // Every split listens, and the one that owns the focused element answers —
  // resolved from the DOM (`[data-split-index]`, on the pane root since #786)
  // rather than from a "which split is active" prop, because the composer and
  // the terminal both live inside the pane and either may hold focus.
  //
  // With focus outside every split, the FIRST split answers, but only when the
  // user is not typing somewhere else: `MarkdownEditor` binds a bare Ctrl+M
  // (Issue #1518) without checking Shift, so on Windows / Linux the same chord
  // reaches its textarea. That guard is what keeps the two from both firing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.shiftKey || event.altKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key.toLowerCase() !== 'm') return;

      const target = event.target instanceof Element ? event.target : null;
      const owner = target?.closest('[data-split-index]');
      if (owner) {
        if (Number(owner.getAttribute('data-split-index')) !== splitIndex) return;
      } else {
        if (splitIndex !== 0) return;
        if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      }

      event.preventDefault();
      handleSurfaceModeChange(surfaceModeRef.current === 'chat' ? 'terminal' : 'chat');
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [splitIndex, handleSurfaceModeChange]);

  const {
    terminal,
    prompt,
    agentSession,
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

  // Issue #1121: optimistic-UI layer. Merges a just-sent message into this
  // split's history as a pending bubble (< 100ms) before the send resolves, then
  // reconciles it against the server echo (no duplicate) or surfaces a
  // retry/discard error on failure. onSent refetches so reconciliation is prompt.
  const sendMessageFn = useCallback(
    (content: string, options: OptimisticSendOptions) =>
      worktreeApi.sendMessage(worktreeId, content, options),
    [worktreeId],
  );
  const {
    messages: mergedMessages,
    sendOptimistic,
    retry: retryPending,
    discard: discardPending,
  } = usePendingMessages({
    worktreeId,
    serverMessages: splitMessages,
    sendFn: sendMessageFn,
    onSent: refreshSplitMessages,
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

  // Issue #1172 / #2049: several TUIs pin a tall pane and pad the layout with
  // hundreds of blank rows; compact them for display only (raw output
  // untouched). The policy lives in one config module so this PC declaration and
  // the mobile one in `MobileTerminalTab` cannot drift apart.
  const { compactTuiLayoutPadding, preservePaintedPanelRows } = useMemo(
    () => getTerminalDisplayCompaction(cliToolId),
    [cliToolId],
  );

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

  // Issue #1121: discarding a failed optimistic message removes its bubble and
  // restores the text to the composer (via the existing insert-to-message
  // pathway) so the user can edit and re-send.
  const handleDiscardPending = useCallback(
    (tempId: string) => {
      const content = discardPending(tempId);
      if (content) {
        onHistoryInsertToMessage?.(content);
      }
    },
    [discardPending, onHistoryInsertToMessage],
  );

  const handlePromptRespond = useCallback(
    async (answer: string, decisionId?: string | null): Promise<void> => {
      setPromptAnswering(true);
      try {
        // Issue #1932: an approval the agent named by id goes to `/respond`,
        // which delivers the verdict over the agent's own API. It cannot go to
        // `/prompt-response`: that route re-captures the pane and refuses with
        // `prompt_no_longer_active` when nothing parses, which for the dialogs
        // that HAVE a decision id is every one of them — that refusal is the
        // whole reason this path exists.
        //
        // Issue #1738: `prompt.data` may be the degraded structured form (#1725),
        // and `promptType` on this body is a PromptType — a union the
        // unclassified sentinel is deliberately not a member of. Passing null
        // for it sends no promptType at all, which is the truthful answer to
        // "what kind of prompt is this?" when nobody could read the dialog.
        const requestBody = decisionId
          ? {
              decisionId,
              answer,
              cliTool: cliToolId,
              // Same rule as buildPromptResponseBody: the primary instance is
              // named by the tool id server-side, so sending it would be noise.
              ...(resolvedInstanceId && resolvedInstanceId !== cliToolId
                ? { instanceId: resolvedInstanceId }
                : {}),
            }
          : buildPromptResponseBody(
              answer,
              cliToolId,
              isAnswerablePromptData(prompt.data) ? prompt.data : null,
              resolvedInstanceId,
            );
        const response = await fetch(
          decisionId
            ? `/api/worktrees/${worktreeId}/respond`
            : `/api/worktrees/${worktreeId}/prompt-response`,
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
  // Issue #1932: the approval this pane's dialog addresses, when the payload
  // names one. Null for every scraper-read prompt and for every source that
  // publishes no per-decision id, which is what keeps those on the pane path.
  const promptDecisionId = readPromptDecisionId(prompt.data);

  // Issue #1017 / #1494: detection-independent navigation safety net (←/→/↑/↓/Enter/
  // Esc, plus Codex 'q'). Shown only when the session is interactive but detection
  // could not classify the frame (isUnclassifiedActive) — the "stuck in an
  // unrecognized TUI overlay" case such as Claude `/help`, where NavigationButtons is
  // not rendered — and no selection list / prompt panel is already driving it. Stays
  // hidden during normal generation ('thinking_indicator') and at an idle input prompt
  // ('ready'), so Enter/'q' can never reach the composer.
  const showEscapeHatch =
    terminal.isUnclassifiedActive &&
    !showNav &&
    !prompt.visible;

  // Issue #1879: the unsent-input bar. Its gate is the composer's CONTENTS and
  // nothing else — not isUnclassifiedActive, not isSelectionListActive, not
  // prompt.visible. Those three gates exist so a stray Enter cannot reach a live
  // input line; this bar shows the user the exact text before they aim an Enter
  // at it, which is a different act. Blank composer (including a frame where all
  // that is on screen is the CLI's dim placeholder — Claude's suggestion, or
  // codex's since #1890 — which `extractComposerText` has already dropped) means
  // no bar, so the "no Enter affordance when the box is empty" property holds.
  const showUnsentComposerBar = hasUnsentComposerText(terminal.composerText);

  // Issue #2095: opencode's sidebar sharing rows with the transcript. Its own
  // gate, on the frame's GEOMETRY and the tool, and deliberately not folded into
  // `showEscapeHatch` even though the same frame usually raises both: the hatch
  // offers arrow keys for an overlay nobody could parse, and this names a cause
  // and a keystroke the hatch cannot send. Judged on `realtimeSnippet` — the
  // same 100 rows the server judges `paneObstruction` on — so the notice and
  // `capture --json` cannot disagree about one frame.
  const showOpencodeSidebarNotice = hasOpenCodeSidebarObstruction(
    cliToolId,
    terminal.realtimeSnippet || terminal.output,
  );

  // Issue #744: the embedded HistoryPane for THIS split. Receives this split's
  // own messages (useSplitMessages) and the per-split highlight namespace via
  // `splitIndex`. Insert routing targets this split (S3-005). No client-side
  // cliToolId filter — messages are pre-filtered by the fetch (S1-008).
  // Issue #744 / #2193: ONE prop list, two possible mounts. The collapsible
  // History column and the chat output surface are the same pane over the same
  // messages; the only difference is the collapse affordance, which the chat
  // surface must not have — collapsing the OUTPUT would leave the split showing
  // nothing at all. Kept as a props object rather than two JSX copies so the
  // two can never be handed different messages or a different filter.
  const historyPaneProps = useMemo(
    () => ({
      messages: mergedMessages,
      worktreeId,
      onFilePathClick: onFilePathClick ?? (() => {}),
      isLoading: splitMessagesLoading,
      className: 'h-full',
      showToast,
      onInsertToMessage: onHistoryInsertToMessage,
      onRetryPending: retryPending,
      onDiscardPending: handleDiscardPending,
      showArchived,
      onShowArchivedChange,
      historyDisplayLimit,
      onHistoryDisplayLimitChange,
      historyUserOnly,
      onHistoryUserOnlyChange,
      splitIndex,
      cliToolId,
    }),
    [
      mergedMessages,
      retryPending,
      handleDiscardPending,
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
      splitIndex,
      cliToolId,
    ],
  );

  const historyPaneSlot = useMemo(
    () => <HistoryPane {...historyPaneProps} onCollapse={toggleHistory} />,
    [historyPaneProps, toggleHistory],
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
        compactTuiLayoutPadding={compactTuiLayoutPadding}
        preservePaintedPanelRows={preservePaintedPanelRows}
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
      compactTuiLayoutPadding,
      preservePaintedPanelRows,
    ],
  );

  // Issue #2193: the chat output surface. The split's own HistoryPane, full
  // width, with no collapse button and NO second copy of itself beside it.
  //
  // Theme-following on purpose: the terminal is a permanently dark island
  // because it mirrors a fixed xterm palette, and this surface is a transcript,
  // so it keeps HistoryPane's own token-driven light/dark behavior. No
  // light-on-dark is written here for that reason.
  //
  // Issue #2194: the pane is now wrapped by `ChatSurface`, which adds the live
  // region (generating row / "open the terminal" banner / empty-state line) and
  // the follow-the-tail chip. The transcript itself is still exactly the same
  // `historyPaneProps` the collapsible History column is handed — that object is
  // spread first inside ChatSurface and its identity fields re-applied after, so
  // the two mounts cannot be given different messages or a different filter.
  //
  // `isPromptWaiting` is fed from `prompt.visible`, not from a raw payload flag:
  // `useTerminalPanePolling` folds `isPromptWaiting && promptData` into
  // `prompt.visible` and exposes no separate flag (see ChatSurfaceLiveState). The
  // banner's "a wait nobody could read" case is therefore a visible prompt whose
  // payload is #1708's / #1725's degraded record, which ChatSurface narrows
  // itself with `isAnswerablePromptData`.
  const chatSurfaceSlot = useMemo(
    () => (
      <div
        data-testid={`split-chat-slot-${splitIndex}`}
        aria-label={t('surfaceMode.chatSurfaceLabel')}
        className="flex h-full min-h-0 w-full overflow-hidden bg-surface text-surface-foreground"
      >
        <div className="min-w-0 min-h-0 flex-1 overflow-hidden">
          <ChatSurface
            messages={historyPaneProps.messages}
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={resolvedInstanceId}
            history={historyPaneProps}
            live={{
              isRunning: terminal.isRunning,
              // Issue #2238: the generating verdict the surface actually gates
              // its in-flight bubble on. `isRunning` above stays because the
              // surface still reports on the session; it is no longer mistaken
              // for the turn.
              sessionStatus: terminal.sessionStatus,
              isThinking: terminal.isThinking,
              isPromptWaiting: prompt.visible,
              promptData: prompt.data,
              isSelectionListActive: terminal.isSelectionListActive,
              isPagerActive: terminal.isPagerActive,
              isUnclassifiedActive: terminal.isUnclassifiedActive,
            }}
            onSurfaceModeChange={handleSurfaceModeChange}
          />
        </div>
      </div>
    ),
    [
      historyPaneProps,
      splitIndex,
      t,
      worktreeId,
      cliToolId,
      resolvedInstanceId,
      terminal.isRunning,
      terminal.sessionStatus,
      terminal.isThinking,
      terminal.isSelectionListActive,
      terminal.isPagerActive,
      terminal.isUnclassifiedActive,
      prompt.visible,
      prompt.data,
      handleSurfaceModeChange,
    ],
  );

  // Issue #744: compose [HistoryPane | PaneResizer | TerminalDisplay]. When the
  // history is hidden, nothing replaces it and the terminal takes the whole
  // row: Issue #2259 removed the 36px expand strip, which cost 36px per split
  // (108px at 3 splits) to duplicate a toggle the Action bar already owns.
  const terminalSlot = useMemo(
    () => (
      <div
        ref={historyContainerRef}
        data-testid={`split-terminal-row-${splitIndex}`}
        className="flex h-full min-h-0 w-full"
      >
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
        ) : null}
        <div
          // Issue #2131: the measured half of the pair above. This is the box
          // `TerminalDisplay` fills, so its `getBoundingClientRect().height` IS
          // the "terminal height" the Issue's table reports.
          data-testid={`split-terminal-slot-${splitIndex}`}
          // Issue #2259: hiding the column leaves NOTHING beside the terminal —
          // the 36px `w-9` strip that used to sit here is gone, so the width is
          // written as an explicit 100% rather than left to `flex-grow` alone.
          style={historyVisible ? undefined : { width: '100%' }}
          className="flex-grow overflow-hidden min-w-0 min-h-0 relative"
        >
          {terminalDisplaySlot}
        </div>
      </div>
    ),
    [
      historyVisible,
      historyWidth,
      historyPaneSlot,
      handleHistoryResize,
      terminalDisplaySlot,
      splitIndex,
    ],
  );

  const footerSlot = useMemo(
    () => (
      // Issue #2131: `data-testid` so the PC height spec can measure what the
      // footer costs the terminal. The footer is the `flex-shrink-0` half of the
      // pane's flex column; whatever it grows by, TerminalDisplay loses.
      <div className="space-y-2" data-testid={`split-footer-${splitIndex}`}>
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
        {showUnsentComposerBar ? (
          <UnsentComposerBar
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={resolvedInstanceId}
            composerText={terminal.composerText}
            onActionSent={refresh}
          />
        ) : null}
        {showOpencodeSidebarNotice ? (
          <OpencodeSidebarNotice
            cliToolId={cliToolId}
            frame={terminal.realtimeSnippet || terminal.output}
          />
        ) : null}
        {showPrompt ? (
          <PromptPanel
            promptData={prompt.data}
            messageId={prompt.messageId}
            decisionId={promptDecisionId}
            visible={prompt.visible}
            answering={prompt.answering}
            onRespond={handlePromptRespond}
            onDismiss={handlePromptDismiss}
            cliToolName={getCliToolDisplayName(cliToolId)}
          />
        ) : null}
        {/* Issue #2046: opencode only. The chords opencode's TUI is driven by
            (`tab` agents, `ctrl+p` commands, and the `ctrl+x` leader) have no
            other way in, because this terminal is read-only. Rendered only while
            the pane is live, since the special-keys route 404s otherwise. The
            component itself decides which of its buttons a pane without an agent
            session may press -- see its docblock, and §22 of
            docs/design/opencode-server-live-verification.md for why `ctrl+x b`
            is not among them.
            Issue #2131: `collapsible`. This footer is `flex-shrink-0` and
            `TerminalDisplay` is the only `flex-1 min-h-0` sibling, so every pixel
            the strip takes comes out of the terminal and nothing else: 578px of
            strip across eleven wrapped rows left 64px of terminal in a 3-split
            pane, against 650px in the two splits of the SAME frame that had no
            strip. `layout="desktop"` is what keeps that fold independent of the
            phone's -- separate localStorage key, and OPEN by default here
            because a 1-split pane still keeps 456px of terminal with the strip
            showing. Measured in
            `tests/e2e/desktop-opencode-quick-keys-2131.spec.ts`. */}
        {terminal.isRunning ? (
          <OpencodeQuickKeys
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={resolvedInstanceId}
            hasAgentSession={agentSession.session !== null}
            onKeysSent={refresh}
            collapsible
            layout="desktop"
          />
        ) : null}
        {/* Issue #2043: opencode only, and only when opencode has named files.
            Renders nothing at all for every other tool -- see
            OpencodeTurnDiffPanel / hasAgentSessionDiff. Placed directly above
            the composer, beside OpencodeSessionControls, because both are
            opencode-only affordances that act on the conversation in this
            split. */}
        <OpencodeTurnDiffPanel
          worktreeId={worktreeId}
          cliToolId={cliToolId}
          instanceId={resolvedInstanceId}
          diff={agentSession.diff}
          disabled={!terminal.isRunning}
        />
        <MessageInput
          worktreeId={worktreeId}
          onMessageSent={handleMessageSent}
          // Issue #1121: delegate the send to the optimistic layer so a pending
          // bubble appears in this split's history immediately.
          onOptimisticSend={sendOptimistic}
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
          // Issue #1080: per-split Auto-Yes toggle now lives in the composer's
          // bottom meta row instead of its own full-width footer row.
          autoYesSlot={
            <AutoYesToggle
              enabled={autoYesEnabled}
              expiresAt={autoYesExpiresAt ?? null}
              onToggle={onAutoYesToggle}
              lastAutoResponse={lastAutoResponse ?? null}
              cliToolName={cliToolId}
              inline
            />
          }
        />
      </div>
    ),
    [
      showNav,
      showPrompt,
      showEscapeHatch,
      showUnsentComposerBar,
      // Issue #2095: the notice's gate, and the frame it re-reads to render.
      showOpencodeSidebarNotice,
      terminal.realtimeSnippet,
      terminal.output,
      // Issue #2046: the opencode quick-key strip's session gate.
      agentSession.session,
      terminal.composerText,
      terminal.isPagerActive,
      worktreeId,
      cliToolId,
      resolvedInstanceId,
      refresh,
      prompt.data,
      prompt.messageId,
      promptDecisionId,
      prompt.visible,
      prompt.answering,
      handlePromptRespond,
      handlePromptDismiss,
      handleMessageSent,
      sendOptimistic,
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
      // Issue #2043: the poll gives this a stable identity between turns (see
      // `agentSessionSignature`), so it re-runs the memo when the file list
      // actually changes and not on every 2s poll that repeats it.
      agentSession.diff,
    ],
  );

  // Issue #1171: alias-first display name for THIS split's session, snapshotted
  // into the kill target and shown in the End button tooltip / aria-label.
  const endTargetLabel = getInstanceLabel(instance ?? { cliTool: cliToolId });

  // Issue #1171: build this split's own kill-target snapshot and request the
  // confirm dialog. Uses THIS split's cliToolId / resolved instanceId, so a
  // non-focused split terminates exactly the session it displays.
  const handleRequestSessionEnd = useCallback(() => {
    onRequestSessionEnd?.({
      cliToolId,
      instanceId: resolvedInstanceId,
      label: endTargetLabel,
    });
  }, [onRequestSessionEnd, cliToolId, resolvedInstanceId, endTargetLabel]);

  // Issue #1171: the End (×) button, rendered as `headerExtras` (Dropdown-adjacent).
  // Shown ONLY when THIS split's own session is running (terminal.isRunning) —
  // independent of other splits or the DesktopHeader — and never during
  // attaching / stopped states. Memoized so a steady polling tick (isRunning
  // unchanged) does not recreate the element and re-render the memoized
  // TerminalSplitPane.
  const endSessionExtras = useMemo(() => {
    if (!onRequestSessionEnd || !terminal.isRunning) return null;
    const label = t('terminal.endSessionFor', { name: endTargetLabel });
    return (
      <button
        type="button"
        onClick={handleRequestSessionEnd}
        aria-label={label}
        title={label}
        data-testid={`terminal-end-session-button-${splitIndex}`}
        className="flex items-center justify-center p-0.5 rounded text-muted-foreground hover:text-danger focus:text-danger hover:bg-danger/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/50 transition-colors"
      >
        <X size={14} aria-hidden="true" />
      </button>
    );
  }, [onRequestSessionEnd, terminal.isRunning, t, endTargetLabel, handleRequestSessionEnd, splitIndex]);

  // Issue #2042: hand this split's session facts up. In an effect rather than
  // in render because it writes the parent's state, and only when the snapshot
  // identity actually moved — the poller holds it stable across the polls that
  // repeat the same numbers, so this fires roughly once a turn.
  useEffect(() => {
    onAgentSessionChange?.(resolvedInstanceId, agentSession);
  }, [onAgentSessionChange, resolvedInstanceId, agentSession]);

  // Issue #2042: `agentModel` arrives already composed (`model · effort`); this
  // re-enters the shared formatter to put the persona in front of it, so the
  // pane header and the header pill's tooltip cannot word it differently. Null
  // agent (every tool but opencode) returns the string unchanged.
  const paneAgentModel = formatAgentModelLabel(agentModel, null, agentSession.session?.agent);
  // Issue #2042: `$0.03 · 8.5K (1%)` — the same three values, in the same order,
  // that opencode's own footer prints for the session this pane is attached to.
  const paneAgentUsage = formatAgentSessionUsage(
    agentSession.session,
    agentSession.context,
    t,
    locale
  );
  const paneAgentUsageDetail = formatAgentSessionTooltip(
    agentSession.session,
    agentSession.context,
    t,
    locale
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
      headerExtras={endSessionExtras}
      // Issue #1079: the derived agent status now renders as a StatusDot inside
      // the selector trigger (session title bar). BranchStatus ⊂ StatusDotStatus.
      status={cliStatus}
      // Issue #1783: the model the agent reported, shown beside the alias.
      // Issue #2042 prefixes the persona when the agent named one.
      agentModel={paneAgentModel}
      // Issue #2042: cost / context, as a second muted chip.
      agentUsage={paneAgentUsage}
      agentUsageDetail={paneAgentUsageDetail}
      onFocus={onFocus}
      attaching={terminal.attaching}
      // Issue #2193: the header control's pressed state, and the body it names.
      surfaceMode={surfaceMode}
      onSurfaceModeChange={handleSurfaceModeChange}
      terminal={surfaceMode === 'chat' ? chatSurfaceSlot : terminalSlot}
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
