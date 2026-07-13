/**
 * MemoCard Component
 *
 * Displays and edits a single memo card with auto-save functionality.
 * Features:
 * - Inline title and content editing
 * - Auto-save with debounce
 * - Save on blur
 * - Copy memo content to clipboard
 * - Delete button
 * - Saving indicator
 */

'use client';

import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, ArrowDownToLine, ChevronUp, ChevronDown } from 'lucide-react';
import { useAutoSave } from '@/hooks/useAutoSave';
import { copyToClipboard } from '@/lib/clipboard-utils';
import type { WorktreeMemo } from '@/types/models';

// ============================================================================
// Constants
// ============================================================================

/** Duration (ms) to show the Check icon after a successful copy */
const COPY_FEEDBACK_DURATION_MS = 2000;

// ============================================================================
// Types
// ============================================================================

export interface MemoCardProps {
  /** The memo data to display */
  memo: WorktreeMemo;
  /** Callback when memo is updated */
  onUpdate: (memoId: string, data: { title?: string; content?: string }) => Promise<void>;
  /** Callback when memo is deleted */
  onDelete: (memoId: string) => void;
  /** Whether the card is in saving state (overrides internal state) */
  isSaving?: boolean;
  /** Error message to display */
  error?: string | null;
  /** Additional CSS classes */
  className?: string;
  /** Issue #485: Callback when memo content is inserted into message input */
  onInsertToMessage?: (content: string) => void;
  /** Issue #944: Move this memo up one position */
  onMoveUp?: () => void;
  /** Issue #944: Move this memo down one position */
  onMoveDown?: () => void;
  /** Issue #944: Whether the memo can move up (false disables the ↑ button) */
  canMoveUp?: boolean;
  /** Issue #944: Whether the memo can move down (false disables the ↓ button) */
  canMoveDown?: boolean;
}

// ============================================================================
// Component
// ============================================================================

/**
 * MemoCard - Individual memo card with inline editing
 *
 * @example
 * ```tsx
 * <MemoCard
 *   memo={memo}
 *   onUpdate={handleUpdate}
 *   onDelete={handleDelete}
 * />
 * ```
 */
