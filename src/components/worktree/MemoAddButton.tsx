/**
 * MemoAddButton Component
 *
 * Button to add a new memo with remaining count display.
 * Features:
 * - Plus icon button
 * - Remaining memo count display
 * - Disabled state when at memo limit
 * - Loading indicator
 */

'use client';

import React, { memo } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface MemoAddButtonProps {
  /** Current number of memos */
  currentCount: number;
  /** Maximum number of memos allowed */
  maxCount: number;
  /** Callback when add button is clicked */
  onAdd: () => void;
  /** Whether the button is in loading state */
  isLoading?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// ============================================================================
// Component
// ============================================================================

/**
 * MemoAddButton - Add new memo button with remaining count
 *
 * @example
 * ```tsx
 * <MemoAddButton
 *   currentCount={2}
 *   maxCount={5}
 *   onAdd={handleAddMemo}
 * />
 * ```
 */
export const MemoAddButton = memo(function MemoAddButton({
  currentCount,
  maxCount,
  onAdd,
  isLoading = false,
  className = '',
}: MemoAddButtonProps) {
  const remaining = Math.max(0, maxCount - currentCount);
  const isDisabled = currentCount >= maxCount || isLoading;

  /**
   * Handle button click
   */
  const handleClick = () => {
    if (!isDisabled) {
      onAdd();
    }
  };

  return (
    <div
      data-testid="memo-add-button"
      className={`flex flex-col items-center gap-2 ${className}`}
    >
      <button
        type="button"
        onClick={handleClick}
        disabled={isDisabled}
        aria-label="Add Memo"
        aria-disabled={isDisabled}
        className={`
          flex items-center gap-2 px-4 py-2 rounded-lg border-2 border-dashed
          transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500
          ${isDisabled
            ? 'border-gray-200 dark:border-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed opacity-50'
            : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-cyan-400 dark:hover:border-cyan-500 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-900/30'
          }
        `}
      >
        {isLoading ? (
          <span
            data-testid="loading-indicator"
            className="w-5 h-5 border-2 border-gray-300 dark:border-gray-600 border-t-cyan-500 rounded-full animate-spin"
          />
        ) : (
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        )}
        <span className="text-sm font-medium">Add Memo</span>
      </button>
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {remaining} remaining
      </span>
    </div>
  );
});

export default MemoAddButton;
