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
import { Copy, Check } from 'lucide-react';
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
}: MemoCardProps) {
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
      className={`bg-white border border-gray-200 rounded-lg p-4 space-y-3 ${className}`}
    >
      {/* Header: Title and Delete button */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={title}
          onChange={handleTitleChange}
          onBlur={handleTitleBlur}
          placeholder="Memo title"
          className="flex-1 text-sm font-medium text-gray-900 bg-transparent border-none focus:outline-none focus:ring-0 p-0"
        />
        {isSaving && (
          <span
            data-testid="saving-indicator"
            className="text-xs text-gray-400"
          >
            Saving...
          </span>
        )}
        {/* Copy button */}
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy memo content"
          className="p-1 text-gray-400 hover:text-gray-600 transition-colors rounded"
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
          className="p-1 text-gray-400 hover:text-red-500 transition-colors rounded"
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
        className="w-full text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-md p-2 resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
