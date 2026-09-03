'use client';

/**
 * ChatTranscript — the chat surface's own transcript (Issue #2232).
 *
 * ## Why a second transcript exists
 *
 * Epic #2192 decided the chat surface would BE `HistoryPane` and that no second
 * transcript would be written (#2193 §3, #2194 §1). Issue #2232 withdrew both
 * decisions after the shipped screen was looked at: it was "the terminal hidden
 * and History widened", not a conversation. The two surfaces want opposite
 * things — a history browser wants many turns per screen and a chat wants the
 * reply — and the numbers say so: with `COLLAPSED_MAX_CHARS = 100`, 25 of this
 * repository's last 26 assistant rows (median 2,478 characters) were shown at
 * roughly 4% of their length.
 *
 * So this renders MESSAGES, not pairs: one bubble each, user right, assistant
 * left, both at `text-sm`, assistant bodies in full with no expand toggle.
 *
 * ## What the second implementation costs, and what it is not allowed to cost
 *
 * `HistoryPane`, `ConversationPairCard` and `lib/history-virtualization` are
 * untouched by this Issue — the History column and the phone's History tab must
 * render byte-identically after it. Consequences visible here:
 *
 *  - the Markdown styling is `.chat-md`, a namespace of its own. `.assistant-md`
 *    is shared with History and `/chat`'s `AssistantMessageList`, so widening it
 *    would change both;
 *  - the `isNearBottom` predicate and the #1123 fallback IDEA are reused, but
 *    the constants are chat's own (`lib/chat/chat-transcript-view`), because a
 *    row here is a message and there it is a pair;
 *  - the search highlight namespace is chat's own (`lib/chat/chat-search-
 *    namespace`), because `CSS.highlights` is one global registry and two
 *    surfaces sharing a key erase each other's marks.
 *
 * ## The #1123 fallback is not optional
 *
 * `@tanstack/react-virtual` materializes ZERO rows while the scroll element
 * measures 0px — which is the first render before the layout effect, SSR, and
 * every jsdom test. Without the plain-flow fallback the transcript is an empty
 * box in all three. See `CHAT_FALLBACK_RENDER_COUNT`.
 *
 * ## Chrome
 *
 * No "Message History" title, no display-limit select, no archived checkbox, no
 * user-only toggle — those are a browser's controls and this is a conversation.
 * Search survives, because chat can search today and removing it would be a
 * regression; it is a single icon floating over the top-right of the column,
 * which is also why it costs the transcript no height (the phone's vertical
 * budget, Issue #2106).
 *
 * ## The live tail (Issue #2233)
 *
 * `liveTurn` is the reply currently being written. It is rendered INSIDE the
 * scroll container and OUTSIDE the virtualizer, and both halves are the point:
 *
 *  - inside the scroll container, so the in-flight body and the settled row that
 *    replaces it occupy the same place in the same column. Issue #2199 drew it
 *    in a footer strip, so completing a turn moved the paragraph to a different
 *    part of the screen in a different typeface;
 *  - outside the virtual list, because `@tanstack/react-virtual` unmounts every
 *    row beyond the visible window. A "generating" row at index `n-1` vanishes
 *    the moment the reader scrolls up — which is exactly why Issue #2194 put it
 *    in a footer in the first place, and that reason has not expired. It is
 *    a plain sibling after the sizer, so no `virtualItems` entry ever describes
 *    it and no scroll position can unmount it.
 *
 * What it costs: scrolling up moves the bubble off screen, because it is in the
 * flow rather than pinned to the viewport. That is answered by putting the
 * spinner on the jump control — `ChatSurface`'s chip until Issue #2283, and the
 * FAB below since.
 *
 * ## A ROW is no longer a MESSAGE (Issue #2245)
 *
 * `messageType === 'prompt'` rows are approval dialogs written by the poller,
 * Auto-Yes and the permission hook — 41 of the last 50 rows on one live worktree,
 * 43 on another — and this component used to draw each of them as an assistant
 * reply carrying the whole pane. They are now chips, and a RUN of them is one
 * collapsed row. So the virtualizer counts `rows`, not `messages`, and
 * `buildChatTranscriptRows` is the only place that mapping exists.
 *
 * The live tail is deliberately not part of that: it is still keyed off
 * `messages`, because a chip row has no in-flight form.
 *
 * ## Where the reader lands, and how they get to either end (Issue #2283)
 *
 * Two facts about this transcript make "scroll to the bottom" a hard problem
 * rather than a one-liner:
 *
 *  - a row is not 120px. `CHAT_ESTIMATED_MESSAGE_HEIGHT_PX` is what the
 *    virtualizer assumes before anything is measured, and on the worktree this
 *    Issue was filed against 13 of 208 rows were over 200 lines, the tallest
 *    33,476px. Any `scrollTop = scrollHeight` therefore aims at a height that
 *    is still mostly ESTIMATED, and is left behind — 7,770px short, measured —
 *    the moment the real tail is measured;
 *  - the rows that carry those measurements only mount once a previous aim
 *    brought them into the window, so the correction arrives AFTER
 *    `@tanstack/virtual-core` 3.16 has finished reconciling the scroll it was
 *    given (its `reconcileScroll` gives up after one stable frame).
 *
 * So the tail is not a position to jump to but a place to be HELD: see
 * `anchorToTail`. And because holding the tail is only possible from inside the
 * component that owns the virtualizer, this is also where the jump control
 * lives (the FAB, following the terminal surface's #1079 button) and where the
 * two ends are published from, for a parent that would otherwise write
 * `scrollTop` (see {@link ChatTranscriptScrollControls}).
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'next-intl';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Loader2, MessageSquare, Search } from 'lucide-react';
import { Skeleton } from '@/components/ui';
import type { ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { ShowToast } from '@/types/markdown-editor';
import { useHistorySearch } from '@/hooks/useHistorySearch';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { applyHistoryHighlights, clearHistoryHighlights } from '@/lib/terminal-highlight';
import { isNearBottom } from '@/lib/history-virtualization';
import {
  buildChatTranscriptRows,
  CHAT_ESTIMATED_MESSAGE_HEIGHT_PX,
  CHAT_FALLBACK_RENDER_COUNT,
  CHAT_VIRTUAL_OVERSCAN,
  shouldShowLiveRoleHeader,
} from '@/lib/chat/chat-transcript-view';
import { isToolApprovalMessage } from '@/lib/chat/chat-tool-approvals';
import { resolveChatSearchNamespace } from '@/lib/chat/chat-search-namespace';
import {
  CHAT_BUBBLE_ASSISTANT_CLASS,
  CHAT_BUBBLE_MARKDOWN_BODY_CLASS,
  CHAT_BUBBLE_ROW_CLASS,
  ChatMarkdownBody,
  ChatMessageBubble,
  ChatToolApprovalGroup,
} from './ChatMessageBubble';
import { CHAT_LIVE_TURN_TESTID, ChatLiveTurnBubble } from './ChatLiveTurnBubble';
import { HistorySearchBar } from './HistorySearchBar';

// ============================================================================
// Constants
// ============================================================================

/**
 * The scroll region's testid.
 *
 * `ChatSurface` follows the tail by resolving this element through the DOM (it
 * owns no ref into here), so the string is a contract between the two
 * components that the type checker cannot see — which is why it is exported and
 * pinned by a seam test rather than written twice.
 */
