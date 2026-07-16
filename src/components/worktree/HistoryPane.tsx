/**
 * HistoryPane Component
 *
 * Displays message history grouped as conversation pairs.
 * Each pair shows a user message with its corresponding assistant response(s).
 * Supports file path detection and click handling.
 *
 * [Issue #716] Adds in-pane text search with namespace-isolated highlighting.
 */

'use client';

import React, { useMemo, useCallback, memo, useRef, useLayoutEffect, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, User, UserCheck, ChevronRight } from 'lucide-react';
import { Checkbox, Skeleton } from '@/components/ui';
import type { ChatMessage } from '@/types/models';
import { useConversationHistory } from '@/hooks/useConversationHistory';
import { useHistorySearch } from '@/hooks/useHistorySearch';
import { ConversationPairCard } from './ConversationPairCard';
import { HistorySearchBar } from './HistorySearchBar';
import { HISTORY_PANE_ID } from './TerminalContainer';
import { copyToClipboard } from '@/lib/clipboard-utils';
import {
  applyHistoryHighlights,
  clearHistoryHighlights,
  makeHistoryNamespace,
  HISTORY_SEARCH_NAMESPACE,
  type HighlightNamespace,
} from '@/lib/terminal-highlight';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  HISTORY_DISPLAY_LIMIT_OPTIONS,
  isHistoryDisplayLimit,
  type HistoryDisplayLimit,
} from '@/config/history-display-config';
import type { ConversationPair } from '@/types/conversation';
import type { HistoryMatch } from '@/hooks/useHistorySearch';
import {
  HISTORY_VIRTUAL_OVERSCAN,
  HISTORY_ESTIMATED_PAIR_HEIGHT_PX,
  HISTORY_FALLBACK_RENDER_COUNT,
  isNearBottom,
} from '@/lib/history-virtualization';

// ============================================================================
// Constants
// ============================================================================

/**
 * Issue #744: id of the per-split slot element that wraps an embedded
 * HistoryPane. `TerminalSplitPaneContent` renders the wrapping `<div>` with this
 * exact `id` so the split-embedded collapse button's `aria-controls` resolves to
 * a real region (instead of dangling at the PC-unrendered HISTORY_PANE_ID).
 * Keep this format in sync with `TerminalSplitPaneContent`.
 */
export function splitHistorySlotId(splitIndex: number): string {
  return `split-history-slot-${splitIndex}`;
}

/**
 * Issue #744: data-testid for the collapse button. Legacy (no splitIndex) keeps
 * the original stable id for backward compatibility / mobile / existing tests.
 * Per-split usage suffixes by splitIndex so multiple simultaneously-mounted
 * panes never produce duplicate testids in the DOM.
 */
export function collapseButtonTestId(splitIndex: number | undefined): string {
  return splitIndex === undefined
    ? 'history-pane-collapse-button'
    : `history-pane-collapse-button-${splitIndex}`;
}

// ============================================================================
// Types
// ============================================================================

