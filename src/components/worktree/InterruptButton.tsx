/**
 * InterruptButton Component
 * Sends Escape key to interrupt CLI tool processing
 *
 * Issue #46: エスケープを入力可能にしたい
 */

'use client';

import React, { useState, useCallback, useRef } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';

export interface InterruptButtonProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  disabled?: boolean;
  onInterrupt?: () => void;
}

/** Debounce delay in milliseconds */
const DEBOUNCE_DELAY_MS = 1000;

/**
 * Stop/Interrupt button component
 * Sends Escape key to CLI session via /api/worktrees/:id/interrupt
 *
 * Features:
 * - 1 second debounce to prevent rapid fire
 * - Loading state during API call
 * - Error handling with console logging
 *
 * @example
 * ```tsx
 * <InterruptButton
 *   worktreeId="wt-1"
 *   cliToolId="claude"
 *   disabled={!isSessionRunning}
 * />
 * ```
 */

export function InterruptButton({
  worktreeId,
  cliToolId,
  disabled = false,
  onInterrupt,
}: InterruptButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const lastClickTimeRef = useRef<number>(0);

  const handleInterrupt = useCallback(async () => {
    // Debounce: ignore if clicked within DEBOUNCE_DELAY_MS
    const now = Date.now();
    if (now - lastClickTimeRef.current < DEBOUNCE_DELAY_MS) {
      return;
    }
    lastClickTimeRef.current = now;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/interrupt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cliToolId }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[InterruptButton] Failed to send interrupt:', errorData.error || response.statusText);
      } else {
        onInterrupt?.();
      }
    } catch (error) {
      console.error('[InterruptButton] Error sending interrupt:', error);
    } finally {
      setIsLoading(false);
    }
  }, [worktreeId, cliToolId, onInterrupt]);

  return (
    <button
      type="button"
      onClick={handleInterrupt}
      disabled={disabled || isLoading}
      className="flex-shrink-0 p-2 text-orange-600 hover:bg-orange-50 rounded-full transition-colors disabled:text-gray-300 disabled:hover:bg-transparent"
      aria-label="Stop processing"
      data-testid="interrupt-button"
    >
      {isLoading ? (
        <svg
          className="animate-spin h-5 w-5"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      ) : (
        <StopIcon />
      )}
    </button>
  );
}

/**
 * Stop icon (square with rounded corners)
 */
function StopIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
