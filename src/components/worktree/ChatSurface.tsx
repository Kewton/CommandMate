'use client';

/**
 * ChatSurface (Issue #2194)
 *
 * Turns the chat output surface from "a transcript you can read" into "a surface
 * you can work on". Issue #2193 put `HistoryPane` where `TerminalDisplay` used to
 * be; this wraps that pane in the four things a working surface needs and the
 * transcript alone does not give you:
 *
 *   1. a generating indicator, so a turn in flight is visible — and, since Issue
 *      #2199, the in-flight body itself for the two tools that can produce one;
 *   2. a live region that survives virtualization;
 *   3. a dialog card for the states chat used to be unable to drive at all
 *      (selection list / pager / unreadable frame / a wait nobody could parse);
 *   4. follow-the-tail with a "jump to latest" chip when the reader has scrolled
 *      up, on the same discipline `TerminalDisplay` follows output on.
 *
 * ## (3) was a dead end until Issue #2254
 *
 * Epic #2192's decision 5 said those four states were terminal-only, so what
 * this surface drew for them was a banner and one button: "open the terminal".
 * **That decision is withdrawn by Issue #2254.** The banner told the user what
 * was happening and then took the screen away from them — and on a phone the
 * terminal is a different tab, so answering a dialog meant abandoning the
 * transcript they were reading.
 *
 * The live region now carries {@link ChatDialogCard}: the pane's own last rows
 * (`frame`, clipped by `lib/chat/dialog-frame`), with the state's own controls
 * directly underneath — `NavigationButtons` for a selection list or a pager,
 * `TerminalEscapeHatch` for a frame nobody classified, and `PromptAnswerKeys`
 * (the `1`–`9` / `y` / `n` characters #2254 added to the special-keys
 * vocabulary) wherever the answer is a character rather than a direction. The
 * banner survives, reworded from "go to the terminal" to "you can do this here",
 * and its button stays as a secondary way out.
 *
 * Because those controls are HERE, the PC footer must not draw them too:
 * `TerminalSplitPaneContent` gates its `showNav` / `showEscapeHatch` on
 * `surfaceMode`, and the phone's docked `NavigationButtons`
 * (`WorktreeDetailRefactored`) is gated the same way. `PromptPanel` /
 * `MobilePromptSheet` are NOT — see "What this deliberately does NOT do".
 *
 * ## Where the in-flight reply lives (Issue #2233 moved it)
 *
 * (1) and (2) used to be one footer strip below the transcript. That kept the
 * body mounted while the reader scrolled, which was the whole point, but it also
 * meant the reply grew in one place — `.assistant-md`, `text-xs`, full pane
 * width, clamped to `max-h-[7.5rem]` — and then vanished and reappeared as a
 * settled bubble somewhere else, in `.chat-md` at `text-sm`. Issue #2233 hands
 * the state to `ChatTranscript` as `liveTurn`, which draws it as the last bubble
 * in the column: inside the scroll region, outside the virtual list. Nothing can
 * unmount it — #2194's reason is preserved — and completing the turn changes
 * nothing on screen but the spinner going away.
 *
 * What this surface keeps is the consequence of that move: the live bubble is in
 * the flow, so scrolling up carries it off screen. Something must therefore say
 * "still running, and it is below you" — the jump-to-latest chip below did,
 * until Issue #2283 moved the whole job to the transcript's own FAB.
 *
 * ## Who owns the way back to the tail (Issue #2283)
 *
 * `ChatTranscript`, now. Two follows aimed at the same place from here, and both
 * of them were `scrollTop = scrollHeight` — which, against a virtual list whose
 * tail rows have never been measured, lands 7,770px short and then falls further
 * behind with every measurement that arrives. The transcript publishes
 * {@link ChatTranscriptScrollControls} on mount, and:
 *
 *  - the chip's jump uses them when they are there, so it reaches the real end;
 *  - the chip itself is WITHDRAWN when they are there, because the transcript is
 *    drawing its own FAB and two ways back is one too many. It stays for a
 *    caller whose transcript publishes nothing — every suite in this directory
 *    that stubs `ChatTranscript`, and any future slot filled with something
 *    else;
 *  - the mount-time follow is gone. It fired before the virtual list had
 *    replaced the #1123 fallback, so it moved a DOM that was about to be thrown
 *    away and nothing re-aimed afterwards. The transcript's own anchor is what
 *    lands the first paint now.
 *
 * The `shrink-0` live region that remains holds the terminal banner alone.
 *
 * ## The transcript it wraps (Issue #2232)
 *
 * Originally `HistoryPane`, on the Epic's decision that the chat surface would
 * BE the History pane and that no second transcript would be written. **Both of
 * those decisions were withdrawn by Issue #2232** — the shipped screen was "the
 * terminal hidden and History widened", and the two surfaces want opposite
 * things (History clamps an assistant reply to 100 characters, which hid ~96% of
 * this repository's rows). The body is now `ChatTranscript`: message-level
 * bubbles, user right, assistant left, replies in full.
 *
 * The price of that second implementation is that the first one does not move.
 * `HistoryPane`, `ConversationPairCard` and `lib/history-virtualization` are
 * untouched, so the History column and the phone's History tab render exactly as
 * before; see `ChatTranscript`'s header for what that forces (a `.chat-md`
 * namespace of its own, chat's own virtualization constants, chat's own search
 * highlight namespace).
 *
 * ## What this deliberately does NOT do
 *
 * - **No prompt UI for an ANSWERABLE wait.** When a wait carries options, the
 *   composer's own `PromptPanel` (PC) / `MobilePromptSheet` (phone) is already
 *   on screen in chat mode — #2193 left the whole input half untouched precisely
 *   so it would be. A second copy here would be two controls answering one
 *   dialog, which is why {@link resolveBlockedReason} still returns `null` for
 *   it and Issue #2254 changed nothing about that branch. The card appears only
 *   where the composer has nothing to offer.
 * - **No free text.** The card sends fixed key names through `/special-keys`.
 *   `/send`'s `prompt_waiting` guard is untouched (Issue #2254 scope).
 * - **No prompt auto-answering.** Auto-Yes calls `detectPrompt` directly and does
 *   not pass through anything this component can see; nothing here may touch it.
 * - **No new session-start path.** The empty state (now `ChatTranscript`'s, and
 *   the only one on the surface — Issue #2232 folded this component's duplicate
 *   hint line into it) is a *label*. Starting a session on send is `/send`'s
 *   existing behavior and stays there.
 *
 * ## Theme
 *
 * Theme-following, like the transcript it wraps. The terminal is a permanently dark
 * island because it mirrors a fixed xterm palette; a transcript is not, so every
 * color here is a semantic token and no light-on-dark is written into a shared
 * child. The ONE exception is the dialog card's frame, which reproduces a pane's
 * own SGR colours and is therefore dark in both themes — expressed with the
 * `terminal-surface` / `terminal-foreground` tokens rather than raw `gray-*`,
 * see `ChatDialogCard`.
 */

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, Loader2, TerminalSquare } from 'lucide-react';
import {
  ChatTranscript,
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID,
  type ChatTranscriptLiveTurn,
  type ChatTranscriptScrollControls,
} from '@/components/worktree/ChatTranscript';
import { ChatDialogCard } from '@/components/worktree/ChatDialogCard';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import { TerminalEscapeHatch } from '@/components/worktree/TerminalEscapeHatch';
import { PromptAnswerKeys } from '@/components/worktree/PromptAnswerKeys';
import { isAnswerablePromptData, type ChatMessage, type LivePromptData } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { SurfaceMode } from '@/types/ui-state';
import type { ShowToast } from '@/types/markdown-editor';
import { isNearBottom } from '@/lib/history-virtualization';
import {
  useChatTurnProgress,
  type ChatTurnProgressView,
} from '@/hooks/useChatTurnProgress';

