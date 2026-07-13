/**
 * MemoPane Component
 *
 * Main container for displaying and managing worktree memos.
 * Features:
 * - Fetch and display memo list
 * - Add/Edit/Delete operations
 * - Loading state
 * - Error handling with retry
 */

'use client';

import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import { Search } from 'lucide-react';
import { MAX_MEMOS } from '@/config/memo-config';
import { memoApi, handleApiError } from '@/lib/api-client';
import { useMemoSearch } from '@/hooks/useMemoSearch';
import type { WorktreeMemo } from '@/types/models';
import { MemoCard } from './MemoCard';
import { MemoAddButton } from './MemoAddButton';
import { MemoSearchBar } from './MemoSearchBar';
import { Spinner } from '@/components/ui/Spinner';

// ============================================================================
// Types
// ============================================================================

export interface MemoPaneProps {
  /** Worktree ID to fetch memos for */
  worktreeId: string;
  /** Additional CSS classes */
  className?: string;
  /** Issue #485: Callback when memo content is inserted into message input */
  onInsertToMessage?: (content: string) => void;
}

// ============================================================================
// Component
// ============================================================================

/**
 * MemoPane - Main memo container component
 *
 * @example
 * ```tsx
 * <MemoPane worktreeId="worktree-123" />
 * ```
 */
