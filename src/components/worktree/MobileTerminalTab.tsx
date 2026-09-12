'use client';

/**
 * MobileTerminalTab (Issue #736, extracted for #1494/#1496)
 *
 * Mobile terminal tab content. Owns a per-(worktreeId, cliToolId) instance of
 * `useTerminalPanePolling` — the same hook the PC split panes use (#728) —
 * replacing the removed terminal reducer slice. Mounted only while the terminal
 * tab is active, so the poller stops when the user is on another mobile tab (and
 * the hook self-resets on a cliToolId change, mirroring the PC compositeKey reset).
 *
 * Issue #1494 / #1496: mobile previously rendered ONLY the read-only
 * TerminalDisplay, so an unclassified TUI overlay (e.g. Claude `/help`) had no
 * on-screen keys at all — the ESC hatch / navigation pad existed on desktop only.
 * This renders the shared {@link TerminalEscapeHatch} navigation pad below the
 * terminal under the same gate the PC footer uses, giving mobile parity for
 * ←/→/↑/↓/Enter/Esc in detection-independent overlays.
 *
 * Issue #2046: {@link OpencodeQuickKeys} is rendered here for the same reason —
 * a phone has no keyboard aimed at the pane at all, so opencode's `tab` /
 * `ctrl+p` / `ctrl+x` chords are unreachable without it.
 *
 * Issue #2106: and it is rendered `collapsible`, i.e. folded behind one 44px
 * toggle that starts CLOSED. Measured in a real browser (see
 * `tests/e2e/mobile-opencode-quick-keys-2106.spec.ts`), the open strip wraps to
 * seven rows and stands 378px tall, which left this tab's `TerminalDisplay` 40px
 * at 390x730 and 0px at 360x640 — the user report that the terminal is barely
 * visible was accurate, and the strip was the cause. Only this mobile surface
 * passes the flag; the PC split pane keeps the always-open strip.
 *
 * Issue #2193: the tab's OUTPUT surface is switchable — a floating segmented
 * control swaps `TerminalDisplay` for the conversation transcript. Epic #2192
 * decided this rather than a fifth mobile tab: the composer is docked below the
 * tab content (`WorktreeDetailRefactored`), so a chat surface inside THIS tab
 * keeps the send box, the prompt sheet and Auto-Yes exactly where they were.
 * The existing `history` tab and `MessageInput` are untouched.
 *
 * The control is an OVERLAY, not a row, and that is a hard constraint rather
 * than a style choice: this tab's vertical budget is already spoken for by
 * #2106, whose acceptance criterion is that the terminal keeps >250px at
 * 360x640 with the quick-keys strip folded. The baseline there is ~284px, so
 * anything in the flex flow has 33px to spend and #1127 requires 44. See the
 * comment on the control itself.
 *
 * Issue #2194: that chat surface is now `ChatSurface` rather than a bare
 * `HistoryPane` — the tab hands it the state its own poller already holds, so the
 * phone gets the same generating row and the same one-tap trail back to the
 * terminal for frames chat cannot drive.
 *
 * Issue #2213: and the #1121 optimistic bubble, which #2194 had to leave to PC
 * because the composer is docked outside this tab. See {@link MobileChatSurface}
 * for how the send reaches it without a second send path.
 *
 * Issue #1879: the unsent-input bar ({@link UnsentComposerBar}) is rendered here
 * for the same reason — the PC footer has it, and a phone is where a half-typed
 * composer is most likely to be discovered. Its gate is the composer text, not a
 * detection flag, so the two bars can be on screen at once and neither implies
 * the other.
 *
 * Issue #2357: the session row ({@link MobileSessionRow}) — which model this
 * instance is running, in the PC split header's exact words, with the amber
 * "changed" notice the server's model edge raises. It is the one thing in this
 * tab that takes vertical space by design (28px, inside #2106's budget), and
 * only while a model is known; see the component for the arithmetic.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, MessageSquare, StickyNote, TerminalSquare } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { UnsentComposerBar, hasUnsentComposerText } from '@/components/worktree/UnsentComposerBar';
import {
  OpencodeSidebarNotice,
  hasOpenCodeSidebarObstruction,
} from '@/components/worktree/OpencodeSidebarNotice';
import { OpencodeQuickKeys } from '@/components/worktree/OpencodeQuickKeys';
import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
// Issue #2427: the session note's storage-facing half lives with the PC split
// header — one hook, one editor, one IME guard — so the phone and the desktop
// cannot drift into two behaviours for one field. See that file's "Session
// notes" section for why the value is read from the list cache rather than
// threaded as a prop, which is the same wall `useCachedAgentModelLabel` below
// hits and solves the same way.
import {
  SESSION_NOTE_OPEN_EVENT,
  SessionNoteInput,
  useSessionNote,
  type SessionNoteValue,
} from '@/components/worktree/TerminalSplitPane';
import { formatSessionNoteTimestamp } from '@/lib/date-utils';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import { usePendingMessages, type OptimisticSendOptions } from '@/hooks/usePendingMessages';
import {
  useConnectivity,
  isServerConfirmedReachable,
  isConnectionKnownDown,
} from '@/hooks/useConnectivity';
import {
  useChatComposerInsert,
  useChatOptimisticSend,
  useRegisterChatOptimisticSend,
} from '@/contexts/WorktreeChatSendContext';
import { useChatFileLinkScope } from '@/lib/chat/chat-file-link-scope';
import {
  buildModelByInstance,
  formatAgentModelLabel,
  formatAgentSessionTooltip,
  formatAgentSessionUsage,
} from '@/components/worktree/WorktreeDetailSubComponents';
import { useRealtimeListener } from '@/hooks/useRealtimeConnection';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { MODEL_CHANGED_EVENT_TYPE, type ModelChangedEvent, type RealtimeEvent } from '@/lib/realtime/types';
import { OPENCODE_LEADER_KEY } from '@/types/terminal-keys';
import { NAV_KEY_REFRESH_DELAY_MS } from '@/config/ui-feedback-config';
import { worktreeApi } from '@/lib/api-client';
import { getTerminalDisplayCompaction } from '@/config/terminal-display-compaction';
import {
  getMobileSurfaceModeStorageKey,
  resolveSurfaceMode,
  writeSurfaceMode,
} from '@/config/surface-mode-config';
import { DEFAULT_SURFACE_MODE, type SurfaceMode } from '@/types/ui-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

export interface MobileTerminalTabProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Issue #874: agent instance id for this tab (defaults to primary === cliToolId). */
  instanceId?: string;
  disableAutoFollow?: boolean;
  /**
   * Issue #2254: report which output surface this tab is showing.
   *
   * The phone's `NavigationButtons` are NOT in this tab — they are docked above
   * the composer in `WorktreeDetailRefactored`, outside the tab content, so they
   * cannot see the mode this component owns. Since the chat surface now draws
   * its own pad inside the dialog card, the docked copy has to stand down while
   * chat is showing, and this is how it learns to.
   *
   * Fired on mount as well as on change (the mode is resolved from localStorage
   * in an effect, so the parent's first render cannot know it), and optional so
   * the seventeen existing suites that mount this tab need no new prop.
   */
  onSurfaceModeChange?: (mode: SurfaceMode) => void;
}