// ============================================================================
// Constants
// ============================================================================

/**
 * How this component reaches the scroll element it has to follow.
 *
 * `ChatTranscript` owns its scroll region (`overflow-y-auto` on the div it marks
 * with this testid) and exposes no ref for it, so the DOM is the only seam
 * available from outside. Queried within this surface's own root rather than the
 * document, so a second transcript mounted elsewhere on a PC split screen can
 * never be the one that gets scrolled.
 *
 * Built from the testid the transcript exports rather than a literal, so the two
 * halves of the seam cannot be renamed apart. Every consumer tolerates a miss:
 * with `ChatTranscript` mocked, or before it has mounted, there is simply no
 * follow behavior — never a crash.
 */
export const CHAT_SCROLL_CONTAINER_SELECTOR = `[data-testid="${CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID}"]`;

/**
 * Why the banner exists, in the order the reason is chosen.
 *
 * Pager is resolved BEFORE selection list because server-side it is a subset of
 * it (`isPagerActive` ⊂ `isSelectionListActive`, see `PaneTerminalState`), so a
 * pager frame raises both flags and "you are in a pager" is the more specific —
 * and more actionable — of the two sentences.
 */
export type ChatSurfaceBlockedReason =
  | 'pager'
  | 'selectionList'
  | 'unclassified'
  | 'promptUnreadable';