export interface HistoryPaneProps {
  messages: ChatMessage[];
  worktreeId: string;
  onFilePathClick: (path: string) => void;
  isLoading?: boolean;
  className?: string;
  showToast?: (message: string, type?: 'success' | 'error' | 'info') => void;
  /** Issue #485: Callback when a message is inserted into message input */
  onInsertToMessage?: (content: string) => void;
  /**
   * Issue #1121: Called with a failed optimistic message's tempId to re-send it.
   * Wired by callers that provide optimistic-UI sending (PC split). Omitted
   * elsewhere — error bubbles simply render without a Retry action.
   */
  onRetryPending?: (tempId: string) => void;
  /**
   * Issue #1121: Called with a failed optimistic message's tempId to discard it
   * (the caller may restore its content to the composer draft).
   */
  onDiscardPending?: (tempId: string) => void;
  /** Issue #168: Whether archived messages are being shown */
  showArchived?: boolean;
  /** Issue #168: Callback when showArchived toggle changes */
  onShowArchivedChange?: (show: boolean) => void;
  /** Issue #701: Current history display limit (50/100/150/200/250) */
  historyDisplayLimit?: HistoryDisplayLimit;
  /** Issue #701: Callback when the history display limit selector changes */
  onHistoryDisplayLimitChange?: (limit: HistoryDisplayLimit) => void;
  /**
   * Issue #725: When true, only user messages are shown — assistant message
   * sections are hidden and orphan (assistant-only) pairs are skipped.
   * Defaults to `false`.
   */
  historyUserOnly?: boolean;
  /** Issue #725: Callback when the "User only" toggle changes. */
  onHistoryUserOnlyChange?: (next: boolean) => void;
  /**
   * Issue #727: When provided, a collapse button (▶) is rendered in the
   * header so the user can hide the dedicated PC History column.
   * Omit on mobile or when the column cannot be hidden.
   */
  onCollapse?: () => void;
  /**
   * Issue #744: When this HistoryPane is rendered inside a PC terminal split,
   * pass the split index so its in-pane search uses a per-split CSS highlight
   * namespace (`makeHistoryNamespace(splitIndex)` → `history-search-<idx>`).
   * Multiple HistoryPanes mounted at once (one per split) would otherwise
   * clobber each other's highlights via the shared global `history-search`
   * registry key. When omitted, the legacy global namespace is used
   * (mobile / single-pane, backward compatible).
   */
  splitIndex?: number;
  /**
   * Issue #744: The CLI tool this HistoryPane represents (metadata only). The
   * messages are already filtered by the caller's fetch
   * (`useSplitMessages({ cliToolId })`), so HistoryPane does NOT apply a
   * client-side cliToolId filter (S1-008). Provided for clarity / future use.
   */
  cliToolId?: CLIToolType;
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Issue #1118: Card-shaped skeleton mirroring the ConversationPairCard outline
 * (rounded-lg border, mb-4 rhythm) so the loading state matches the loaded
 * layout instead of popping in. Kept generic on purpose — the real card is
 * being restructured by Issue #1117, so only the outer shape is mimicked.
 */
function LoadingIndicator() {
  const t = useTranslations('worktree');
  return (
    <div
      data-testid="loading-indicator"
      role="status"
      aria-label={t('history.loading')}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="mb-4 overflow-hidden rounded-lg border border-border"
        >
          <div className="flex items-center gap-2 p-3">
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-4 w-1/3" />
          </div>
          <div className="space-y-2 px-3 pb-3">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const t = useTranslations('worktree');
  return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <svg
        className="w-12 h-12 mb-2 opacity-50"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
        />
      </svg>
      <p className="text-sm">{t('history.empty')}</p>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Locate the DOM element for a given message id within the scroll container.
 * Uses native `CSS.escape` so the selector is safe even if message ids ever
 * stop being plain UUIDs (defensive).
 */
function findMessageElement(container: Element, messageId: string): Element | null {
  return container.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
}

/** Reverse-index search hits to the pair IDs that own them. */
function computeMatchedPairIds(
  matches: HistoryMatch[],
  pairs: ConversationPair[]
): Set<string> {
  const messageIdToPairId = new Map<string, string>();
  for (const pair of pairs) {
    if (pair.userMessage) messageIdToPairId.set(pair.userMessage.id, pair.id);
    for (const am of pair.assistantMessages) messageIdToPairId.set(am.id, pair.id);
  }
  const result = new Set<string>();
  for (const m of matches) {
    const pid = messageIdToPairId.get(m.messageId);
    if (pid) result.add(pid);
  }
  return result;
}

// ============================================================================
// Main Component
// ============================================================================

// Issue #1019: The outer wrapper no longer scrolls. It only clips its rounded
// corners (`overflow-hidden`) and lays out the fixed header, fixed search bar
// and the single inner scroll region as flex rows. Scrolling is delegated to a
// dedicated inner div (see render) so the header stays pinned above it.
const BASE_CONTAINER_CLASSES = [
  'h-full',
  'flex',
  'flex-col',
  'overflow-hidden',
  'bg-surface-2',
  'rounded-lg',
  'border',
  'border-border',
] as const;

export const HistoryPane = memo(function HistoryPane({
  messages,
  worktreeId,
  onFilePathClick,
  isLoading = false,
  className = '',
  showToast,
  onInsertToMessage,
  onRetryPending,
  onDiscardPending,
  showArchived = false,
  onShowArchivedChange,
  historyDisplayLimit,
  onHistoryDisplayLimitChange,
  historyUserOnly = false,
  onHistoryUserOnlyChange,
  onCollapse,
  splitIndex,
  cliToolId: _cliToolId,
}: HistoryPaneProps) {
  const t = useTranslations('worktree');
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Issue #744: per-split CSS highlight namespace. When this pane is inside a
  // PC terminal split, each split gets its own `history-search-<idx>` keys so
  // simultaneously-mounted panes never overwrite each other's highlights. When
  // splitIndex is omitted (mobile / single pane) the legacy global namespace
  // is used for backward compatibility.
  const highlightNamespace: HighlightNamespace = useMemo(
    () =>
      splitIndex === undefined
        ? HISTORY_SEARCH_NAMESPACE
        : makeHistoryNamespace(splitIndex),
    [splitIndex]
  );

  // Issue #744: derive the collapse button's identity from splitIndex so that
  // multiple split-embedded HistoryPanes never collide on a shared DOM id/testid.
  // Legacy (no splitIndex / mobile / single PC column): keep the original
  // `history-pane-collapse-button` testid + `aria-controls=HISTORY_PANE_ID`
  // (the slot rendered by TerminalContainer). Per-split: suffix the testid and
  // point aria-controls at this split's own slot id (rendered by
  // TerminalSplitPaneContent), so the control always resolves to a real region.
  const collapseTestId = collapseButtonTestId(splitIndex);
  const collapseAriaControls =
    splitIndex === undefined ? HISTORY_PANE_ID : splitHistorySlotId(splitIndex);
  /** [Issue #1123] Whether the view is pinned to the latest message (follow mode). */
  const isPinnedToBottomRef = useRef<boolean>(true);
  /** [Issue #1123] Previous rendered-pair count, to detect appended messages. */
  const prevVisiblePairCountRef = useRef<number>(-1);
  /** [Issue #716] Saved scrollTop at the moment search was opened. */
  const searchStartScrollPositionRef = useRef<number | null>(null);

  // ---------------------------------------------------------------
  // Conversation pairing + manual expand state (unchanged)
  // ---------------------------------------------------------------
  const { pairs, isExpanded: isManuallyExpanded, toggleExpand } = useConversationHistory(messages);

  // ---------------------------------------------------------------
  // [Issue #716] Search
  // ---------------------------------------------------------------
  // Pre-filter searchable messages (archived/empty removed); see design §5.2.
  // Issue #725: When `historyUserOnly` is true, also filter out assistant role
  // so search results never highlight assistant content the user cannot see.
  const searchableMessages = useMemo(
    () =>
      messages.filter(
        (m) =>
          !m.archived &&
          typeof m.content === 'string' &&
          m.content.length > 0 &&
          (!historyUserOnly || m.role === 'user')
      ),
    [messages, historyUserOnly]
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

  const [autoExpandedIds, setAutoExpandedIds] = useState<Set<string>>(new Set());

  // Reset search when worktree context changes.
  useEffect(() => {
    closeSearch();
    // Intentionally exclude closeSearch from deps; reset only on worktree change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId]);

  // ---------------------------------------------------------------
  // [Issue #1123] Virtualization
  // ---------------------------------------------------------------
  // Only the pairs that will actually render participate in the virtual list so
  // DOM row indices line up with the virtualizer's item indices. Issue #725: in
  // "User only" mode orphan (assistant-only) pairs are dropped up-front.
  const visiblePairs = useMemo(
    () => (historyUserOnly ? pairs.filter((p) => p.userMessage) : pairs),
    [pairs, historyUserOnly]
  );

  // messageId -> owning pair id, and pair id -> row index. Used to translate a
  // search match (which references a messageId) into the virtual row that must
  // be materialized before it can be highlighted — off-screen cards are
  // unmounted, so their DOM cannot be queried until the row is scrolled in.
  const messageIdToPairId = useMemo(() => {
    const map = new Map<string, string>();
    for (const pair of visiblePairs) {
      if (pair.userMessage) map.set(pair.userMessage.id, pair.id);
      for (const am of pair.assistantMessages) map.set(am.id, pair.id);
    }
    return map;
  }, [visiblePairs]);

  const pairRowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    visiblePairs.forEach((pair, index) => map.set(pair.id, index));
    return map;
  }, [visiblePairs]);

  const rowVirtualizer = useVirtualizer({
    count: visiblePairs.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => HISTORY_ESTIMATED_PAIR_HEIGHT_PX,
    overscan: HISTORY_VIRTUAL_OVERSCAN,
    getItemKey: (index) => visiblePairs[index]?.id ?? index,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  // Stable key describing the currently mounted window; drives the highlight
  // effect so highlights re-apply as rows mount/unmount during scrolling.
  const renderedRange =
    virtualItems.length > 0
      ? `${virtualItems[0].index}-${virtualItems[virtualItems.length - 1].index}`
      : '';

  // Track whether the view is pinned to the bottom (follow mode) on every scroll,
  // so the append effect below can choose follow vs. maintain.
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    isPinnedToBottomRef.current = isNearBottom({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    });
  }, []);

  // Follow newly appended messages to the bottom only while pinned; otherwise the
  // reader's position is preserved automatically (react-virtual keeps the scroll
  // offset stable when rows are appended at the end). Skipped during an active
  // search so search's own scrollToIndex is not overridden.
  useLayoutEffect(() => {
    const prev = prevVisiblePairCountRef.current;
    const curr = visiblePairs.length;
    prevVisiblePairCountRef.current = curr;
    if (prev === -1) return; // first render: establish baseline, do not auto-scroll
    if (curr > prev && curr > 0 && isPinnedToBottomRef.current && !isSearchActive) {
      rowVirtualizer.scrollToIndex(curr - 1, { align: 'end' });
    }
  }, [visiblePairs.length, isSearchActive, rowVirtualizer]);

  // ---------------------------------------------------------------
  // Effect order per design policy §4.2 (search):
  //   (3) compute autoExpandedIds
  //   (3b) scroll the current match's row into view (materialize it)
  //   (4) apply highlights + scrollIntoView (re-runs as rows mount)
  // ---------------------------------------------------------------

  // (3) Recompute auto-expanded pair IDs whenever search results change.
  useLayoutEffect(() => {
    if (!isSearchOpen || matchPositions.length === 0) {
      setAutoExpandedIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    setAutoExpandedIds(computeMatchedPairIds(matchPositions, pairs));
  }, [isSearchOpen, matchPositions, pairs]);

  // (3b) Bring the current match's row into view. Virtualized rows are unmounted
  // when off-screen, so the row must be materialized via the virtualizer before
  // effect (4) can find and mark its DOM node. Changing the mounted window bumps
  // `renderedRange`, which re-triggers effect (4).
  useEffect(() => {
    if (!isSearchOpen || !currentMatch) return;
    const pairId = messageIdToPairId.get(currentMatch.messageId);
    if (pairId === undefined) return;
    const rowIndex = pairRowIndexById.get(pairId);
    if (rowIndex === undefined) return;
    rowVirtualizer.scrollToIndex(rowIndex, { align: 'center' });
  }, [isSearchOpen, currentMatch, messageIdToPairId, pairRowIndexById, rowVirtualizer]);

  // (4) Apply per-message highlights to the mounted matches and scroll the
  // current match into view. Re-runs when the mounted window changes
  // (`renderedRange`) so off-screen matches get highlighted once scrolled in.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (!isSearchOpen || matchPositions.length === 0) {
      clearHistoryHighlights(highlightNamespace);
      return;
    }

    let currentMatchElement: HTMLElement | null = null;
    for (const match of matchPositions) {
      const el = findMessageElement(container, match.messageId);
      if (!el) continue; // off-screen row not mounted yet; applied on next mount
      const isCurrent = currentMatch?.messageId === match.messageId;
      const localIdx = isCurrent ? currentMatch.localIndex : -1;
      applyHistoryHighlights(el, match.ranges, localIdx, highlightNamespace);
      if (isCurrent && el instanceof HTMLElement) {
        currentMatchElement = el;
      }
    }

    if (currentMatchElement && typeof currentMatchElement.scrollIntoView === 'function') {
      currentMatchElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    return () => {
      clearHistoryHighlights(highlightNamespace);
    };
  }, [isSearchOpen, matchPositions, currentMatch, autoExpandedIds, highlightNamespace, renderedRange]);

  // Save scroll position when the search opens; restore it when search closes.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (isSearchOpen) {
      if (searchStartScrollPositionRef.current === null && container) {
        searchStartScrollPositionRef.current = container.scrollTop;
      }
    } else {
      if (searchStartScrollPositionRef.current !== null && container) {
        const saved = searchStartScrollPositionRef.current;
        requestAnimationFrame(() => {
          container.scrollTop = saved;
        });
      }
      searchStartScrollPositionRef.current = null;
    }
  }, [isSearchOpen]);

  // ---------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------

  const containerClasses = useMemo(
    () => [...BASE_CONTAINER_CLASSES, className].filter(Boolean).join(' '),
    [className]
  );

  const handleFilePathClick = useCallback(
    (path: string) => onFilePathClick(path),
    [onFilePathClick]
  );

  const createToggleHandler = useCallback(
    (pairId: string) => () => toggleExpand(pairId),
    [toggleExpand]
  );

  // `t` churns identity every render (Issue #1219 / #1032), and handleCopy is
  // handed to the memoized ConversationPairCard for every virtualized row —
  // keying on `t` would re-render the whole list on each parent render. Read the
  // translator through a ref so the callback stays stable but the toast text is
  // still resolved fresh at click time (locale switches included).
  const tRef = useRef(t);
  tRef.current = t;

  const handleCopy = useCallback(
    async (content: string) => {
      try {
        await copyToClipboard(content);
        showToast?.(tRef.current('history.copied'), 'success');
      } catch {
        console.error('[HistoryPane] Failed to copy to clipboard');
        showToast?.(tRef.current('history.copyFailed'), 'error');
      }
    },
    [showToast]
  );

  // Card body shared by the virtualized rows and the zero-measurement fallback.
  // Expand state lives in the parent (useConversationHistory + search
  // auto-expand), so it survives the card's unmount/remount as rows recycle
  // during virtualized scrolling.
  const renderPairBody = (pair: ConversationPair) => {
    const isArchived =
      pair.userMessage?.archived === true ||
      pair.assistantMessages?.some((m) => m.archived === true);
    const expanded = isManuallyExpanded(pair.id) || autoExpandedIds.has(pair.id);
    return (
      <div className={isArchived ? 'opacity-60' : ''}>
        <ConversationPairCard
          pair={pair}
          onFilePathClick={handleFilePathClick}
          isExpanded={expanded}
          onToggleExpand={createToggleHandler(pair.id)}
          onCopy={handleCopy}
          onInsertToMessage={onInsertToMessage}
          onRetryPending={onRetryPending}
          onDiscardPending={onDiscardPending}
          showAssistant={!historyUserOnly}
        />
      </div>
    );
  };

  const renderContent = () => {
    if (isLoading) {
      return <LoadingIndicator />;
    }
    if (visiblePairs.length === 0) {
      return <EmptyState />;
    }
    // [Issue #1123] Zero-measurement fallback: when the virtualizer has not yet
    // measured a viewport it materializes no rows (first render before the
    // layout-effect measurement — SSR / first paint — and layout-less
    // environments such as jsdom). Render a bounded slice of the leading pairs
    // in normal flow so message content is present. As soon as a real height is
    // measured, the virtualized branch below takes over.
    if (virtualItems.length === 0) {
      return (
        <div data-testid="history-fallback-list">
          {visiblePairs.slice(0, HISTORY_FALLBACK_RENDER_COUNT).map((pair) => (
            <div key={pair.id}>{renderPairBody(pair)}</div>
          ))}
        </div>
      );
    }
    // Virtualized list: only mount the visible window + overscan. The sizer
    // reserves the full scroll height; each row is absolutely positioned and
    // self-measured (`measureElement`) so variable-height cards (truncate/
    // expand, code blocks) re-measure automatically when they change.
    return (
      <div
        style={{
          height: rowVirtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const pair = visiblePairs[virtualRow.index];
          if (!pair) return null;
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderPairBody(pair)}
            </div>
          );
        })}
      </div>
    );
  };

  const handleHistoryDisplayLimitSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const parsed = parseInt(e.target.value, 10);
      if (isHistoryDisplayLimit(parsed)) {
        onHistoryDisplayLimitChange?.(parsed);
      }
    },
    [onHistoryDisplayLimitChange]
  );

  const handleToggleSearch = useCallback(() => {
    if (isSearchOpen) {
      closeSearch();
    } else {
      openSearch();
    }
  }, [isSearchOpen, openSearch, closeSearch]);

  return (
    <div
      role="region"
      aria-label={t('history.regionLabel')}
      className={containerClasses}
    >
      {/* Header — fixed row, always pinned at the top (Issue #1019) */}
      <div className="flex-shrink-0 bg-surface-2 border-b border-border px-4 py-2 flex items-center justify-between flex-wrap gap-1">
        <h3 className="text-sm font-medium text-foreground">{t('history.title')}</h3>
        <div className="flex items-center gap-2 flex-wrap">
          {onHistoryDisplayLimitChange && historyDisplayLimit !== undefined && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <span>{t('history.show')}</span>
              <select
                value={historyDisplayLimit}
                onChange={handleHistoryDisplayLimitSelectChange}
                aria-label={t('history.displayLimit')}
                className="rounded border border-input bg-surface text-foreground text-xs px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {HISTORY_DISPLAY_LIMIT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </label>
          )}
          {onShowArchivedChange && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <Checkbox
                checked={showArchived}
                onCheckedChange={(checked) => onShowArchivedChange(checked === true)}
                className="h-3.5 w-3.5"
              />
              {t('history.showArchived')}
            </label>
          )}
          {onHistoryUserOnlyChange && (
            <button
              type="button"
              onClick={() => onHistoryUserOnlyChange(!historyUserOnly)}
              aria-label={t('history.showUserOnly')}
              aria-pressed={historyUserOnly}
              className={`p-1 rounded transition-colors ${
                historyUserOnly
                  ? 'bg-accent-500/15 text-accent-700 dark:text-accent-300'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={historyUserOnly ? t('history.showAllMessages') : t('history.showUserOnly')}
            >
              {historyUserOnly ? (
                <UserCheck size={14} aria-hidden="true" />
              ) : (
                <User size={14} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleToggleSearch}
            aria-label={isSearchOpen ? t('history.closeSearch') : t('history.openSearch')}
            aria-pressed={isSearchOpen}
            className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
            title={isSearchOpen ? t('history.closeSearch') : t('history.openSearch')}
          >
            <Search size={14} aria-hidden="true" />
          </button>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={t('terminal.hideHistory')}
              aria-expanded="true"
              aria-controls={collapseAriaControls}
              className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
              title={t('terminal.hideHistory')}
              data-testid={collapseTestId}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Search bar (toggleable) — fixed row below the header (Issue #1019) */}
      {isSearchOpen && (
        <div className="flex-shrink-0 px-3 py-2 bg-surface-2 border-b border-border">
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
        </div>
      )}

      {/* Content — the only scroll region. Messages scroll below the fixed
          header/search bar, never behind them (Issue #1019). scrollContainerRef
          points here so scroll save/restore (#716) and search scrollIntoView
          operate on the real scroll element. */}
      <div
        ref={scrollContainerRef}
        data-testid="history-scroll-container"
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4"
      >
        {renderContent()}
      </div>
    </div>
  );
});

export default HistoryPane;