/**
 * Issue #2193: the two segments of the surface control, in render order. Same
 * shape (and same reason for holding i18n KEYS rather than labels) as
 * `SURFACE_MODE_SEGMENTS` in `TerminalSplitPane`; kept separate because the
 * phone's control is a full-width labelled segmented control while PC's is a
 * pair of icon buttons in a crowded header row.
 */
const MOBILE_SURFACE_SEGMENTS: readonly {
  mode: SurfaceMode;
  labelKey: string;
  icon: typeof TerminalSquare;
}[] = [
  { mode: 'terminal', labelKey: 'surfaceMode.terminal', icon: TerminalSquare },
  { mode: 'chat', labelKey: 'surfaceMode.chat', icon: MessageSquare },
] as const;

// ============================================================================
// The session row's model source (Issue #2357)
// ============================================================================

/**
 * The `model · effort` label for one instance of this worktree, or null when
 * nothing has reported one (Issue #2357).
 *
 * Read from the app-wide worktrees cache — the `/api/worktrees` list every
 * screen already polls for the sidebar — rather than from a value threaded
 * down from the detail screen, and the reason is ownership: the value the PC
 * split header reads lives on `WorktreeDetailRefactored`'s `worktree`, but this
 * tab's props are built by `MobileContent` (`WorktreeDetailMobile`) as one
 * frozen object, and neither a new prop nor a new context could cross that
 * boundary without a module every mount of this tab does not already have.
 * The list is the same information: both routes build
 * `sessionStatusByInstance` with `detectWorktreeSessionStatus`, so the phone
 * and the desktop read one field from one builder, and `buildModelByInstance`
 * is the same projection `WorktreeDetailDesktop` feeds the split. The list
 * polls slower than the detail (20s with a live socket), which is why a
 * `model_changed` frame asks it to refresh at once — see the listener below.
 *
 * No provider above (every pre-#2357 suite of this tab) → null → no row.
 */
function useCachedAgentModelLabel(worktreeId: string, instanceId: string): string | null {
  const cache = useOptionalWorktreesCacheContext();
  const worktrees = cache?.worktrees;
  return useMemo(() => {
    const worktree = worktrees?.find((entry) => entry.id === worktreeId);
    return buildModelByInstance(worktree?.sessionStatusByInstance)[instanceId] ?? null;
  }, [worktrees, worktreeId, instanceId]);
}

/**
 * How long the session row stays amber after a model change (Issue #2357).
 *
 * Five minutes, measured from the change's own timestamp rather than from
 * when the frame arrived, so a phone that reconnects late shows the notice
 * for the remainder of the same window rather than for a fresh one.
 */
export const MODEL_CHANGE_HIGHLIGHT_MS = 5 * 60_000;

/** A model change this tab has heard about and not yet dismissed. */
interface RecentModelChange {
  from: string;
  to: string;
  at: number;
}

/**
 * The keys that open opencode's model picker (Issue #2357).
 *
 * opencode has no `/model` — its picker is the `ctrl+x m` leader chord, the
 * same two-entry request `OpencodeQuickKeys`'s `models` button sends. Every
 * other tool with a model to show (claude, codex, copilot, antigravity,
 * command-code) takes `/model` in its composer.
 */
const OPENCODE_MODEL_PICKER_KEYS: readonly string[] = [OPENCODE_LEADER_KEY, 'm'];

/** The slash command every non-opencode tool opens its picker with. */
const MODEL_PICKER_COMMAND = '/model';

/**
 * Whether a `model_changed` frame is about THIS tab's instance.
 *
 * `instance` is always resolved on the wire (`instanceId ?? cliToolId`), so
 * the comparison is against this tab's resolved id and nothing else.
 */