export const CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID = 'chat-transcript-scroll-container';

/**
 * The scroll-to-either-end FAB's testid (Issue #2283).
 *
 * One button, two states — see the file header. Exported because both this
 * component's suite and the surface above it need to assert that exactly ONE
 * jump control is on screen at a time.
 */
export const CHAT_TRANSCRIPT_JUMP_FAB_TESTID = 'chat-transcript-jump-fab';

/**
 * Animation-frame ceiling for the tail anchor (Issue #2283).
 *
 * The real transcript converged in six frames. Twelve leaves room for a longer
 * measurement cascade without letting a pathological one hold the scroll
 * position hostage; {@link CHAT_TAIL_ANCHOR_MAX_MS} is the second, independent
 * ceiling, because frames stop arriving in a background tab.
 */
const CHAT_TAIL_ANCHOR_MAX_FRAMES = 12;

/**
 * Consecutive frames with an unchanged total height that end the anchor. Two
 * would be enough for the measurements themselves; three absorbs the frame
 * `reconcileScroll` spends on its own stability check.
 */
const CHAT_TAIL_ANCHOR_STABLE_FRAMES = 3;

/** Wall-clock ceiling for one anchor run, in ms. */
const CHAT_TAIL_ANCHOR_MAX_MS = 600;

/**
 * The jump FAB's classes (Issue #2283).
 *
 * 36px square, so it clears the phone's tap-target floor with
 * `touch-manipulation`; `absolute`, so — like the search toggle it sits under —
 * it spends none of the transcript's height, which is what Issue #2106's
 * vertical budget requires of everything on this surface.
 */
const CHAT_JUMP_FAB_CLASS = [
  'absolute bottom-3 right-3 z-10 flex h-9 w-9 items-center justify-center rounded-full',
  'border border-border bg-surface-2/80 text-muted-foreground shadow-lg backdrop-blur',
  'transition-colors hover:bg-muted hover:text-foreground',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation',
].join(' ');

// ============================================================================
// Types
// ============================================================================

/**
 * The turn being generated right now (Issue #2233).
 *
 * A description of a state rather than a rendered node, so the transcript owns
 * the bubble's markup and cannot be handed something shaped differently from the
 * settled rows around it. Every field is optional because the weakest case is
 * real: `live.isRunning` with no progress body at all is what codex,
 * antigravity and vibe-local produce, and it still has to say "responding" in
 * this exact position.
 */
