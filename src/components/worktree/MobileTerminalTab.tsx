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
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { MessageSquare, TerminalSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { UnsentComposerBar, hasUnsentComposerText } from '@/components/worktree/UnsentComposerBar';
import {
  OpencodeSidebarNotice,
  hasOpenCodeSidebarObstruction,
} from '@/components/worktree/OpencodeSidebarNotice';
import { OpencodeQuickKeys } from '@/components/worktree/OpencodeQuickKeys';
import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import { useTerminalPanePolling } from '@/hooks/useTerminalPanePolling';
import { useSplitMessages } from '@/hooks/useSplitMessages';
import { usePendingMessages, type OptimisticSendOptions } from '@/hooks/usePendingMessages';
import {
  useChatComposerInsert,
  useRegisterChatOptimisticSend,
} from '@/contexts/WorktreeChatSendContext';
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
  onSurfaceModeChange,
}: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
  live: ChatSurfaceLiveState;
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
  });

  // Publish the send for the docked composer. Released on unmount, i.e. the
  // moment this surface stops being the one the transcript is on.
  useRegisterChatOptimisticSend({ cliToolId, instanceId, send: sendOptimistic });

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
      cliToolId={cliToolId}
      instanceId={instanceId}
      live={live}
      onSurfaceModeChange={onSurfaceModeChange}
      history={{
        // File-path routing still has no owner on this screen: `handleFilePathClick`
        // lives in `WorktreeDetailRefactored` and is not threaded through
        // `MobileContent` to this tab. A no-op keeps the required prop honest.
        onFilePathClick: () => {},
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

  // Issue #1494 / #1496: detection-independent navigation hatch on mobile.
  // `terminal.isUnclassifiedActive` is already false whenever a selection list /
  // pager / prompt is detected server-side, so this surfaces the pad only for an
  // otherwise-unreachable TUI overlay. `!prompt.visible` mirrors the PC
  // `showEscapeHatch` gate so it stays hidden while a prompt panel is driving the
  // session (e.g. the `/model` misdetection tracked in #1495).
  const showEscapeHatch = terminal.isUnclassifiedActive && !prompt.visible;

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
      // Issue #2238: same pair, same reason as the PC split — this is the field
      // the in-flight bubble is gated on, and `isRunning` is not.
      sessionStatus: terminal.sessionStatus,
      isThinking: terminal.isThinking,
      isPromptWaiting: prompt.visible,
      promptData: prompt.data,
      isSelectionListActive: terminal.isSelectionListActive,
      isPagerActive: terminal.isPagerActive,
      isUnclassifiedActive: terminal.isUnclassifiedActive,
    }),
    [
      terminal.isRunning,
      terminal.sessionStatus,
      terminal.isThinking,
      terminal.isSelectionListActive,
      terminal.isPagerActive,
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
        className="pointer-events-none absolute right-2 top-2 z-30 flex items-center gap-0.5 rounded-full border border-border bg-surface-2/95 p-0.5 shadow-lg backdrop-blur"
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
      <div className="flex-1 min-h-0 overflow-hidden" data-testid="mobile-terminal-region">
        {surfaceMode === 'chat' ? (
          <div className="h-full min-h-0" data-testid="mobile-chat-surface">
            <MobileChatSurface
              worktreeId={worktreeId}
              cliToolId={cliToolId}
              instanceId={instanceId}
              live={chatLiveState}
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
