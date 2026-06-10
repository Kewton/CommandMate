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
import { Search, User, UserCheck, ChevronRight } from 'lucide-react';
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

// ============================================================================
// Constants
// ============================================================================

/**
 * Height of the sticky header in pixels.
 * Used for scroll position calculations and future reference.
 * Note: sticky top-0 does not affect scrollTop calculation as content flows below naturally.
 */
export const STICKY_HEADER_HEIGHT = 48;

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

function LoadingIndicator() {
  return (
    <div
      data-testid="loading-indicator"
      className="flex items-center justify-center py-4"
      role="status"
      aria-label="Loading messages"
    >
      <div className="flex gap-1" aria-hidden="true">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse delay-100" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse delay-200" />
      </div>
      <span className="ml-2 text-sm text-gray-400">Loading...</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-gray-500">
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
      <p className="text-sm">No messages yet</p>
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

const BASE_CONTAINER_CLASSES = [
  'h-full',
  'flex',
  'flex-col',
  'overflow-y-auto',
  'overflow-x-hidden',
  'bg-gray-900',
  'rounded-lg',
  'border',
  'border-gray-700',
] as const;

export const HistoryPane = memo(function HistoryPane({
  messages,
  worktreeId,
  onFilePathClick,
  isLoading = false,
  className = '',
  showToast,
  onInsertToMessage,
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
  const scrollPositionRef = useRef<number>(0);
  const prevMessageCountRef = useRef<number>(messages.length);
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
  // Effect order per design policy §4.2:
  //   (1) save scroll position
  //   (2) restore scroll position (skipped while search is active)
  //   (3) compute autoExpandedIds
  //   (4) apply highlights + scrollIntoView
  // ---------------------------------------------------------------

  // (1) Save scrollTop before re-render.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      scrollPositionRef.current = container.scrollTop;
    }
  });

  // (2) Restore scrollTop if message count is stable; skip while searching.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const prevCount = prevMessageCountRef.current;

    if (isSearchActive) {
      // Update the count baseline so the next non-searching render restores correctly.
      prevMessageCountRef.current = messages.length;
      return;
    }

    if (container && messages.length === prevCount) {
      requestAnimationFrame(() => {
        container.scrollTop = scrollPositionRef.current;
      });
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, isSearchActive]);

  // (3) Recompute auto-expanded pair IDs whenever search results change.
  useLayoutEffect(() => {
    if (!isSearchOpen || matchPositions.length === 0) {
      setAutoExpandedIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    setAutoExpandedIds(computeMatchedPairIds(matchPositions, pairs));
  }, [isSearchOpen, matchPositions, pairs]);

  // (4) Apply per-message highlights and scroll the current match into view.
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
      if (!el) continue;
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
  }, [isSearchOpen, matchPositions, currentMatch, autoExpandedIds, highlightNamespace]);

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

  const handleCopy = useCallback(
    async (content: string) => {
      try {
        await copyToClipboard(content);
        showToast?.('Copied to clipboard', 'success');
      } catch {
        console.error('[HistoryPane] Failed to copy to clipboard');
        showToast?.('Failed to copy', 'error');
      }
    },
    [showToast]
  );

  const renderContent = () => {
    if (isLoading) {
      return <LoadingIndicator />;
    }
    if (messages.length === 0) {
      return <EmptyState />;
    }
    return pairs.map((pair) => {
      // Issue #725: When User only filter is active, skip pairs that have no
      // user message (orphan / assistant-only). Determined via `!pair.userMessage`
      // — equivalent to `pair.status === 'orphan'` in current grouping logic.
      if (historyUserOnly && !pair.userMessage) return null;
      const isArchived = pair.userMessage?.archived === true ||
        pair.assistantMessages?.some(m => m.archived === true);
      const expanded = isManuallyExpanded(pair.id) || autoExpandedIds.has(pair.id);
      return (
        <div key={pair.id} className={isArchived ? 'opacity-60' : ''}>
          <ConversationPairCard
            pair={pair}
            onFilePathClick={handleFilePathClick}
            isExpanded={expanded}
            onToggleExpand={createToggleHandler(pair.id)}
            onCopy={handleCopy}
            onInsertToMessage={onInsertToMessage}
            showAssistant={!historyUserOnly}
          />
        </div>
      );
    });
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
      ref={scrollContainerRef}
      role="region"
      aria-label="Message history"
      className={containerClasses}
    >
      {/* Header */}
      <div className="sticky top-0 bg-gray-900 border-b border-gray-700 px-4 py-2 z-10 flex items-center justify-between flex-wrap gap-1">
        <h3 className="text-sm font-medium text-gray-300">Message History</h3>
        <div className="flex items-center gap-2 flex-wrap">
          {onHistoryDisplayLimitChange && historyDisplayLimit !== undefined && (
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <span>Show</span>
              <select
                value={historyDisplayLimit}
                onChange={handleHistoryDisplayLimitSelectChange}
                aria-label="History display limit"
                className="rounded border border-gray-600 bg-gray-800 text-gray-200 text-xs px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-cyan-500"
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
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => onShowArchivedChange(e.target.checked)}
                className="rounded border-gray-600 bg-gray-800 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0 h-3.5 w-3.5"
              />
              Show archived
            </label>
          )}
          {onHistoryUserOnlyChange && (
            <button
              type="button"
              onClick={() => onHistoryUserOnlyChange(!historyUserOnly)}
              aria-label="Show user messages only"
              aria-pressed={historyUserOnly}
              className={`p-1 rounded transition-colors ${
                historyUserOnly
                  ? 'bg-cyan-900/40 text-cyan-300'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
              title={historyUserOnly ? 'Show all messages' : 'Show user messages only'}
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
            aria-label={isSearchOpen ? 'Close search' : 'Open search'}
            aria-pressed={isSearchOpen}
            className="p-1 text-gray-400 hover:text-gray-200 rounded transition-colors"
            title={isSearchOpen ? 'Close search' : 'Open search'}
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
              className="p-1 text-gray-400 hover:text-gray-200 rounded transition-colors"
              title={t('terminal.hideHistory')}
              data-testid={collapseTestId}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Search bar (toggleable) */}
      {isSearchOpen && (
        <div className="sticky top-12 z-10 px-3 py-2 bg-gray-900 border-b border-gray-700">
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

      {/* Content */}
      <div className="flex-1 p-4 min-h-0">{renderContent()}</div>
    </div>
  );
});

export default HistoryPane;