function isModelChangeForInstance(
  event: RealtimeEvent,
  worktreeId: string,
  instanceId: string
): event is ModelChangedEvent {
  if (event.type !== MODEL_CHANGED_EVENT_TYPE) return false;
  const evt = event as Partial<ModelChangedEvent>;
  return evt.worktreeId === worktreeId && evt.instance === instanceId;
}

/**
 * The phone's session row (Issue #2357).
 *
 * One line at the top of the terminal / chat pane: `agent · model · effort`,
 * and for opencode the `$cost · tokens (percent)` chip beside it — the same two
 * strings, from the same two formatters, that the PC split header shows
 * (`TerminalSplitPane`'s `agentModel` / `agentUsage`). Nothing here composes a
 * label of its own, which is what keeps the two screens from drifting.
 *
 * Rendered only when a model is known — the PC rule: `formatAgentModelLabel`
 * returns null for gemini, vibe-local and any pane whose hooks are not wired,
 * and null draws nothing. The row is therefore absent, not empty, on those
 * panes, and the layout below it is the pre-#2357 one.
 *
 * ## The vertical budget
 *
 * This row is IN the flex flow, which #2193's control could not afford, and
 * the numbers are what allow it: the row is a fixed 28px (`h-7`, one
 * `text-[11px]` line, `truncate` so it can never wrap), against the 33px
 * #2106 left in the budget at 360x640 — the terminal keeps 256px there with
 * the row present, above #2106's 250px floor. #1127's 44px tap target is met
 * without spending layout height: each control extends its hit area 8px above
 * and below itself with a pseudo-element (`before:-inset-y-2`), into the
 * instance-tab row above and the output region below, the way the docked
 * instance tabs grow their hit area without growing their text. The surface
 * toggle, which is pinned to the tab's top edge, moves down by the row's
 * height while the row is showing so the two never overlap.
 *
 * ## Two taps, two things
 *
 * Tapping the label opens the tool's model picker — `/model` through the
 * composer's own send path for every tool but opencode, the `ctrl+x m` chord
 * for opencode — after which the dialog card (#2254 / #2297) is the surface
 * the choice is made on. Tapping the amber "changed" chip dismisses the
 * highlight and nothing else; it is a separate control so that noticing a
 * change cannot accidentally send a command.
 */
const MobileSessionRow = memo(function MobileSessionRow({
  modelLabel,
  usage,
  usageDetail,
  recentChange,
  note,
  onEditNote,
  onOpenPicker,
  onDismissChange,
}: {
  modelLabel: string | null;
  usage: string | null;
  usageDetail: string | null;
  recentChange: RecentModelChange | null;
  note: SessionNoteValue | null;
  onEditNote: () => void;
  onOpenPicker: () => void;
  onDismissChange: () => void;
}) {
  const t = useTranslations('worktree');
  const changed = recentChange !== null;
  const rowLabel = t('agentModel.sessionRow', { model: modelLabel ?? '' });
  // Issue #2427: the memo, immediately right of the model — the Issue's placement,
  // and the one that reads as "this session, and what it is on". The row itself
  // now also exists for a note alone: a pane whose tool reports no model
  // (gemini, vibe-local, hooks not wired) is exactly the pane whose header says
  // least, so refusing to show its memo would withhold the label from the
  // sessions that need it most.
  const noteStamp = note ? formatSessionNoteTimestamp(new Date(note.updatedAt)) : '';
  const noteLabel = note
    ? t('sessionNote.label', { note: note.text, time: noteStamp })
    : t('sessionNote.menuItem');
  return (
    <div
      data-testid="mobile-session-row"
      data-model-changed={changed ? 'true' : 'false'}
      className={`relative z-20 flex h-7 shrink-0 items-center gap-2 border-b px-3 text-[11px] leading-none ${
        changed
          ? 'border-warning-border bg-warning-subtle text-warning-foreground'
          : 'border-border bg-surface-2 text-muted-foreground'
      }`}
    >
      {modelLabel ? (
        <button
          type="button"
          onClick={onOpenPicker}
          aria-label={rowLabel}
          title={rowLabel}
          data-testid="mobile-session-model"
          // Issue #2427: `basis-0 grow` spelled out rather than `flex-1`, so the
          // conditional `shrink` beside it is unambiguous — with a note present
          // the model gives up width four times as fast as the memo does, which
          // is the Issue's "narrow means the note wins" written in flexbox.
          className={`relative flex min-w-0 basis-0 grow items-center gap-1.5 truncate text-left touch-manipulation before:absolute before:inset-x-0 before:-inset-y-2 before:content-[''] ${
            note ? 'shrink-[4]' : 'shrink'
          }`}
        >
          <Cpu size={12} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{modelLabel}</span>
        </button>
      ) : null}
      {note ? (
        <button
          type="button"
          onClick={onEditNote}
          aria-label={noteLabel}
          title={noteLabel}
          data-testid="mobile-session-note"
          className="relative flex min-w-0 shrink basis-0 grow items-center gap-1 text-left touch-manipulation before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']"
        >
          <StickyNote size={12} aria-hidden="true" className="shrink-0 opacity-70" />
          <span className="min-w-0 truncate">{note.text}</span>
          <span data-testid="mobile-session-note-time" className="shrink-0 tabular-nums opacity-70">
            {noteStamp}
          </span>
        </button>
      ) : null}
      {usage ? (
        <span
          data-testid="mobile-session-usage"
          title={usageDetail ?? t('agentSession.chipLabel', { usage })}
          className="min-w-0 max-w-[10rem] shrink-0 truncate tabular-nums"
        >
          {usage}
        </span>
      ) : null}
      {recentChange ? (
        <button
          type="button"
          onClick={onDismissChange}
          aria-label={t('agentModel.changedRecentlyDetail', {
            from: recentChange.from,
            to: recentChange.to,
          })}
          title={t('agentModel.changedRecentlyDetail', {
            from: recentChange.from,
            to: recentChange.to,
          })}
          data-testid="mobile-session-model-changed"
          className="relative shrink-0 rounded-full border border-warning-border bg-warning/20 px-1.5 py-0.5 font-medium touch-manipulation before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']"
        >
          {t('agentModel.changedRecently')}
        </button>
      ) : null}
    </div>
  );
});