export const MemoCard = memo(function MemoCard({
  memo,
  onUpdate,
  onDelete,
  isSaving: externalIsSaving,
  error: externalError,
  className = '',
  onInsertToMessage,
  onMoveUp,
  onMoveDown,
  canMoveUp = true,
  canMoveDown = true,
}: MemoCardProps) {
  const t = useTranslations('schedule');

  // Issue #944: reorder controls are shown only when a move handler is provided.
  const showReorder = Boolean(onMoveUp || onMoveDown);

  // Local state for title and content
  const [title, setTitle] = useState(memo.title);
  const [content, setContent] = useState(memo.content);

  // Copy to clipboard state
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // Cleanup timer on unmount to prevent state updates on unmounted component
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Auto-save for title
  const {
    isSaving: isSavingTitle,
    error: titleError,
    saveNow: saveTitle,
  } = useAutoSave({
    value: title,
    saveFn: async (value) => {
      await onUpdate(memo.id, { title: value });
    },
  });

  // Auto-save for content
  const {
    isSaving: isSavingContent,
    error: contentError,
    saveNow: saveContent,
  } = useAutoSave({
    value: content,
    saveFn: async (value) => {
      await onUpdate(memo.id, { content: value });
    },
  });

  // Combined saving state
  const isSaving = externalIsSaving ?? (isSavingTitle || isSavingContent);
  const error = externalError ?? titleError?.message ?? contentError?.message ?? null;

  /**
   * Handle title change
   */
  const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
  }, []);

  /**
   * Handle content change
   */
  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
  }, []);

  /**
   * Handle title blur - immediate save
   */
  const handleTitleBlur = useCallback(() => {
    void saveTitle();
  }, [saveTitle]);

  /**
   * Handle content blur - immediate save
   */
  const handleContentBlur = useCallback(() => {
    void saveContent();
  }, [saveContent]);

  /**
   * Handle delete button click
   */
  const handleDelete = useCallback(() => {
    onDelete(memo.id);
  }, [memo.id, onDelete]);

  /**
   * Issue #485: Insert memo content into message input.
   * Empty or whitespace-only content is silently ignored.
   */
  const handleInsert = useCallback(() => {
    if (!content.trim()) return;
    onInsertToMessage?.(content);
  }, [content, onInsertToMessage]);

  /**
   * Copy memo content to clipboard (Issue #321).
   * Shows Check icon for COPY_FEEDBACK_DURATION_MS on success.
   * Empty or whitespace-only content is silently ignored (UI-level guard).
   * Failure is silently handled -- the icon remains unchanged, which serves
   * as implicit feedback to the user (see design policy Section 8.3).
   */
  const handleCopy = useCallback(async () => {
    if (!content.trim()) return;
    try {
      await copyToClipboard(content);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
    } catch {
      // Silent error: icon stays as Copy to indicate failure
    }
  }, [content]);

  return (
    <div
      data-testid="memo-card"
      data-memo-id={memo.id}
      // Issue #787: tabIndex makes the card a focus target for search next/prev
      // scroll-to-match (focusable without entering the tab order).
      tabIndex={-1}
      className={`bg-surface dark:bg-surface-2 border border-border rounded-lg p-4 space-y-3 focus:outline-none ${className}`}
    >
      {/* Header: Title and Delete button */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={title}
          onChange={handleTitleChange}
          onBlur={handleTitleBlur}
          placeholder="Memo title"
          className="flex-1 min-w-0 text-sm font-medium text-foreground bg-transparent border-none focus:outline-none focus:ring-0 p-0"
        />
        {isSaving && (
          <span
            data-testid="saving-indicator"
            className="text-xs text-muted-foreground"
          >
            Saving...
          </span>
        )}
        {/* Issue #944: Reorder buttons */}
        {showReorder && (
          <>
            <button
              type="button"
              data-testid={`memo-move-up-${memo.id}`}
              onClick={onMoveUp}
              disabled={!canMoveUp}
              aria-label={t('memoMoveUp')}
              title={t('memoMoveUp')}
              className="flex-shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors rounded disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronUp className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              data-testid={`memo-move-down-${memo.id}`}
              onClick={onMoveDown}
              disabled={!canMoveDown}
              aria-label={t('memoMoveDown')}
              title={t('memoMoveDown')}
              className="flex-shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors rounded disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            </button>
          </>
        )}
        {/* Issue #485: Insert to message button */}
        {onInsertToMessage && (
          <button
            type="button"
            data-testid="insert-memo-content"
            onClick={handleInsert}
            aria-label="Insert to message"
            className="flex-shrink-0 p-1 text-muted-foreground hover:text-accent-600 dark:hover:text-accent-400 transition-colors rounded"
            title="Insert to message"
          >
            <ArrowDownToLine className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
        {/* Copy button */}
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy memo content"
          className="flex-shrink-0 p-1 text-muted-foreground hover:text-foreground transition-colors rounded"
        >
          {copied ? (
            <Check className="w-4 h-4 text-green-600" />
          ) : (
            <Copy className="w-4 h-4" />
          )}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          aria-label="Delete memo"
          className="flex-shrink-0 p-1 text-muted-foreground hover:text-red-500 transition-colors rounded"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </div>

      {/* Content textarea */}
      <textarea
        value={content}
        onChange={handleContentChange}
        onBlur={handleContentBlur}
        placeholder="Enter memo content..."
        rows={4}
        className="w-full text-sm text-foreground bg-muted border border-border rounded-md p-2 resize-y focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
      />

      {/* Error message */}
      {error && (
        <div className="text-xs text-red-500">
          {error}
        </div>
      )}
    </div>
  );
});

export default MemoCard;