export interface ChatTranscriptLiveTurn {
  /** The `requestId` the settled row will carry; published as `data-turn-key`. */
  turnKey?: string;
  /** The progress frame counter behind `body`; published as `data-version`. */
  version?: number;
  /** The reply so far. Absent / empty renders the indicator alone. */
  body?: string;
  /** True when `body` does not start at the beginning of the turn (#2199). */
  partial?: boolean;
  /** The CLI is painting a thinking indicator rather than a plain "generating". */
  isThinking?: boolean;
  /**
   * Issue #2248: the turn has stopped and this body is being held until its
   * saved row arrives. Drawn by {@link ChatSettlingTurnBubble} instead of
   * {@link ChatLiveTurnBubble} — same bubble, no spinner, no "Responding…".
   */
  settling?: boolean;
}

/**
 * The two ends of the transcript, reachable through the virtualizer (#2283).
 *
 * `ChatSurface` holds no ref into this component and resolves the scroll
 * element by selector, so its own way back to the tail was
 * `scrollTop = scrollHeight` — which lands short for exactly the reason the
 * file header describes. These callbacks are how it borrows the virtualizer
 * instead, leaving ONE implementation of "the tail" in the one component that
 * can measure it.
 */
export interface ChatTranscriptScrollControls {
  /** Land on the last row and hold there while its height is measured. */
  scrollToLatest: () => void;
  /** Land on the first row and release the tail anchor. */
  scrollToTop: () => void;
}

/** One in-flight run of the tail anchor (Issue #2283). */
interface TailAnchorRun {
  /** The pending `requestAnimationFrame` handle, or null between frames. */
  frame: number | null;
  /** Frames elapsed, against {@link CHAT_TAIL_ANCHOR_MAX_FRAMES}. */
  frames: number;
  /** Frames with an unchanged total height, against the stable-frame ceiling. */
  stableFrames: number;
  /** The total height the last aim was taken against. */
  totalSize: number;
  /** `Date.now()` past which the run ends however the frames are going. */
  deadline: number;
}

