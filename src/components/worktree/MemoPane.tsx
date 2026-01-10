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

import React, { useState, useEffect, useCallback, memo } from 'react';
import { memoApi, handleApiError } from '@/lib/api-client';
import { MemoCard } from './MemoCard';
import { MemoAddButton } from './MemoAddButton';
import type { WorktreeMemo } from '@/types/models';

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of memos per worktree */
const MAX_MEMOS = 5;

// ============================================================================
// Types
// ============================================================================

export interface MemoPaneProps {
  /** Worktree ID to fetch memos for */
  worktreeId: string;
  /** Additional CSS classes */
  className?: string;
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
}: MemoPaneProps) {
  // State
  const [memos, setMemos] = useState<WorktreeMemo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

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
   * Handle retry
   */
  const handleRetry = useCallback(() => {
    void fetchMemos();
  }, [fetchMemos]);

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
          <div className="w-8 h-8 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm text-gray-500">Loading memos...</span>
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
          <span className="text-sm text-red-600">{error}</span>
          <button
            type="button"
            onClick={handleRetry}
            aria-label="Retry"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="memo-pane"
      className={`flex flex-col gap-4 p-4 overflow-y-auto ${className}`}
    >
      {/* Empty state */}
      {memos.length === 0 && !createError && (
        <div className="text-center py-8 text-gray-500">
          <p>No memos yet.</p>
          <p className="text-sm">Click the button below to add one.</p>
        </div>
      )}

      {/* Memo cards */}
      {memos.map((memo) => (
        <MemoCard
          key={memo.id}
          memo={memo}
          onUpdate={handleUpdateMemo}
          onDelete={handleDeleteMemo}
        />
      ))}

      {/* Create error message */}
      {createError && (
        <div className="text-center py-2 text-sm text-red-500">
          {createError}
        </div>
      )}

      {/* Add button */}
      <MemoAddButton
        currentCount={memos.length}
        maxCount={MAX_MEMOS}
        onAdd={handleAddMemo}
        isLoading={isAdding}
        className="mt-2"
      />
    </div>
  );
});

export default MemoPane;