/** i18n key (under `worktree.chatSurface`) for each reason. */
const BLOCKED_REASON_KEY: Record<ChatSurfaceBlockedReason, string> = {
  pager: 'chatSurface.reasonPager',
  selectionList: 'chatSurface.reasonSelectionList',
  unclassified: 'chatSurface.reasonUnclassified',
  promptUnreadable: 'chatSurface.reasonPromptUnreadable',
};

// ============================================================================
// Types
// ============================================================================

/**
 * The polled session state this surface renders.
 *
 * Sourced from `useTerminalPanePolling` on both screens. Note what the hook
 * actually returns: `terminal.{isRunning,isThinking,isSelectionListActive,
 * isPagerActive,isUnclassifiedActive}` plus a `prompt` object whose `visible` is
 * already `isPromptWaiting && promptData` — there is no separate `isPromptWaiting`
 * on its result. `isPromptWaiting` here is therefore fed from `prompt.visible`
 * and `promptData` from `prompt.data`, which is what makes
 * "waiting but nothing readable" expressible at all: it is a `prompt.visible`
 * whose payload is #1708's / #1725's degraded record rather than an answerable
 * one.
 */
export interface ChatSurfaceLiveState {
  /**
   * A tmux session exists for this pane and is healthy. **Not** "the session is
   * generating" — that is {@link sessionStatus} (Issue #2238).
   *
   * This comment used to say "The session is generating", and that sentence is
   * the whole of #2238: the surface believed it, gated the in-flight bubble on
   * it, and so said "Responding…" for as long as a healthy session existed —
   * forever, on an idle pane, across a full reload. The value comes from
   * `hasSession() + isSessionHealthy()` and has never meant anything else; the
   * terminal surface next to this one reads it correctly, as `isActive` /
   * `disabled` / `isSessionRunning`.
   *
   * Kept on this type because {@link resolveBlockedReason}'s neighbours and the
   * pane's own wiring still describe the session, and because deleting it would
   * hide the distinction rather than record it.
   */
  isRunning?: boolean;
  /**
   * The merged status verdict, or `undefined` when the caller has none yet
   * (Issue #2238). `'running'` is this surface's ONLY generating signal.
   *
   * Same value, and the same `'idle' | 'ready' | 'running' | 'waiting'` domain,
   * as `PaneTerminalState.sessionStatus`. It is deliberately the same field the
   * server gates the progress publisher on
   * (`current-output-builder.ts`: `payload.isRunning && payload.sessionStatus === 'running'`),
   * so the subscription this surface opens is live exactly while frames are
   * being produced for it.
   */
  sessionStatus?: string;
  /** The CLI is painting a thinking indicator (a narrower wording than isRunning). */
  isThinking?: boolean;
  /** A wait is on screen. See the note above: this is `prompt.visible`. */
  isPromptWaiting?: boolean;
  /**
   * The wait's payload. May be the degraded {@link LivePromptData} member that
   * carries no options (#1708 / #1725) — narrowed here with
   * `isAnswerablePromptData`, so a caller cannot get the distinction wrong.
   */
  promptData?: LivePromptData | null;
  isSelectionListActive?: boolean;
  isPagerActive?: boolean;
  isUnclassifiedActive?: boolean;
}

/**
 * Transcript props this surface forwards verbatim (insert / #1121 retry-discard
 * / toast / file paths / per-split search namespace).
 *
 * A pass-through object rather than seven more direct props: the PC split builds
 * one object for its collapsible History column and hands the same value here,
 * so the column and the output surface cannot be given different messages or a
 * different set of callbacks.
 *
 * Issue #2232 narrowed this. The caller's object still carries the History
 * column's filter controls (`showArchived`, `historyDisplayLimit`,
 * `historyUserOnly` and their setters) — a widened object is legal here because
 * excess-property checking does not apply to a variable — but the chat surface
 * no longer renders them: a display-limit select and an archived checkbox are a
 * BROWSER's controls, and this is a conversation. What the reader loses with
 * them is nothing they could act on here; what they must not lose is search,
 * which `ChatTranscript` keeps behind one icon.
 *
 * `messages`, `worktreeId`, `cliToolId` and `className` are omitted on purpose —
 * they are this component's own props and are applied after the spread, so the
 * two can never disagree. `onCollapse` is omitted because collapsing the OUTPUT
 * would leave the split showing nothing at all.
 */
export interface ChatSurfaceHistoryProps {
  onFilePathClick?: (path: string) => void;
  isLoading?: boolean;
  showToast?: ShowToast;
  onInsertToMessage?: (content: string) => void;
  onRetryPending?: (tempId: string) => void;
  onDiscardPending?: (tempId: string) => void;
  splitIndex?: number;
}

