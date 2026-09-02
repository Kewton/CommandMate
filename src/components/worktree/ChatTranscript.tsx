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
 * flow rather than pinned to the viewport. `ChatSurface` answers that by putting
 * the spinner on its jump-to-latest chip while a turn is live.
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
 */

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageSquare, Search } from 'lucide-react';
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

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    isPinnedToBottomRef.current = isNearBottom({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    });
  }, []);

  // Follow appended messages while pinned. Skipped during an active search so
  // the match's own scrollToIndex is not overridden — the same rule #1123 gave
  // HistoryPane, and the reason it is here rather than left entirely to
  // ChatSurface: only the virtualizer can land on a row whose height has not
  // been measured yet.
  useLayoutEffect(() => {
    const previous = prevRowCountRef.current;
    const current = messages.length;
    prevRowCountRef.current = current;
    if (previous === -1) return; // first render establishes the baseline
    // Triggered by a new MESSAGE and aimed at the last ROW: an approval that
    // folds into an existing group adds no row, and the tail to follow is
    // whatever the row list ends with.
    if (current > previous && rows.length > 0 && isPinnedToBottomRef.current && !isSearchActive) {
      rowVirtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    }
  }, [messages.length, rows.length, isSearchActive, rowVirtualizer]);

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