export interface ChatTranscriptProps {
  /** The transcript, chronologically ordered. NOT grouped into pairs. */
  messages: ChatMessage[];
  worktreeId: string;
  /** Metadata only — the messages are already filtered by the caller's fetch. */
  cliToolId?: CLIToolType;
  isLoading?: boolean;
  className?: string;
  onFilePathClick?: (path: string) => void;
  showToast?: ShowToast;
  onInsertToMessage?: (content: string) => void;
  /** Issue #1121: re-send an optimistic message whose send failed. */
  onRetryPending?: (tempId: string) => void;
  /** Issue #1121: discard an optimistic message whose send failed. */
  onDiscardPending?: (tempId: string) => void;
  /**
   * Issue #744's per-split highlight isolation, applied to chat's own namespace.
   * Omit on the phone / a single mount.
   */
  splitIndex?: number;
  /**
   * Issue #2233: the turn being generated, drawn as the last bubble in the
   * column. `null` / omitted means nothing is running. See the file header for
   * why it is neither a virtualized row nor a footer.
   */
  liveTurn?: ChatTranscriptLiveTurn | null;
  /**
   * Issue #2283: published on mount and withdrawn on unmount, so a parent can
   * jump this transcript through the VIRTUALIZER rather than by writing
   * `scrollTop`. See {@link ChatTranscriptScrollControls}.
   */
  onScrollControlsChange?: (controls: ChatTranscriptScrollControls | null) => void;
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * The transcript's ONE loading state (Issue #2232).
 *
 * Before this, `HistoryPane` drew a card skeleton and `ChatSurface` drew its own
 * hint line, so the chat surface could show two different "nothing here yet"
 * statements at once. Bubble-shaped, alternating sides, so the loaded layout
 * does not jump.
 */
function ChatTranscriptLoading() {
  const t = useTranslations('worktree');
  return (
    <div data-testid="chat-transcript-loading" role="status" aria-label={t('chatTranscript.loading')}>
      {[0, 1, 2].map((i) => (
        <div key={i} className={`mb-4 flex flex-col gap-1 ${i % 2 === 0 ? 'items-end' : 'items-start'}`}>
          <Skeleton className="h-3 w-24" />
          <Skeleton className={`h-14 rounded-2xl ${i % 2 === 0 ? 'w-2/3' : 'w-11/12'}`} />
        </div>
      ))}
    </div>
  );
}

/**
 * A body that has stopped growing and has no saved row yet (Issue #2248).
 *
 * ## Why this is a second component and not a flag on `ChatLiveTurnBubble`
 *
 * The two states differ in exactly one row of markup — the live bubble's
 * spinner-and-"Responding…" line is replaced by a single quiet label — and in
 * nothing else. Everything the reader looks at is the SAME: the same
 * {@link CHAT_BUBBLE_ROW_CLASS} row, the same {@link CHAT_BUBBLE_ASSISTANT_CLASS}
 * bubble, the same {@link CHAT_BUBBLE_MARKDOWN_BODY_CLASS} body through the same
 * Markdown renderer, in the same place in the same column. That is Issue #2233's
 * rule and this Issue inherits it: a turn ending must not move a paragraph or
 * change its typeface, and neither must its row finally landing.
 *
 * Because the class strings are shared constants rather than copies, the drift
 * that a duplicated bubble would normally invite cannot happen silently — and
 * `ChatTranscript-settling-2248.test.tsx` compares the two rendered class
 * strings to each other anyway.
 *
 * ## What it must not say
 *
 * No spinner and no `chatSurface.generating`. Issue #2238's defect was a surface
 * that claimed to be responding when nothing was running, and a hold is exactly
 * the state where that claim would be false. `data-settling="true"` is on the
 * row so the real screen and an E2E run can tell the two apart without reading
 * prose (`data-turn-key` / `data-version` were already there).
 */
function ChatSettlingTurnBubble({
  turnKey,
  version,
  body,
  partial = false,
  showHeader = false,
  onFilePathClick,
}: {
  turnKey?: string;
  version?: number;
  body?: string;
  partial?: boolean;
  showHeader?: boolean;
  onFilePathClick: (path: string) => void;
}) {
  const t = useTranslations('worktree');
  const hasBody = typeof body === 'string' && body.length > 0;

  return (
    <div
      data-testid={CHAT_LIVE_TURN_TESTID}
      data-role="assistant"
      data-settling="true"
      data-turn-key={turnKey}
      data-version={version === undefined ? undefined : String(version)}
      data-has-body={hasBody ? 'true' : 'false'}
      role="group"
      aria-label={t('chatSurface.settlingLabel')}
      className={CHAT_BUBBLE_ROW_CLASS}
    >
      {showHeader && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span className="font-medium">{t('conversation.assistant')}</span>
        </div>
      )}

      <div className={CHAT_BUBBLE_ASSISTANT_CLASS}>
        {hasBody && (
          <div
            data-testid="chat-live-turn-body"
            data-markdown="true"
            className={CHAT_BUBBLE_MARKDOWN_BODY_CLASS}
          >
            <ChatMarkdownBody content={body as string} onFilePathClick={onFilePathClick} />
          </div>
        )}

        {/* Under the body, in the live bubble's place, so the label swapping for
            the spinner moves nothing above it. Not an `aria-live` region: the
            turn is over, and there is nothing left to announce. */}
        <div
          data-testid="chat-settling-turn-note"
          className={[
            'flex flex-wrap items-center gap-2 text-xs text-muted-foreground',
            hasBody ? 'mt-1.5' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span>{t('chatSurface.settling')}</span>
          {partial && (
            <span
              data-testid="chat-live-turn-partial"
              className="rounded border border-warning-border bg-warning-subtle px-1 py-0.5 text-warning-foreground"
            >
              {t('chatSurface.progressPartial')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The transcript's ONE empty state. */
function ChatTranscriptEmpty() {
  const t = useTranslations('worktree');
  return (
    <div
      data-testid="chat-transcript-empty"
      className="flex flex-col items-center justify-center gap-1 py-10 text-center text-muted-foreground"
    >
      <MessageSquare className="mb-1 h-10 w-10 opacity-50" aria-hidden="true" />
      <p className="text-sm">{t('chatTranscript.empty')}</p>
      <p className="text-xs">{t('chatTranscript.emptyHint')}</p>
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

export const ChatTranscript = memo(function ChatTranscript({
  messages,
  worktreeId,
  cliToolId: _cliToolId,
  isLoading = false,
  className = '',
  onFilePathClick,
  showToast,
  onInsertToMessage,
  onRetryPending,
  onDiscardPending,
  splitIndex,
  liveTurn = null,
  onScrollControlsChange,
}: ChatTranscriptProps) {
  const t = useTranslations('worktree');
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const highlightNamespace = useMemo(
    () => resolveChatSearchNamespace(splitIndex),
    [splitIndex],
  );

  /** Whether the view is pinned to the newest message (follow mode). */
  const isPinnedToBottomRef = useRef(true);
  /** Previous rendered row count, to detect appended messages. */
  const prevRowCountRef = useRef(-1);
  /**
   * Previous `isLoading` (Issue #2283). The skeleton being replaced by the list
   * changes no message count, so without this the commonest way of arriving at
   * a full transcript — a fetch resolving — looks like "nothing happened".
   */
  const prevIsLoadingRef = useRef(isLoading);
  /**
   * The row count, readable from inside an animation frame (Issue #2283), where
   * the `rows` closure belongs to whichever render scheduled the frame.
   */
  const rowCountRef = useRef(0);
  /**
   * Which end the FAB offers. In STATE, unlike `isPinnedToBottomRef`, because
   * the button has to re-render on it; the ref stays the one the layout effects
   * and animation frames read, since they run before React commits.
   */
  const [isAtTail, setIsAtTail] = useState(true);

  // ---------------------------------------------------------------
  // Search (Issue #716's hook, one stage shorter)
  // ---------------------------------------------------------------
  // `HistoryMatch` was always keyed by messageId; History had to translate
  // messageId → pairId → row index because its rows are pairs. Here a row IS a
  // message, so the translation is a single map.
  //
  // [#2245] Approval rows are excluded. Their `content` is the pane dump this
  // Issue stopped rendering, so a hit inside one could not be highlighted (there
  // is no `data-message-id` element to mark) and every search for a command name
  // would land on dozens of invisible rows before reaching the reply that
  // mentions it.
  const searchableMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          !m.archived &&
          !isToolApprovalMessage(m) &&
          typeof m.content === 'string' &&
          m.content.length > 0,
      ),
    [messages],
  );

  const {
    isOpen: isSearchOpen,
    query: searchQuery,
    matchCount,
    currentIndex,
    isAtMaxMatches,
    matchPositions,
    currentMatch,
    openSearch,
    closeSearch,
    setQuery: setSearchQuery,
    onCompositionStart,
    onCompositionEnd,
    nextMatch,
    prevMatch,
  } = useHistorySearch({ messages: searchableMessages });

  const isSearchActive = isSearchOpen && matchPositions.length > 0;

  // Reset search when the worktree context changes.
  useEffect(() => {
    closeSearch();
    // Intentionally excludes closeSearch: reset only on worktree change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  // ---------------------------------------------------------------
  // Rows (Issue #2245)
  // ---------------------------------------------------------------
  // Bubbles and folded approval groups, in transcript order. Also the only
  // place `showHeader` is decided, so a chip group cannot change how many
  // "Assistant" labels the column carries.
  const rows = useMemo(() => buildChatTranscriptRows(messages), [messages]);
  rowCountRef.current = rows.length;

  // ---------------------------------------------------------------
  // Virtualization
  // ---------------------------------------------------------------
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => CHAT_ESTIMATED_MESSAGE_HEIGHT_PX,
    overscan: CHAT_VIRTUAL_OVERSCAN,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  // Stable key for the mounted window, so the highlight effect re-runs as rows
  // mount and unmount during scrolling.
  const renderedRange =
    virtualItems.length > 0
      ? `${virtualItems[0].index}-${virtualItems[virtualItems.length - 1].index}`
      : '';

  // messageId → ROW index. A search match names a message; the virtualizer
  // scrolls to a row, and since #2245 those are no longer the same number.
  const messageRowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.kind === 'message') map.set(row.message.id, index);
      else for (const entry of row.entries) for (const id of entry.messageIds) map.set(id, index);
    });
    return map;
  }, [rows]);

  // ---------------------------------------------------------------
  // Holding the tail (Issue #2283)
  // ---------------------------------------------------------------
  // A single `scrollToIndex(last, 'end')` does not land on the last row of a
  // transcript whose rows have never been measured — see the file header. So
  // the aim is REPEATED while the total height keeps moving under it, and the
  // run ends on the first of three things: three frames with an unchanged
  // total, {@link CHAT_TAIL_ANCHOR_MAX_FRAMES} frames, or
  // {@link CHAT_TAIL_ANCHOR_MAX_MS} of wall clock. The real transcript
  // converged in six frames.
  //
  // `scrollToIndex`, never `scrollTop = scrollHeight`: only the virtualizer
  // knows where an unmeasured row ENDS, and the direct assignment is what
  // stopped 7,770px short.
  const tailAnchorRef = useRef<TailAnchorRun | null>(null);

  const stopTailAnchor = useCallback(() => {
    const run = tailAnchorRef.current;
    tailAnchorRef.current = null;
    if (run && run.frame !== null) cancelAnimationFrame(run.frame);
  }, []);

  const anchorToTail = useCallback(() => {
    stopTailAnchor();
    const lastIndex = rowCountRef.current - 1;
    if (lastIndex < 0) return;
    rowVirtualizer.scrollToIndex(lastIndex, { align: 'end' });
    // SSR / a jsdom environment without frames still gets the aim above; only
    // the correction needs a frame loop.
    if (typeof requestAnimationFrame !== 'function') return;

    const run: TailAnchorRun = {
      frame: null,
      frames: 0,
      stableFrames: 0,
      totalSize: rowVirtualizer.getTotalSize(),
      deadline: Date.now() + CHAT_TAIL_ANCHOR_MAX_MS,
    };
    const step = () => {
      run.frame = null;
      // A newer run, or an unmount, has taken over.
      if (tailAnchorRef.current !== run) return;
      run.frames += 1;
      const index = rowCountRef.current - 1;
      if (
        index < 0 ||
        !isPinnedToBottomRef.current ||
        run.frames > CHAT_TAIL_ANCHOR_MAX_FRAMES ||
        Date.now() > run.deadline
      ) {
        tailAnchorRef.current = null;
        return;
      }
      const totalSize = rowVirtualizer.getTotalSize();
      if (totalSize === run.totalSize) {
        run.stableFrames += 1;
        if (run.stableFrames >= CHAT_TAIL_ANCHOR_STABLE_FRAMES) {
          tailAnchorRef.current = null;
          return;
        }
      } else {
        run.stableFrames = 0;
        run.totalSize = totalSize;
        rowVirtualizer.scrollToIndex(index, { align: 'end' });
      }
      run.frame = requestAnimationFrame(step);
    };
    tailAnchorRef.current = run;
    run.frame = requestAnimationFrame(step);
  }, [rowVirtualizer, stopTailAnchor]);

  useEffect(() => stopTailAnchor, [stopTailAnchor]);

  const scrollToLatest = useCallback(() => {
    isPinnedToBottomRef.current = true;
    setIsAtTail(true);
    anchorToTail();
  }, [anchorToTail]);

  const scrollToTop = useCallback(() => {
    // Explicitly UNPINNED: the reader asked for the beginning of the
    // conversation, and the next message arriving must not drag them back down
    // (Issue #2283). The anchor is cancelled rather than left to notice, so it
    // cannot re-aim between here and the reader's next scroll.
    stopTailAnchor();
    isPinnedToBottomRef.current = false;
    setIsAtTail(false);
    if (rowCountRef.current > 0) rowVirtualizer.scrollToIndex(0, { align: 'start' });
  }, [rowVirtualizer, stopTailAnchor]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const pinned = isNearBottom({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    });
    // [#2283] While an anchor run is in flight the only scrolls are its own,
    // and its intermediate frames are BY CONSTRUCTION short of the bottom —
    // that gap is what it exists to close. Reading one of them as "the reader
    // scrolled up" is how the run would cancel itself one frame in and leave
    // the view exactly where the bug report found it.
    if (!pinned && tailAnchorRef.current !== null) return;
    isPinnedToBottomRef.current = pinned;
    setIsAtTail(pinned);
  }, []);

  // Land on the tail, and stay there while the rows are measured.
  //
  // [#2283] THREE things put the tail in front of the reader, and only the
  // third was handled before this Issue:
  //
  //  1. the transcript MOUNTING onto a history that is already there — which is
  //     what the terminal → chat toggle does. The `previous === -1` baseline
  //     return this replaced meant that path aimed at nothing at all, so the
  //     toggle landed wherever the estimated-height sizer happened to put it:
  //     scrollTop 33,060 of 59,044, around the third of 208 rows;
  //  2. the loading skeleton being replaced by the list. No message count
  //     changes across that swap, so an append-shaped condition cannot see it;
  //  3. messages being appended, which is what the effect already followed.
  //
  // Skipped during an active search so the match's own `scrollToIndex` is not
  // overridden — #1123's rule, inherited from `HistoryPane`.
  useLayoutEffect(() => {
    const previousCount = prevRowCountRef.current;
    const wasLoading = prevIsLoadingRef.current;
    const current = messages.length;
    prevRowCountRef.current = current;
    prevIsLoadingRef.current = isLoading;

    if (isLoading || isSearchActive || rows.length === 0) return;
    if (!isPinnedToBottomRef.current) return;
    // Triggered by a new MESSAGE and aimed at the last ROW: an approval that
    // folds into an existing group adds no row, and the tail to follow is
    // whatever the row list ends with.
    const isFirstRenderableList = previousCount === -1 || wasLoading;
    if (!isFirstRenderableList && current <= previousCount) return;
    anchorToTail();
  }, [messages.length, rows.length, isLoading, isSearchActive, anchorToTail]);

  // Publish the two ends, so the surface above can borrow the virtualizer
  // instead of writing `scrollTop` (Issue #2283). Withdrawn on unmount, so a
  // parent cannot hold a closure over a dead virtualizer — and so a parent that
  // renders something else in this slot (every `ChatSurface` suite that stubs
  // this component) is told it has no controls and keeps its own fallback.
  useEffect(() => {
    if (!onScrollControlsChange) return;
    onScrollControlsChange({ scrollToLatest, scrollToTop });
    return () => onScrollControlsChange(null);
  }, [onScrollControlsChange, scrollToLatest, scrollToTop]);

  // Home / End on the transcript itself (Issue #2283). `tabIndex={0}` below is
  // what makes the scroll region focusable at all — without it the browser
  // routes these keys to the document and the transcript never sees them.
  // Neither key is in `KEYBOARD_SHORTCUTS`, so nothing else is claiming them; a
  // typing target is still left alone, where Home/End mean start/end of the
  // text.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Home' && event.key !== 'End') return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (rowCountRef.current === 0) return;
      event.preventDefault();
      if (event.key === 'End') scrollToLatest();
      else scrollToTop();
    },
    [scrollToLatest, scrollToTop],
  );

  // Materialize the current match's row before the highlight effect goes
  // looking for its DOM node: an off-screen row is unmounted and cannot be
  // queried. Changing the mounted window bumps `renderedRange`, which re-runs
  // the effect below.
  useEffect(() => {
    if (!isSearchOpen || !currentMatch) return;
    const rowIndex = messageRowIndexById.get(currentMatch.messageId);
    if (rowIndex === undefined) return;
    rowVirtualizer.scrollToIndex(rowIndex, { align: 'center' });
  }, [isSearchOpen, currentMatch, messageRowIndexById, rowVirtualizer]);

  // Apply per-message highlights to whatever is mounted, and bring the current
  // match into view.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (!isSearchOpen || matchPositions.length === 0) {
      clearHistoryHighlights(highlightNamespace);
      return;
    }

    let currentMatchElement: HTMLElement | null = null;
    for (const match of matchPositions) {
      const element = container.querySelector(
        `[data-message-id="${CSS.escape(match.messageId)}"]`,
      );
      if (!element) continue; // row not mounted yet; applied on its next mount
      const isCurrent = currentMatch?.messageId === match.messageId;
      applyHistoryHighlights(
        element,
        match.ranges,
        isCurrent ? currentMatch.localIndex : -1,
        highlightNamespace,
      );
      if (isCurrent && element instanceof HTMLElement) currentMatchElement = element;
    }

    if (currentMatchElement && typeof currentMatchElement.scrollIntoView === 'function') {
      currentMatchElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    return () => {
      clearHistoryHighlights(highlightNamespace);
    };
  }, [isSearchOpen, matchPositions, currentMatch, highlightNamespace, renderedRange]);