export interface ChatSurfaceProps {
  /**
   * The transcript. On PC this is `usePendingMessages`' merged array, so a
   * just-sent message is already in it as a #1121 pending bubble; on the phone it
   * is `useSplitMessages`, which since #2195 receives every row as a push. Either
   * way this component adds no send path of its own — see {@link dedupeById} for
   * the one guarantee it does make about the array.
   */
  messages: ChatMessage[];
  worktreeId: string;
  cliToolId?: CLIToolType;
  /** The agent instance this surface is showing. Published as `data-instance-id`. */
  instanceId?: string;
  live: ChatSurfaceLiveState;
  /** Switches the pane's output half. The banner's secondary button calls this with 'terminal'. */
  onSurfaceModeChange: (mode: SurfaceMode) => void;
  /**
   * The pane's raw frame, for the dialog card (Issue #2254).
   *
   * **`PaneTerminalState.output`, not `realtimeSnippet`.** Both are already in
   * the caller's hand — the polling hook publishes them side by side — and the
   * snippet is the wrong one: it is `lines.slice(-100)` of a 200x1000 pane, and
   * for a codex session that has not yet filled the pane the content sits at the
   * TOP with hundreds of blank rows below it, so the last 100 rows are empty.
   * Measured on the live captures in `tests/fixtures/chat-dialog-card-2254/`;
   * `extractDialogFrameTail` trims the trailing blank run for the same reason.
   *
   * Omitting it is legal and simply means no card — the banner still appears, so
   * a caller that has not been updated degrades to the pre-#2254 behaviour.
   */
  frame?: string;
  /**
   * Refresh the pane after a key is sent, so the card redraws promptly instead
   * of waiting for the next poll. Same callback the footer's key strips take.
   */
  onKeysSent?: () => void;
  /**
   * Phone layout (Issue #2106's vertical budget): a shorter card, scrolling
   * inside itself, so the transcript keeps its rows.
   */
  compact?: boolean;
  history?: ChatSurfaceHistoryProps;
  className?: string;
}

// ============================================================================
// Pure helpers (exported for unit tests)
// ============================================================================

/**
 * Collapse duplicate ids, keeping the FIRST position and the LAST value.
 *
 * The #1121 pending bubble and its server echo are reconciled by
 * `usePendingMessages` before they can ever both be in this array, and #2195's
 * `upsertMessage` matches pushed rows by id — so a duplicate id reaching here is
 * already a bug somewhere upstream. This makes its symptom "the newer copy wins"
 * instead of "the message is on screen twice", which is the difference between an
 * invisible upstream bug and a user watching their own message double.
 *
 * Returns the input array unchanged when there is nothing to collapse, so the
 * memoized `ChatTranscript` is not re-rendered by a fresh array identity on every
 * poll.
 */
export function dedupeById(messages: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of messages) {
    // Map.set on an existing key updates the value and KEEPS the original
    // insertion position, which is exactly first-position / last-value.
    byId.set(message.id, message);
  }
  if (byId.size === messages.length) return messages;
  return Array.from(byId.values());
}

/**
 * Whether the settled row for this turn is already in the transcript (Issue #2199).
 *
 * The swap rule, in one line, and the reason `chat_turn_progress` needs no
 * `done` frame: the row the tool's history writer saves carries the turn's
 * `requestId`, and the progress frames for that same turn carry it as `turnKey`.
 * When both are present the row wins — it is the same text, rendered by the same
 * Markdown path, in the place the reader will scroll back to.
 *
 * Scanned from the END because the settled row is the newest thing in the array
 * in every case this is asked about, and the array is the whole visible history.
 */
export function isTurnSettled(messages: readonly ChatMessage[], turnKey: string): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].requestId === turnKey) return true;
  }
  return false;
}

/**
 * Why this frame needs the dialog card, or `null` when it needs nothing.
 *
 * The four members are the states Epic #2192 decided were terminal-only: arrow-key
 * navigation, a pager, a frame no detector could classify, and a wait whose
 * payload carries no options for the composer's prompt panel to render. Issue
 * #2254 withdrew the "terminal-only" half of that decision — they are now driven
 * from the card this returns the reason for — but the SET is unchanged, and so
 * is the exclusion that matters most: anything else, including a normal
 * answerable prompt, is workable from the composer and must NOT raise a card,
 * because `PromptPanel` / `MobilePromptSheet` are already on screen for it.
 */
export function resolveBlockedReason(live: ChatSurfaceLiveState): ChatSurfaceBlockedReason | null {
  if (live.isPagerActive) return 'pager';
  if (live.isSelectionListActive) return 'selectionList';
  if (live.isUnclassifiedActive) return 'unclassified';
  if (live.isPromptWaiting && !isAnswerablePromptData(live.promptData)) return 'promptUnreadable';
  return null;
}