export const MemoPane = memo(function MemoPane({
  worktreeId,
  className = '',
  onInsertToMessage,
}: MemoPaneProps) {
  // State
  const [memos, setMemos] = useState<WorktreeMemo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // Issue #787: in-pane title/content text search.
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const {
    query,
    matches,
    currentMatch,
    totalCount,
    setQuery,
    reset: resetSearch,
    navigateNext,
    navigatePrev,
    onCompositionStart,
    onCompositionEnd,
  } = useMemoSearch({ memos });

  // Search is "active" once there is an effective query producing filtered results.
  const isSearchActive = isSearchOpen && query.length > 0;
  const displayedMemos = isSearchActive ? matches : memos;

  /**
   * Fetch memos from API
   */
  const fetchMemos = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await memoApi.getAll(worktreeId);
      setMemos(data.sort((a, b) => a.position - b.position));
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [worktreeId]);

  /**
   * Fetch memos on mount and when worktreeId changes
   */
  useEffect(() => {
    void fetchMemos();
  }, [fetchMemos]);

  /**
   * Handle add memo
   */
  const handleAddMemo = useCallback(async () => {
    setIsAdding(true);
    setCreateError(null);

    try {
      const newMemo = await memoApi.create(worktreeId, {
        title: 'Memo',
        content: '',
      });
      setMemos((prev) => [...prev, newMemo]);
    } catch (err) {
      setCreateError(handleApiError(err));
    } finally {
      setIsAdding(false);
    }
  }, [worktreeId]);

  /**
   * Handle update memo
   */
  const handleUpdateMemo = useCallback(
    async (memoId: string, data: { title?: string; content?: string }) => {
      await memoApi.update(worktreeId, memoId, data);
      setMemos((prev) =>
        prev.map((m) => (m.id === memoId ? { ...m, ...data } : m))
      );
    },
    [worktreeId]
  );

  /**
   * Handle delete memo
   */
  const handleDeleteMemo = useCallback(
    async (memoId: string) => {
      try {
        await memoApi.delete(worktreeId, memoId);
        setMemos((prev) => prev.filter((m) => m.id !== memoId));
      } catch (err) {
        console.error('Failed to delete memo:', err);
      }
    },
    [worktreeId]
  );

  /**
   * Issue #944: Move a memo up (-1) or down (+1) within the full memo list.
   *
   * Operates on the complete `memos` array (never the filtered `displayedMemos`)
   * so the index maps directly to a stable position. The list is optimistically
   * swapped, then persisted via PATCH; on failure we surface the error and
   * re-fetch to roll back to the server's authoritative order.
   */
  const handleMove = useCallback(
    async (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= memos.length) return;

      const next = [...memos];
      [next[index], next[target]] = [next[target], next[index]];
      setMemos(next);

      try {
        await memoApi.reorder(worktreeId, next.map((m) => m.id));
      } catch (err) {
        setError(handleApiError(err));
        await fetchMemos();
      }
    },
    [memos, worktreeId, fetchMemos]
  );

  /**
   * Handle retry
   */
  const handleRetry = useCallback(() => {
    void fetchMemos();
  }, [fetchMemos]);

  /**
   * Issue #787: Toggle the search bar. Closing also resets the query so the
   * full memo list (and the add button) is restored.
   */
  const handleToggleSearch = useCallback(() => {
    setIsSearchOpen((prev) => {
      if (prev) resetSearch();
      return !prev;
    });
  }, [resetSearch]);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    resetSearch();
  }, [resetSearch]);

  /**
   * Issue #787: Scroll the currently focused match into view and focus it via
   * its `data-memo-id` anchor. CSS Custom Highlight API is not applicable here
   * because MemoCard renders title/content in editable input/textarea elements.
   */
  useEffect(() => {
    if (!isSearchActive || currentMatch < 0) return;
    const target = matches[currentMatch];
    if (!target) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-memo-id="${target.id}"]`
    );
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      el.focus({ preventScroll: true });
    }
  }, [isSearchActive, currentMatch, matches]);

  // Loading state
  if (isLoading) {
    return (
      <div
        data-testid="memo-pane"
        className={`flex flex-col items-center justify-center h-full p-4 ${className}`}
      >
        <div
          data-testid="memo-loading"
          className="flex flex-col items-center gap-3"
        >
          <Spinner size="xl" variant="accent" />
          <span className="text-sm text-muted-foreground">Loading memos...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        data-testid="memo-pane"
        className={`flex flex-col items-center justify-center h-full p-4 ${className}`}
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <svg
            className="w-12 h-12 text-red-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
          <button
            type="button"
            onClick={handleRetry}
            aria-label="Retry"
            className="px-4 py-2 text-sm font-medium text-white bg-accent-500 rounded-lg hover:bg-accent-600 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      data-testid="memo-pane"
      className={`flex flex-col gap-4 p-4 overflow-y-auto ${className}`}
    >
      {/* Issue #787: Header with search toggle / search bar */}
      <div data-testid="memo-pane-header" className="flex items-center gap-2">
        {isSearchOpen ? (
          <div className="flex-1">
            <MemoSearchBar
              query={query}
              onQueryChange={setQuery}
              matchCount={totalCount}
              currentIndex={currentMatch}
              onNext={navigateNext}
              onPrev={navigatePrev}
              onClose={handleCloseSearch}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
            />
          </div>
        ) : (
          <>
            <div className="flex-1" />
            <button
              type="button"
              data-testid="memo-search-toggle"
              onClick={handleToggleSearch}
              aria-label="Search memos"
              className="p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded"
            >
              <Search className="w-4 h-4" aria-hidden="true" />
            </button>
          </>
        )}
      </div>

      {/* Empty state (only when there are no memos and search is not filtering) */}
      {memos.length === 0 && !isSearchActive && !createError && (
        <div className="text-center py-8 text-muted-foreground">
          <p>No memos yet.</p>
          <p className="text-sm">Click the button below to add one.</p>
        </div>
      )}

      {/* No-results state while searching */}
      {isSearchActive && displayedMemos.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <p>No memos match your search.</p>
        </div>
      )}

      {/* Memo cards */}
      {/*
        Issue #944: reordering is disabled while searching because the filtered
        list (displayedMemos = matches) breaks the index<->position alignment
        that handleMove relies on. When not searching, displayedMemos === memos
        so the map index equals the full-array index.
      */}
      {displayedMemos.map((memo, index) => (
        <MemoCard
          key={memo.id}
          memo={memo}
          onUpdate={handleUpdateMemo}
          onDelete={handleDeleteMemo}
          onInsertToMessage={onInsertToMessage}
          onMoveUp={isSearchActive ? undefined : () => handleMove(index, -1)}
          onMoveDown={isSearchActive ? undefined : () => handleMove(index, 1)}
          canMoveUp={!isSearchActive && index > 0}
          canMoveDown={!isSearchActive && index < memos.length - 1}
        />
      ))}

      {/* Create error message */}
      {createError && (
        <div className="text-center py-2 text-sm text-red-500">
          {createError}
        </div>
      )}

      {/* Add button (hidden while searching) */}
      {!isSearchActive && (
        <MemoAddButton
          currentCount={memos.length}
          maxCount={MAX_MEMOS}
          onAdd={handleAddMemo}
          isLoading={isAdding}
          className="mt-2"
        />
      )}
    </div>
  );
});

export default MemoPane;
