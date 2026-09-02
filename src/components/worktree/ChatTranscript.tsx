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
  CHAT_ESTIMATED_MESSAGE_HEIGHT_PX,
  CHAT_FALLBACK_RENDER_COUNT,
  CHAT_VIRTUAL_OVERSCAN,
  shouldShowRoleHeader,
} from '@/lib/chat/chat-transcript-view';
import { resolveChatSearchNamespace } from '@/lib/chat/chat-search-namespace';
import { ChatMessageBubble } from './ChatMessageBubble';
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
  const searchableMessages = useMemo(
    () =>
      messages.filter(
        (m) => !m.archived && typeof m.content === 'string' && m.content.length > 0,
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
  // Virtualization
  // ---------------------------------------------------------------
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => CHAT_ESTIMATED_MESSAGE_HEIGHT_PX,
    overscan: CHAT_VIRTUAL_OVERSCAN,
    getItemKey: (index) => messages[index]?.id ?? index,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  // Stable key for the mounted window, so the highlight effect re-runs as rows
  // mount and unmount during scrolling.
  const renderedRange =
    virtualItems.length > 0
      ? `${virtualItems[0].index}-${virtualItems[virtualItems.length - 1].index}`
      : '';

  const messageRowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((message, index) => map.set(message.id, index));
    return map;
  }, [messages]);

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
    if (current > previous && current > 0 && isPinnedToBottomRef.current && !isSearchActive) {
      rowVirtualizer.scrollToIndex(current - 1, { align: 'end' });
    }
  }, [messages.length, isSearchActive, rowVirtualizer]);

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
      const message = messages[index];
      if (!message) return null;
      return (
        <ChatMessageBubble
          message={message}
          showHeader={shouldShowRoleHeader(messages[index - 1], message)}
          onFilePathClick={handleFilePathClick}
          onCopy={handleCopy}
          onInsertToMessage={onInsertToMessage}
          onRetryPending={onRetryPending}
          onDiscardPending={onDiscardPending}
        />
      );
    },
    [messages, handleFilePathClick, handleCopy, onInsertToMessage, onRetryPending, onDiscardPending],
  );

  const renderContent = () => {
    if (isLoading) return <ChatTranscriptLoading />;
    if (messages.length === 0) return <ChatTranscriptEmpty />;

    // [#1123] Zero-measurement fallback. See the file header: without this the
    // transcript is empty on the first paint and in every jsdom test.
    if (virtualItems.length === 0) {
      return (
        <div data-testid="chat-transcript-fallback-list">
          {messages.slice(0, CHAT_FALLBACK_RENDER_COUNT).map((message, index) => (
            <div key={message.id}>{renderRow(index)}</div>
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