/**
 * Issue #2193: the phone's chat output surface.
 *
 * Its own component so `useSplitMessages` mounts ONLY while chat is on screen —
 * a hook cannot be called conditionally, and a terminal-mode tab must not start
 * a second 5s history poll it never renders. That is also what keeps every
 * pre-#2193 test of this tab (all of which stay in terminal mode) running the
 * exact set of hooks they ran before.
 *
 * Messages come from `useSplitMessages`, the same instance-scoped fetch the PC
 * split uses, so the transcript matches the instance whose terminal this tab is
 * showing rather than the parent's active-CLI-scoped `messages`.
 *
 * Issue #2194: the body is `ChatSurface`, so the phone gets the same live region
 * and the same "open the terminal" trail the PC split does — the flags come from
 * the tab's own `useTerminalPanePolling`, handed down rather than polled twice.
 *
 * Issue #2213: it also holds the #1121 optimistic bubble, which #2194 had to
 * leave to PC. `usePendingMessages` has to live wherever the transcript array
 * does — it merges the bubble into that array and reconciles it against the
 * server echo — and on a phone the composer is docked *outside* this tab
 * (`WorktreeDetailRefactored` renders it below the tab content). So the hook
 * stays here, next to `useSplitMessages`, and the SEND travels up instead:
 * `useRegisterChatOptimisticSend` publishes `sendOptimistic` on the screen's
 * `WorktreeChatSendContext`, where the docked composer picks it up as its
 * `onOptimisticSend`. No second send path (this is still
 * `worktreeApi.sendMessage` → `POST /send`), no global bus (the provider wraps
 * one screen), and the "chat-only" mounting of `useSplitMessages` is preserved —
 * switching back to the terminal unmounts this component, which releases the
 * registration and puts the composer back on its await-then-clear path.
 */
const MobileChatSurface = memo(function MobileChatSurface({
  worktreeId,
  cliToolId,
  instanceId,
  live,
  frame,
  onKeysSent,
  onSurfaceModeChange,
}: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  live: ChatSurfaceLiveState;
  /** Issue #2254: the raw pane the dialog card draws. */
  frame: string;
  /** Issue #2254: re-poll after a card key lands. */
  onKeysSent: () => void;
  onSurfaceModeChange: (mode: SurfaceMode) => void;
}) {
  const { messages: serverMessages, isLoading, refresh } = useSplitMessages({
    worktreeId,
    cliToolId,
    instanceId,
  });

  // Issue #2213: the same optimistic layer PC has had since #1121, wired the same
  // way (`TerminalSplitPaneContent`) — the send is `worktreeApi.sendMessage` and
  // `onSent` refetches so the bubble reconciles promptly rather than waiting for
  // the next poll. The push from #2195 usually beats that refetch; both land on
  // the same row id, and `usePendingMessages` consumes one echo per bubble.
  const sendMessageFn = useCallback(
    (content: string, options: OptimisticSendOptions) =>
      worktreeApi.sendMessage(worktreeId, content, options),
    [worktreeId],
  );
  // Issue #2503: the phone is the surface this is actually for. The same verdict
  // MobileConnectionBanner shows (#2501) decides whether a send that could not
  // get out is "送信待ち" or a failure — and, on the way back, triggers exactly
  // one automatic resend of what is still waiting. Read through the two
  // evidence-only helpers rather than the banner's verdict: holding a failure
  // back needs proof the network is gone, not merely a socket that is closed.
  const connectivity = useConnectivity();
  const pendingConnectivity = useMemo(
    () => ({
      offline: isConnectionKnownDown(connectivity.signals),
      reachable: isServerConfirmedReachable(connectivity.signals),
    }),
    [connectivity.signals],
  );
  const {
    messages,
    sendOptimistic,
    retry: retryPending,
    discard: discardPending,
  } = usePendingMessages({
    worktreeId,
    serverMessages,
    sendFn: sendMessageFn,
    onSent: refresh,
    connectivity: pendingConnectivity,
  });

  // Publish the send for the docked composer. Released on unmount, i.e. the
  // moment this surface stops being the one the transcript is on.
  useRegisterChatOptimisticSend({ cliToolId, instanceId, send: sendOptimistic });

  // [#2345] The screen's file-link scope: the worktree root this transcript's
  // absolute paths are relative to, and the panel to open them in. Stated as
  // props on the way down rather than read again inside `ChatTranscript`, so
  // the phone's chain says out loud where the path came from.
  const { worktreePath, openFile } = useChatFileLinkScope();

  // Discarding a failed send returns the text to the composer instead of
  // dropping it — PC does this through `onHistoryInsertToMessage`; here the
  // screen's own insert callback arrives over the same context.
  const insertToComposer = useChatComposerInsert();
  const handleDiscardPending = useCallback(
    (tempId: string) => {
      const content = discardPending(tempId);
      if (content) insertToComposer(content);
    },
    [discardPending, insertToComposer],
  );

  return (
    <ChatSurface
      messages={messages}
      worktreeId={worktreeId}
      worktreePath={worktreePath}
      cliToolId={cliToolId}
      instanceId={instanceId}
      live={live}
      onSurfaceModeChange={onSurfaceModeChange}
      // Issue #2254: the dialog card, at the phone's budget. `compact` is what
      // holds it to the low end of the Issue's 12–20 row window and caps the box
      // so it scrolls inside itself instead of taking rows from the transcript
      // (Issue #2106).
      frame={frame}
      onKeysSent={onKeysSent}
      compact
      history={{
        // Issue #2345: file-path routing now HAS an owner on this screen. It is
        // still `WorktreeDetailRefactored`'s `handleFilePathClick` — which on a
        // phone is `setMobileFileViewerPath` — and it still is not threaded
        // through `MobileContent`, which builds this tab's props itself; it
        // arrives over the screen's `ChatFileLinkProvider` instead. Left
        // undefined when no provider is above (the transcript then opens
        // nothing and, unlike the no-op it replaces, probes nothing either).
        onFilePathClick: openFile,
        isLoading,
        onRetryPending: retryPending,
        onDiscardPending: handleDiscardPending,
        // Issue #2232: the same composer callback the discard path above already
        // uses. The phone's transcript had no insert action at all before —
        // `HistoryPane` was mounted here without `onInsertToMessage` — and the
        // chat surface is where re-sending a previous prompt is most useful,
        // because the terminal is not on screen to scroll back through.
        onInsertToMessage: insertToComposer,
      }}
    />
  );
});

