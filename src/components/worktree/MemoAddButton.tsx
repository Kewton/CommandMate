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
import { useTranslations } from 'next-intl';
import { Spinner } from '@/components/ui/Spinner';

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
  const t = useTranslations('schedule');
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
        aria-label={t('memoAdd')}
        aria-disabled={isDisabled}
        className={`
          flex items-center gap-2 px-4 py-2 rounded-lg border-2 border-dashed
          transition-colors focus:outline-none focus:ring-2 focus:ring-ring
          ${isDisabled
            ? 'border-border text-muted-foreground cursor-not-allowed opacity-50'
            : 'border-border text-muted-foreground hover:border-accent-400 dark:hover:border-accent-500 hover:text-accent-600 dark:hover:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/30'
          }
        `}
      >
        {isLoading ? (
          <Spinner data-testid="loading-indicator" size="md" variant="accent" />
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
        <span className="text-sm font-medium">{t('memoAdd')}</span>
      </button>
      <span className="text-xs text-muted-foreground">
        {t('memoRemaining', { count: remaining })}
      </span>
    </div>
  );
});

export default MemoAddButton;