// ============================================================================
// Component
// ============================================================================

export const ChatSurface = memo(function ChatSurface({
  messages,
  worktreeId,
  cliToolId,
  instanceId,
  live,
  onSurfaceModeChange,
  frame,
  onKeysSent,
  compact = false,
  history,
  className = '',
}: ChatSurfaceProps) {
  const t = useTranslations('worktree');
  const rootRef = useRef<HTMLDivElement>(null);

  const visibleMessages = useMemo(() => dedupeById(messages), [messages]);

  // --------------------------------------------------------------------
  // Follow the tail (Issue #2194 §3)
  // --------------------------------------------------------------------
  // Same discipline as the terminal surface: follow while the reader is at the
  // end, stop the moment they scroll up, and offer one control to come back.
  //
  // `ChatTranscript` also follows on its own, through the virtualizer, which is
  // the only thing that can land on a row whose height has not been measured
  // yet. Both follows aim at the same place, and this one is kept because it
  // works with the transcript mocked and because it is what the jump-to-latest
  // chip's state is derived from.
  const isPinnedRef = useRef(true);
  const prevMessageCountRef = useRef(-1);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  // Issue #2233: the same fact as `isPinnedRef`, in state, because the chip has
  // to re-render on it. The ref stays the one the layout effects read — they run
  // before React has committed a state change made in the same scroll event.
  const [isAtBottom, setIsAtBottom] = useState(true);

  const getScrollContainer = useCallback((): HTMLElement | null => {
    return rootRef.current?.querySelector<HTMLElement>(CHAT_SCROLL_CONTAINER_SELECTOR) ?? null;
  }, []);

  // [#2283] Whether the transcript has published scroll controls — i.e. whether
  // it is drawing a jump FAB of its own. State, not a ref: withdrawing the chip
  // below is a render.
  //
  // The controls themselves are deliberately NOT stored. The only thing this
  // surface would use them for is the chip's jump, and the chip is gone by the
  // time they exist; keeping a copy would be a second, unreachable
  // implementation of "the tail" — which is the duplication this Issue removed.
  const [hasTranscriptControls, setHasTranscriptControls] = useState(false);
  const handleScrollControlsChange = useCallback((controls: ChatTranscriptScrollControls | null) => {
    setHasTranscriptControls(controls !== null);
  }, []);

  const scrollToLatest = useCallback(() => {
    // `scrollTop = scrollHeight` lands short of a virtual list's last row, which
    // is why the FAB that replaced this control jumps through the virtualizer
    // instead (Issue #2283). It is still the right thing HERE: this runs only
    // when the transcript published no controls, so there is no virtualizer to
    // ask and the scroll region's own height is all there is to aim at.
    const container = getScrollContainer();
    if (container) container.scrollTop = container.scrollHeight;
    isPinnedRef.current = true;
    setIsAtBottom(true);
    setHasNewBelow(false);
  }, [getScrollContainer]);

  // The pane mounts synchronously, so one subscription on mount is enough; the
  // container is re-resolved on every message change below in case the transcript
  // remounted (loading → loaded swaps the subtree, not the scroll div).
  useEffect(() => {
    const container = getScrollContainer();
    if (!container) return;
    const onScroll = () => {
      const pinned = isNearBottom({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      });
      isPinnedRef.current = pinned;
      setIsAtBottom(pinned);
      if (pinned) setHasNewBelow(false);
    };
    container.addEventListener('scroll', onScroll);
    return () => container.removeEventListener('scroll', onScroll);
  }, [getScrollContainer, history?.isLoading]);

  useLayoutEffect(() => {
    const previous = prevMessageCountRef.current;
    const current = visibleMessages.length;
    prevMessageCountRef.current = current;
    // First render establishes the baseline; arriving at a full history is not
    // "new output" and must not scroll or flag anything.
    if (previous === -1 || current <= previous) return;
    if (isPinnedRef.current) {
      const container = getScrollContainer();
      if (container) container.scrollTop = container.scrollHeight;
      return;
    }
    setHasNewBelow(true);
  }, [visibleMessages.length, getScrollContainer]);

  // --------------------------------------------------------------------
  // The in-flight reply (Issue #2199)
  // --------------------------------------------------------------------
  // Push-only, and gated on the generating verdict so a settled surface holds
  // nothing: there is no `done` frame to clear it with, and the two things that
  // DO end a turn — the settled row and the turn finishing — are both visible
  // here.
  //
  // Issue #2238 moved this gate off `live.isRunning`. `isRunning` is
  // "a healthy tmux session exists", so the subscription was open on every idle
  // pane forever; worse, the same flag gated the bubble below, which is why an
  // idle pane said "Responding…" indefinitely. `'running'` is the verdict the
  // server itself gates `publishChatTurnProgress` on, so this is now open
  // exactly while frames are being produced for it.
  //
  // `live.isRunning` is deliberately NOT ANDed in. It would be redundant — a
  // stopped session publishes `sessionStatus: 'idle'` — and re-admitting it to
  // the generating decision is the exact confusion this Issue exists to remove.
  const isGenerating = live.sessionStatus === 'running';
  const pushedProgress = useChatTurnProgress({
    worktreeId,
    cliToolId,
    instanceId,
    enabled: isGenerating,
  });

  // --------------------------------------------------------------------
  // Ending the hold when the next turn starts (Issue #2248)
  // --------------------------------------------------------------------
  // The hook holds the last body after the turn stops generating, and owns two
  // of the three release conditions itself (`enabled` rising, and the grace
  // period). This is the third: **a row appended to the transcript while a body
  // is held ends the hold.**
  //
  // Two shapes arrive that way and both have to end it. The settled row for the
  // same turn is one, and the swap below already answers it. The other is the
  // user's NEXT message — the reason this exists — because `sessionStatus` does
  // not flip to `running` until the poller's next tick, and until it does the
  // previous turn's paragraph would be sitting UNDERNEATH the message the user
  // just sent, reading as an answer to it.
  //
  // Anchored on the last row's id rather than on the array length: a message
  // being replaced in place (#1121's optimistic row settling into its saved one)
  // is a new row for this purpose, and a re-fetch that returns the same tail is
  // not.
  const lastMessageId = visibleMessages.length
    ? visibleMessages[visibleMessages.length - 1].id
    : null;
  const isHolding = pushedProgress?.settling === true;
  const holdAnchorRef = useRef<{ id: string | null } | null>(null);
  const [isHoldReleased, setIsHoldReleased] = useState(false);

  useEffect(() => {
    if (!isHolding) {
      // Nothing held: re-arm for the next hold rather than leaving a release
      // from the previous turn latched on.
      holdAnchorRef.current = null;
      setIsHoldReleased(false);
      return;
    }
    if (holdAnchorRef.current === null) {
      holdAnchorRef.current = { id: lastMessageId };
      return;
    }
    if (holdAnchorRef.current.id !== lastMessageId) setIsHoldReleased(true);
  }, [isHolding, lastMessageId]);

  // The swap. Held until the row for this exact turn is in the transcript, which
  // is what keeps the reply from vanishing for the poll it takes the row to
  // arrive, and what keeps it from being on screen twice once it has. Issue
  // #2248 added the third clause: a hold the transcript has moved past.
  const progress: ChatTurnProgressView | null =
    pushedProgress !== null &&
    !isTurnSettled(visibleMessages, pushedProgress.turnKey) &&
    !(pushedProgress.settling && isHoldReleased)
      ? pushedProgress
      : null;

  // --------------------------------------------------------------------
  // The live tail (Issue #2233)
  // --------------------------------------------------------------------
  // One object covers both cases the surface used to draw separately, because
  // they are one bubble now: a tool that publishes progress fills `body`, and a
  // tool that publishes none (codex / antigravity / vibe-local) supplies only
  // `isThinking` and gets the indicator alone — in the same place, so the
  // stronger case is a superset of the weaker one rather than a second layout.
  //
  // Issue #2232 removed the old `!isAwaitingReply(...)` gate on the indicator,
  // and the reason still holds: `ConversationPairCard` drew its own "Waiting for
  // response…" inside the last pending card and `ChatTranscript` draws none, so
  // gating here would delete the indicator for the commonest case there is —
  // the user sent a message and the agent is answering it.
  //
  // Memoised on the scalars it is built from, not rebuilt per render: a fresh
  // object identity on every poll would re-render the memoized `ChatTranscript`
  // — and re-run its virtualizer — for a turn whose body has not changed.
  const liveTurn = useMemo<ChatTranscriptLiveTurn | null>(() => {
    if (progress !== null) {
      return {
        turnKey: progress.turnKey,
        version: progress.version,
        body: progress.body,
        partial: progress.partial,
        // Issue #2248. A held body is NOT generating, so it carries neither the
        // thinking wording nor — via `settling` — the spinner and "Responding…"
        // that the transcript would otherwise draw under it. Re-creating #2238's
        // "Responding… that never stops" is the specific failure this avoids.
        isThinking: !progress.settling && live.isThinking === true,
        settling: progress.settling,
      };
    }
    // Issue #2238: the generating verdict, not the session-exists flag. This is
    // the branch the bug was reported against — no tool publishes progress on
    // an idle pane, so the surface fell through to here and drew the bare
    // "Responding…" bubble on top of a finished conversation.
    return isGenerating ? { isThinking: live.isThinking === true } : null;
  }, [progress, isGenerating, live.isThinking]);

  const isLiveTurn = liveTurn !== null;
  // Issue #2248: what the jump-to-latest chip is allowed to claim. A held body
  // is below the reader exactly as a live one is, so the chip still appears —
  // but "still responding" would be a lie about a turn that has stopped.
  const isGeneratingTurn = isLiveTurn && liveTurn.settling !== true;

  // The bubble grows inside the scroll region now, so following it is the same
  // `scrollTop = scrollHeight` every other follow here uses — and only while the
  // reader was already pinned, which is the rule none of them break.
  //
  // [#2283] Except on the FIRST run, which is a MOUNT and not a frame of a live
  // turn. `isPinnedRef` starts true, so this used to fire a write on every
  // mount — against the #1123 fallback or the estimated-height sizer, i.e. a
  // DOM about to be replaced by the virtual list, with nothing re-aiming after
  // the replacement. That write is one half of why the terminal → chat toggle
  // landed near the top of a 208-row transcript; `ChatTranscript`'s tail anchor
  // is what lands the first paint now.
  const hasFollowedLiveTurnRef = useRef(false);
  useLayoutEffect(() => {
    if (!hasFollowedLiveTurnRef.current) {
      hasFollowedLiveTurnRef.current = true;
      return;
    }
    if (!isPinnedRef.current) return;
    const container = getScrollContainer();
    if (container) container.scrollTop = container.scrollHeight;
  }, [progress?.body, isLiveTurn, getScrollContainer]);

  // --------------------------------------------------------------------
  // Live region content
  // --------------------------------------------------------------------
  const blockedReason = resolveBlockedReason(live);

  const handleOpenTerminal = useCallback(() => {
    onSurfaceModeChange('terminal');
  }, [onSurfaceModeChange]);

  // --------------------------------------------------------------------
  // The dialog card's controls (Issue #2254)
  // --------------------------------------------------------------------
  // One switch on the SAME reason the banner is worded from, so the sentence the
  // user reads and the buttons they are given can never describe different
  // states. `cliToolId` gates the whole row rather than each control: every one
  // of them posts to `/special-keys`, which needs a tool to resolve the session
  // name and to validate the key against that tool's vocabulary (Issue #2046).
  // A caller with no tool still gets the frame — seeing the dialog is worth
  // something on its own — and no buttons that could not be delivered.
  const dialogActions = useMemo<React.ReactNode>(() => {
    if (blockedReason === null || !cliToolId) return null;
    const keyProps = {
      worktreeId,
      cliToolId,
      instanceId,
      onKeysSent,
    };
    switch (blockedReason) {
      // A pager and a selection list are both driven by a MOVING HIGHLIGHT, so
      // the verb is a direction and the control is the arrow pad. `showPagerKeys`
      // adds PgUp/PgDn/Home/End/q for the pager, exactly as the footer does.
      case 'pager':
        return <NavigationButtons {...keyProps} showPagerKeys />;
      case 'selectionList':
        return <NavigationButtons {...keyProps} />;
      // Nobody could classify the frame, so nobody can promise it has a
      // highlight to move OR a numbered list to answer. Both pads are offered:
      // the hatch for an overlay that navigates (claude's `/help` tabs), the
      // answer keys for one that asks (#2254 §B's "the yes/no in an unclassified
      // frame"). Deliberately NOT folded into `TerminalEscapeHatch` itself,
      // which is also mounted in the PC footer and on the phone's terminal tab
      // where the vertical budget (#2131 / #2106) is already spoken for.
      case 'unclassified':
        return (
          <div className="space-y-2">
            <TerminalEscapeHatch {...keyProps} />
            <PromptAnswerKeys {...keyProps} />
          </div>
        );
      // A wait IS on screen and its payload carried no options (#1708 / #1725).
      // The answer is a character, and the card above shows which one — the
      // pairing is the point, because `respond <id> yes` is not resolved
      // semantically on a numbered dialog (#1681): Enter takes whatever the CLI
      // highlighted, so a "no" can land as an approval.
      case 'promptUnreadable':
        return (
          <div className="space-y-2">
            <p
              data-testid="chat-surface-unreadable-hint"
              className="text-xs text-muted-foreground"
            >
              {t('chatSurface.unreadableHint')}
            </p>
            <PromptAnswerKeys {...keyProps} />
          </div>
        );
    }
  }, [blockedReason, cliToolId, worktreeId, instanceId, onKeysSent, t]);

  const historyProps = history ?? {};

  return (
    <div
      ref={rootRef}
      data-testid="chat-surface"
      data-instance-id={instanceId ?? cliToolId}
      className={[
        'flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface text-surface-foreground',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Transcript. `relative` so the jump-to-latest chip can float over its
          bottom edge instead of taking height from it — the phone's terminal tab
          has ~33px of vertical budget (Issue #2106) and this surface shares it. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ChatTranscript
          {...historyProps}
          messages={visibleMessages}
          worktreeId={worktreeId}
          cliToolId={cliToolId}
          liveTurn={liveTurn}
          onScrollControlsChange={handleScrollControlsChange}
          className="h-full"
        />
        {/* The chip. It is also the answer to what Issue #2233 gave up: the live
            bubble is in the transcript's flow, so scrolling up carries it off
            screen. While a turn is live and the reader is not at the end, the
            chip wears the spinner and says so in its accessible name, which is
            the one place "still running, below you" can be stated without
            pinning a second copy of the reply to the viewport.

            Issue #2248: a HELD body is below the reader in the same way, so the
            chip still offers the way back — with the plain arrow, because the
            turn it belongs to has already stopped. */}
        {/* [#2283] Withdrawn as soon as the transcript publishes scroll
            controls: it is drawing its own FAB then, and it can put the reader
            on the last ROW rather than at an estimated height. What is left
            here is the way back for a transcript that publishes nothing. */}
        {!hasTranscriptControls && (hasNewBelow || (isLiveTurn && !isAtBottom)) && (
          <button
            type="button"
            data-testid="chat-surface-new-messages"
            data-generating={isGeneratingTurn ? 'true' : undefined}
            onClick={scrollToLatest}
            aria-label={isGeneratingTurn ? t('chatSurface.jumpToLatestGenerating') : undefined}
            className="absolute bottom-3 left-1/2 z-10 flex min-h-[36px] -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
          >
            {isGeneratingTurn ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowDown size={14} aria-hidden="true" />
            )}
            {t('chatSurface.jumpToLatest')}
          </button>
        )}
      </div>

      {/* The footer live region (Issue #2233): the banner, and — since Issue
          #2254 — the dialog card under it. The generating indicator and the
          in-flight body are NOT here; they moved into the transcript's tail.

          This strip is `shrink-0`, so on the phone every pixel it takes comes out
          of the transcript (Issue #2106's budget); it is not rendered at all when
          there is no reason to raise, and the card inside it caps its own height
          and scrolls rather than growing with the frame.

          It is also OUTSIDE the transcript's scroll region, which is what keeps
          #2233's follow-the-tail and the jump-to-latest chip untouched: the chip
          floats `absolute … z-10` inside the `relative` transcript box above,
          and this is a flex sibling below that box, so the two cannot overlap
          however tall the card gets. */}
      {blockedReason !== null && (
        <div
          data-testid="chat-surface-live"
          role="group"
          aria-label={t('chatSurface.liveRegionLabel')}
          className="flex shrink-0 flex-col gap-2 border-t border-border bg-surface px-3 py-2"
        >
          <div
            data-testid="chat-surface-terminal-banner"
            data-reason={blockedReason}
            role="status"
            aria-label={t('chatSurface.bannerLabel')}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-warning-border bg-warning-subtle px-2 py-1.5"
          >
            <span className="min-w-0 flex-1 text-xs text-foreground">
              {t(BLOCKED_REASON_KEY[blockedReason])}
            </span>
            {/* Issue #2254 demoted this from "the only thing you can do" to a
                secondary way out: the dialog is answerable right here now, and
                the terminal is still there for anyone who wants the whole pane
                (scrollback, search, a frame the card's 12–20 rows cut off). */}
            <button
              type="button"
              data-testid="chat-surface-open-terminal"
              onClick={handleOpenTerminal}
              className="flex min-h-[32px] shrink-0 items-center gap-1 rounded-md border border-warning-border bg-surface px-2 py-1 text-xs font-medium text-warning-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
            >
              <TerminalSquare size={14} aria-hidden="true" />
              {t('chatSurface.openTerminal')}
            </button>
          </div>
          {frame ? (
            <ChatDialogCard
              frame={frame}
              reason={blockedReason}
              // Issue #2106: the phone gets the low end of the Issue's 12–20 row
              // window and a shorter box, so the card cannot eat the transcript.
              maxLines={compact ? 12 : undefined}
              maxHeightClassName={compact ? 'max-h-32' : 'max-h-64'}
              actions={dialogActions}
            />
          ) : null}
        </div>
      )}
    </div>
  );
});

export default ChatSurface;