export const MobileTerminalTab = memo(function MobileTerminalTab({
  worktreeId,
  cliToolId,
  instanceId,
  disableAutoFollow,
  onSurfaceModeChange,
}: MobileTerminalTabProps) {
  const { terminal, prompt, agentSession, setAutoScroll, refresh } = useTerminalPanePolling({
    worktreeId,
    cliToolId,
    instanceId,
  });
  // Issue #1172 / #2049: compact the tall pane's layout padding (display only).
  // Shares the PC declaration in `TerminalSplitPaneContent` through one config
  // module — before #2049 this was a second hand-written copy of the tool list,
  // which is how PC and phone would come to render the same session differently.
  // Issue #2047 added `mobileWrapMode` to the same declaration: opencode's pane
  // is pinned to a fixed column count on the tmux side, so on a phone the frame
  // keeps that width and the pane scrolls sideways rather than re-wrapping every
  // row in half. PC (`TerminalSplitPaneContent`) deliberately does not read it.
  const { compactTuiLayoutPadding, preservePaintedPanelRows, mobileWrapMode } =
    getTerminalDisplayCompaction(cliToolId);

  const t = useTranslations('worktree');
  const locale = useLocale();

  // --------------------------------------------------------------------------
  // The session row (Issue #2357)
  // --------------------------------------------------------------------------
  // The instance this tab is showing, resolved the way the poller and `/send`
  // resolve it: the primary instance is named by the tool id.
  const resolvedInstanceId = instanceId ?? cliToolId;

  // `model · effort` from the worktrees cache, then the persona in front of
  // it — the exact two-step the PC split does (`WorktreeDetailDesktop` composes
  // model+effort, `TerminalSplitPaneContent` re-enters the formatter with the
  // opencode agent). Null for every pane whose tool reports no model, and null
  // means the row is not rendered at all.
  const modelByInstanceLabel = useCachedAgentModelLabel(worktreeId, resolvedInstanceId);
  const worktreesCache = useOptionalWorktreesCacheContext();
  const sessionModelLabel = formatAgentModelLabel(
    modelByInstanceLabel,
    null,
    agentSession.session?.agent
  );
  const sessionUsage = formatAgentSessionUsage(
    agentSession.session,
    agentSession.context,
    t,
    locale
  );
  const sessionUsageDetail = formatAgentSessionTooltip(
    agentSession.session,
    agentSession.context,
    t,
    locale
  );

  // --------------------------------------------------------------------------
  // The session note (Issue #2427)
  // --------------------------------------------------------------------------
  // The same hook the PC split header uses, against the same list cache, so the
  // two surfaces read and write one value. The EDITOR is opened from
  // `MobileTerminalActionsSheet`, which is rendered outside this tab by
  // `WorktreeDetailRefactored` and therefore knows neither the worktree nor the
  // active instance — it raises a window event and this listener, which holds
  // both, answers it. Exactly the arrangement the terminal search already uses.
  const { note: sessionNote, save: saveSessionNote } = useSessionNote(
    worktreeId,
    resolvedInstanceId
  );
  const [noteEditing, setNoteEditing] = useState(false);
  useEffect(() => {
    const open = () => setNoteEditing(true);
    window.addEventListener(SESSION_NOTE_OPEN_EVENT, open);
    return () => window.removeEventListener(SESSION_NOTE_OPEN_EVENT, open);
  }, []);
  // A different session is a different memo.
  useEffect(() => {
    setNoteEditing(false);
  }, [worktreeId, resolvedInstanceId]);
  const openNoteEditor = useCallback(() => setNoteEditing(true), []);
  const closeNoteEditor = useCallback(() => setNoteEditing(false), []);
  const commitNote = useCallback(
    (text: string) => {
      saveSessionNote(text);
      setNoteEditing(false);
    },
    [saveSessionNote]
  );
  // Issue #2427: the row now has two reasons to exist. It was model-only, and a
  // note on a pane whose tool reports no model would otherwise have nowhere to
  // land — which is the pane the operator most needs a label on.
  const showSessionRow = sessionModelLabel !== null || sessionNote !== null;

  // The most recent `model_changed` frame for THIS instance, held until it is
  // dismissed or `MODEL_CHANGE_HIGHLIGHT_MS` has passed since the change. The
  // frame comes from the server's edge (`agent-event-state`), which already
  // applied every suppression rule; this tab compares nothing itself.
  const [recentModelChange, setRecentModelChange] = useState<RecentModelChange | null>(null);
  useRealtimeListener((event) => {
    if (!isModelChangeForInstance(event, worktreeId, resolvedInstanceId)) return;
    setRecentModelChange({ from: event.from, to: event.to, at: event.at });
    // The label reads the list cache, which polls slowly while a socket is
    // up; the frame IS the news that it is stale, so the list is re-read now
    // rather than the row saying "changed to B" beside a label still reading A.
    void worktreesCache?.refresh();
  });
  // Expire the highlight relative to the change's own timestamp. Keyed on `at`
  // so a second change restarts the window, and cleared on unmount so a timer
  // cannot fire into a torn-down tree.
  useEffect(() => {
    if (recentModelChange === null) return;
    const remaining = recentModelChange.at + MODEL_CHANGE_HIGHLIGHT_MS - Date.now();
    if (remaining <= 0) {
      setRecentModelChange(null);
      return;
    }
    const timer = setTimeout(() => setRecentModelChange(null), remaining);
    return () => clearTimeout(timer);
  }, [recentModelChange]);
  const dismissModelChange = useCallback(() => setRecentModelChange(null), []);
  // A different instance is a different session row: drop the notice with it.
  useEffect(() => {
    setRecentModelChange(null);
  }, [worktreeId, resolvedInstanceId]);

  // Opening the picker. opencode's is a chord through `/special-keys` (the
  // same request its quick-keys `models` button posts); every other tool takes
  // `/model` through the composer's own send path — the screen's optimistic
  // send while the chat surface is registered (so the bubble appears in the
  // transcript, #2213), the plain API otherwise. Either way the pane is
  // re-polled once tmux has had time to draw the picker, so the dialog card
  // (#2254) or the terminal shows it without waiting for the next tick.
  const sendPickerChord = useSpecialKeys(worktreeId, cliToolId, instanceId, refresh);
  const optimisticSend = useChatOptimisticSend({ cliToolId, instanceId });
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
    },
    []
  );
  const openModelPicker = useCallback(() => {
    if (cliToolId === 'opencode') {
      sendPickerChord([...OPENCODE_MODEL_PICKER_KEYS]);
      return;
    }
    const options: OptimisticSendOptions = { cliToolId, instanceId };
    if (optimisticSend) {
      optimisticSend(MODEL_PICKER_COMMAND, options);
    } else {
      void worktreeApi.sendMessage(worktreeId, MODEL_PICKER_COMMAND, options).catch(() => {
        // Advisory: the pane's next poll shows whether the picker opened.
      });
    }
    if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh();
    }, NAV_KEY_REFRESH_DELAY_MS);
  }, [cliToolId, instanceId, optimisticSend, refresh, sendPickerChord, worktreeId]);

  // Issue #2193: one preference per worktree here (the phone shows one pane at
  // a time), against one per split on PC. SSR-safe default first, then the
  // `?view=` / localStorage resolution in an effect — same shape as
  // `useActivityBarState`, so there is no hydration mismatch.
  const surfaceStorageKey = getMobileSurfaceModeStorageKey(worktreeId);
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>(DEFAULT_SURFACE_MODE);
  useEffect(() => {
    setSurfaceMode(resolveSurfaceMode(surfaceStorageKey));
  }, [surfaceStorageKey]);

  const handleSurfaceModeChange = useCallback(
    (mode: SurfaceMode) => {
      setSurfaceMode(mode);
      writeSurfaceMode(surfaceStorageKey, mode);
    },
    [surfaceStorageKey],
  );

  // Issue #2254: publish the mode to the screen that owns the docked controls.
  // In an effect keyed on the resolved value rather than inside
  // `handleSurfaceModeChange`, because the mode ALSO arrives from localStorage
  // in the effect above — a tab reopened in chat mode has to stand the docked
  // pad down without anybody touching the toggle. Writes the parent's state, so
  // it must not run during render.
  useEffect(() => {
    onSurfaceModeChange?.(surfaceMode);
  }, [onSurfaceModeChange, surfaceMode]);

  // Issue #1494 / #1496: detection-independent navigation hatch on mobile.
  // `terminal.isUnclassifiedActive` is already false whenever a selection list /
  // pager / prompt is detected server-side, so this surfaces the pad only for an
  // otherwise-unreachable TUI overlay. `!prompt.visible` mirrors the PC
  // `showEscapeHatch` gate so it stays hidden while a prompt panel is driving the
  // session (e.g. the `/model` misdetection tracked in #1495).
  // Issue #2254 added the `surfaceMode` term. The chat surface renders its own
  // hatch inside the dialog card, directly under the frame it acts on; this one
  // sits below the tab content and would be the second copy.
  const showEscapeHatch =
    terminal.isUnclassifiedActive && !prompt.visible && surfaceMode !== 'chat';

  // Issue #1879: contents-only gate, identical to the PC one. Deliberately not
  // combined with `showEscapeHatch` — an unclassified overlay and a composer
  // holding unsent text are unrelated conditions.
  const showUnsentComposerBar = hasUnsentComposerText(terminal.composerText);

  // Issue #2095: identical gate to PC, from one shared predicate — the sidebar
  // is a property of the pane, not of the screen it is being watched on.
  const showOpencodeSidebarNotice = hasOpenCodeSidebarObstruction(
    cliToolId,
    terminal.realtimeSnippet || terminal.output,
  );

  // Issue #2194: the polled state the chat surface renders. Built from the same
  // `prompt` object the mobile prompt sheet is driven by, so the banner's "a wait
  // nobody could read" case and the sheet cannot disagree about one frame — see
  // `ChatSurfaceLiveState` for why `isPromptWaiting` is `prompt.visible`.
  const chatLiveState: ChatSurfaceLiveState = useMemo(
    () => ({
      isRunning: terminal.isRunning,
      // Issue #2445: same copy, same reason as the PC split — the phone must
      // not read the hook's initial `isRunning: false` as a dead session.
      attaching: terminal.attaching,
      // Issue #2238: same pair, same reason as the PC split — this is the field
      // the in-flight bubble is gated on, and `isRunning` is not.
      sessionStatus: terminal.sessionStatus,
      isThinking: terminal.isThinking,
      isPromptWaiting: prompt.visible,
      promptData: prompt.data,
      isSelectionListActive: terminal.isSelectionListActive,
      isPagerActive: terminal.isPagerActive,
      // Issue #2373: same copy, same reason as the PC split — without it the
      // surface only ever sees `undefined` here and re-derives the verdict from
      // the frame it was handed, which is a different slice of bytes than the
      // one the server judged.
      isDismissablePanelActive: terminal.isDismissablePanelActive,
      isUnclassifiedActive: terminal.isUnclassifiedActive,
    }),
    [
      terminal.isRunning,
      terminal.attaching,
      terminal.sessionStatus,
      terminal.isThinking,
      terminal.isSelectionListActive,
      terminal.isPagerActive,
      terminal.isDismissablePanelActive,
      terminal.isUnclassifiedActive,
      prompt.visible,
      prompt.data,
    ],
  );

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Issue #2193: the surface control, as a floating pill rather than a row.

          It was a full-width row above the terminal in the first cut of #2193,
          and that broke Issue #2106's acceptance criterion: the row cost the
          flex column ~53px, which came out of `TerminalDisplay` and left it
          231px at 360x640 against #2106's >250px floor (measured in
          `tests/e2e/mobile-opencode-quick-keys-2106.spec.ts`). There is no
          in-flow placement that satisfies both #2106 and #1127's >=44px tap
          target -- the budget between the 284px baseline and the 250px floor is
          33px -- and this tab has no header row to absorb it into, so the
          control has to leave the flex flow entirely.

          Overlaying the output is the established idiom in this very surface:
          `TerminalDisplay` already floats its search bar (`absolute top-2
          right-2`) and its scroll FAB (`absolute bottom-4 right-4`) over the
          same box. Pinned to the OUTER column rather than inside the terminal
          region so it survives the region collapsing to zero (the 360x640
          strip-open case #2106 documents) -- losing the only way back from the
          chat surface there would be worse than the overlap.

          `pointer-events-none` on the pill with `pointer-events-auto` on the two
          buttons: the terminal keeps every pixel for scrolling except the two
          44px squares. Icon-only, so the pill is ~96px wide and the output it
          covers is a corner rather than a band; the names live in `aria-label` /
          `title` instead of visible text. Theme-following (`bg-surface-2`) --
          the terminal underneath is a permanently dark island, but this is
          chrome sitting on top of it, and it has to read on the chat surface
          too. */}
      <div
        role="group"
        aria-label={t('surfaceMode.groupLabelMobile')}
        data-testid="mobile-surface-mode-toggle"
        // Issue #2357: `top-9` (36px = the 28px session row + the 8px gap the
        // pill already keeps) while the row is showing, so the pill sits over
        // the output as before rather than over the row.
        className={`pointer-events-none absolute right-2 z-30 flex items-center gap-0.5 rounded-full border border-border bg-surface-2/95 p-0.5 shadow-lg backdrop-blur ${
          showSessionRow ? 'top-9' : 'top-2'
        }`}
      >
        {MOBILE_SURFACE_SEGMENTS.map(({ mode, labelKey, icon: Icon }) => {
          const active = surfaceMode === mode;
          const label = t(labelKey);
          return (
            <button
              key={mode}
              type="button"
              onClick={() => handleSurfaceModeChange(mode)}
              aria-pressed={active}
              aria-label={label}
              title={label}
              data-testid={`mobile-surface-mode-${mode}`}
              className={`pointer-events-auto flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full transition-colors touch-manipulation ${
                active
                  ? 'bg-accent-500/20 text-accent-600 dark:text-accent-400'
                  : 'text-muted-foreground'
              }`}
            >
              <Icon size={18} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {/* Issue #2106: the measured surface. The wrapper is what the flex column
          hands to TerminalDisplay (which is `h-full`), so its rect IS the
          terminal's visible height -- the number the collapse has to move.
          Issue #2193: in chat mode the transcript takes the same box, so the
          measurement and the layout below it are unchanged.

          `overflow-hidden` (Issue #2193) closes a second way this row could
          steal a click from the rows below it. `TerminalDisplay`'s `role="log"`
          carries `p-4` and a border, and `box-sizing: border-box` cannot shrink
          a box below its own padding + border -- so when this `flex-1 min-h-0`
          region is squeezed to 0 (strip open on a small phone), the log still
          PAINTED 34px, straight over the quick-keys toggle underneath, and
          `opencode-quick-keys-toggle` became unclickable while reporting itself
          visible and enabled. Clipping the region is the fix, and it is correct
          independent of #2193: a zero-height region has no business drawing
          outside itself. */}
      {/* Issue #2357: the session row — which model this instance is on, in
          the PC split header's words. Absent (not empty) when nothing has
          reported a model; see `MobileSessionRow` for the height budget. */}
      {showSessionRow ? (
        <MobileSessionRow
          modelLabel={sessionModelLabel}
          usage={sessionUsage}
          usageDetail={sessionUsageDetail}
          recentChange={recentModelChange}
          note={sessionNote}
          onEditNote={openNoteEditor}
          onOpenPicker={openModelPicker}
          onDismissChange={dismissModelChange}
        />
      ) : null}
      {/* Issue #2427: the note editor, overlaid rather than in the flex flow —
          the same #2106 budget the surface pill obeys. It is anchored under the
          session row when there is one and at the tab's top edge when there is
          not, so it never covers the row it is editing. */}
      {noteEditing ? (
        <div
          data-testid="mobile-session-note-editor"
          className={`absolute inset-x-2 z-40 rounded-md border border-border bg-surface p-2 shadow-lg ${
            showSessionRow ? 'top-9' : 'top-2'
          }`}
        >
          <SessionNoteInput
            initialText={sessionNote?.text ?? ''}
            onCommit={commitNote}
            onCancel={closeNoteEditor}
            ariaLabel={t('sessionNote.menuItem')}
            placeholder={t('sessionNote.placeholder')}
            testId="mobile-session-note-input"
          />
          <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
            {t('sessionNote.hint')}
          </p>
        </div>
      ) : null}
      <div className="flex-1 min-h-0 overflow-hidden" data-testid="mobile-terminal-region">
        {surfaceMode === 'chat' ? (
          <div className="h-full min-h-0" data-testid="mobile-chat-surface">
            <MobileChatSurface
              worktreeId={worktreeId}
              cliToolId={cliToolId}
              instanceId={instanceId}
              live={chatLiveState}
              frame={terminal.output}
              onKeysSent={refresh}
              onSurfaceModeChange={handleSurfaceModeChange}
            />
          </div>
        ) : (
          <TerminalDisplay
            output={terminal.output}
            isActive={terminal.isRunning}
            isThinking={terminal.isThinking}
            autoScroll={terminal.autoScroll}
            onScrollChange={setAutoScroll}
            disableAutoFollow={disableAutoFollow}
            compactTuiLayoutPadding={compactTuiLayoutPadding}
            preservePaintedPanelRows={preservePaintedPanelRows}
            wrapMode={mobileWrapMode}
          />
        )}
      </div>
      {showUnsentComposerBar ? (
        <div className="shrink-0 px-2 pt-1">
          <UnsentComposerBar
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={instanceId}
            composerText={terminal.composerText}
            onActionSent={refresh}
          />
        </div>
      ) : null}
      {showOpencodeSidebarNotice ? (
        <div className="shrink-0 px-2 pt-1">
          <OpencodeSidebarNotice
            cliToolId={cliToolId}
            frame={terminal.realtimeSnippet || terminal.output}
          />
        </div>
      ) : null}
      {/* Issue #2046: opencode's own chords, on the phone for the same reason
          #1494 put the escape hatch here -- the mobile terminal is read-only and
          has no other way to send them. `compact` drops the key-notation suffix;
          the keys, the gate and the omissions are identical to PC because they
          come from one component.
          Issue #2106: `collapsible` folds all seventeen behind one 44px toggle,
          closed by default on this screen (Issue #2131 gave PC its own key and
          its own default; this one is unchanged). The slot below renders for
          every tool while the session is running, but OpencodeQuickKeys still
          returns null for anything other than opencode -- so on claude / codex /
          copilot this is an empty div exactly as it was before #2106. */}
      {terminal.isRunning ? (
        <div className="shrink-0 px-2 pt-1" data-testid="mobile-quick-keys-slot">
          <OpencodeQuickKeys
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={instanceId}
            hasAgentSession={agentSession.session !== null}
            onKeysSent={refresh}
            compact
            collapsible
            // Issue #2131: name the screen explicitly. PC now folds too, and the
            // two screens keep SEPARATE preferences (`commandmate:mobile:…` here,
            // `commandmate:desktop:…` there) with opposite defaults -- closing
            // the strip on a phone must not close it on a 1920px desktop.
            layout="mobile"
          />
        </div>
      ) : null}
      {showEscapeHatch ? (
        <div className="shrink-0 px-2 pt-1 pb-2">
          <TerminalEscapeHatch
            worktreeId={worktreeId}
            cliToolId={cliToolId}
            instanceId={instanceId}
            onKeysSent={refresh}
          />
        </div>
      ) : null}
    </div>
  );
});

export default MobileTerminalTab;