  // ---------------------------------------------------------------
  // Row rendering
  // ---------------------------------------------------------------
  const handleFilePathClick = useCallback(
    (path: string) => onFilePathClick?.(path),
    [onFilePathClick],
  );

  // `t` churns identity on every render (#1219 / #1032) and this callback is
  // handed to a memoized bubble for every mounted row, so it is read through a
  // ref: stable identity, toast text still resolved fresh at click time.
  const tRef = useRef(t);
  tRef.current = t;

  const handleCopy = useCallback(
    async (content: string) => {
      try {
        await copyToClipboard(content);
        showToast?.(tRef.current('history.copied'), 'success');
      } catch {
        showToast?.(tRef.current('history.copyFailed'), 'error');
      }
    },
    [showToast],
  );

  const renderRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return null;
      if (row.kind === 'approvals') {
        return <ChatToolApprovalGroup entries={row.entries} />;
      }
      return (
        <ChatMessageBubble
          message={row.message}
          showHeader={row.showHeader}
          onFilePathClick={handleFilePathClick}
          onCopy={handleCopy}
          onInsertToMessage={onInsertToMessage}
          onRetryPending={onRetryPending}
          onDiscardPending={onDiscardPending}
        />
      );
    },
    [rows, handleFilePathClick, handleCopy, onInsertToMessage, onRetryPending, onDiscardPending],
  );

  // Issue #2248: a HELD body is below the reader exactly as a live one is, so
  // the way back is still offered — but "still responding" would be a lie about
  // a turn that has already stopped, so only a non-settling tail earns the
  // spinner. Issue #2283 moved this verdict here with the control it dresses.
  const isGeneratingTurn = liveTurn !== null && liveTurn.settling !== true;

  const renderContent = () => {
    if (isLoading) return <ChatTranscriptLoading />;
    // "No messages yet" under a bubble that is visibly being written is a lie
    // the reader can see. The live tail below is the content in that case.
    if (rows.length === 0) return liveTurn ? null : <ChatTranscriptEmpty />;

    // [#1123] Zero-measurement fallback. See the file header: without this the
    // transcript is empty on the first paint and in every jsdom test.
    if (virtualItems.length === 0) {
      return (
        <div data-testid="chat-transcript-fallback-list">
          {rows.slice(0, CHAT_FALLBACK_RENDER_COUNT).map((row, index) => (
            <div key={row.key}>{renderRow(index)}</div>
          ))}
        </div>
      );
    }

    return (
      <div
        style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}
      >
        {virtualItems.map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={rowVirtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {renderRow(virtualRow.index)}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      data-testid="chat-transcript"
      role="log"
      aria-label={t('chatTranscript.regionLabel')}
      className={['relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-surface', className]
        .filter(Boolean)
        .join(' ')}
    >
      {/* The scroll region is the ONLY thing in the flow. Everything else floats
          over it, so the surface spends none of the phone's vertical budget
          (Issue #2106) on chrome. `min-h-0` is what lets it shrink inside the
          flex column instead of pushing its parent taller. */}
      <div
        ref={scrollContainerRef}
        data-testid={CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        // [#2283] Focusable, which is the whole reason Home/End can reach the
        // handler above. `TerminalDisplay` has carried the same `tabIndex={0}`
        // on its own scroll region since #1079.
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3"
      >
        {renderContent()}

        {/* [#2233] The live tail. A plain sibling of the list — never an entry
            in `virtualItems` — so no scroll position can unmount it, and inside
            the scroll region so it sits exactly where its settled row will.

            [#2248] Two bubbles, one position: while the turn is generating, and
            then while its body is HELD waiting for the saved row. The second
            wears the same classes with the spinner and "Responding…" taken off,
            so the turn ending changes nothing on screen but that one line. */}
        {liveTurn &&
          (liveTurn.settling ? (
            <ChatSettlingTurnBubble
              turnKey={liveTurn.turnKey}
              version={liveTurn.version}
              body={liveTurn.body}
              partial={liveTurn.partial}
              showHeader={shouldShowLiveRoleHeader(messages[messages.length - 1])}
              onFilePathClick={handleFilePathClick}
            />
          ) : (
            <ChatLiveTurnBubble
              turnKey={liveTurn.turnKey}
              version={liveTurn.version}
              body={liveTurn.body}
              partial={liveTurn.partial}
              isThinking={liveTurn.isThinking}
              showHeader={shouldShowLiveRoleHeader(messages[messages.length - 1])}
              onFilePathClick={handleFilePathClick}
            />
          ))}
      </div>

      {/* [#2283] One circular button for both ends of the conversation,
          following the terminal surface's #1079 FAB: at the tail it offers the
          BEGINNING, anywhere else it offers the end. Never a `scrollTop`
          assignment — both directions go through the virtualizer, and the down
          direction goes through the anchor, because the tail of an unmeasured
          list is not a number this component can name yet.

          It is also where Issue #2233's "still responding, below you" lands
          while this transcript is the one on screen. The live bubble sits in
          the flow, so scrolling up carries it off; the spinner here is the one
          place that fact can be stated without pinning a second copy of the
          reply to the viewport. `ChatSurface` withdraws its own chip as soon as
          this component publishes its scroll controls, so the reader is never
          offered two ways back at once. */}
      {rows.length > 0 &&
        (isAtTail ? (
          <button
            type="button"
            data-testid={CHAT_TRANSCRIPT_JUMP_FAB_TESTID}
            data-direction="top"
            onClick={scrollToTop}
            aria-label={t('chatTranscript.jumpToTop')}
            title={t('chatTranscript.jumpToTop')}
            className={CHAT_JUMP_FAB_CLASS}
          >
            <ArrowUp size={16} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            data-testid={CHAT_TRANSCRIPT_JUMP_FAB_TESTID}
            data-direction="latest"
            data-generating={isGeneratingTurn ? 'true' : undefined}
            onClick={scrollToLatest}
            aria-label={
              isGeneratingTurn
                ? t('chatSurface.jumpToLatestGenerating')
                : t('chatSurface.jumpToLatest')
            }
            title={
              isGeneratingTurn
                ? t('chatSurface.jumpToLatestGenerating')
                : t('chatSurface.jumpToLatest')
            }
            className={CHAT_JUMP_FAB_CLASS}
          >
            {isGeneratingTurn ? (
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowDown size={16} aria-hidden="true" />
            )}
          </button>
        ))}

      {/* Search: one icon, or the bar once it is open. Absolutely positioned so
          opening it never reflows the transcript under the reader. */}
      <div className="pointer-events-none absolute right-2 top-2 z-10 flex justify-end">
        <div className="pointer-events-auto">
          {isSearchOpen ? (
            <HistorySearchBar
              query={searchQuery}
              onQueryChange={setSearchQuery}
              matchCount={matchCount}
              currentIndex={currentIndex}
              onNext={nextMatch}
              onPrev={prevMatch}
              onClose={closeSearch}
              isAtMaxMatches={isAtMaxMatches}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
            />
          ) : (
            <button
              type="button"
              data-testid="chat-transcript-search-toggle"
              onClick={openSearch}
              aria-label={t('chatTranscript.openSearch')}
              title={t('chatTranscript.openSearch')}
              className="rounded-full border border-border bg-surface-2/80 p-1.5 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
            >
              <Search size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

export default ChatTranscript;
