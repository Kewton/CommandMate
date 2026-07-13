/**
 * InterruptButton Component
 * Sends Escape key to interrupt CLI tool processing
 *
 * Issue #46: エスケープを入力可能にしたい
 */

'use client';

import React, { memo, useState, useCallback, useRef } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { Spinner } from '@/components/ui/Spinner';

export interface InterruptButtonProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /**
   * Issue #901: agent instance id to target. Defaults to the primary instance
   * (`=== cliToolId`) when omitted, so interrupt no longer broadcasts to other
   * instances of the same cliTool (e.g. split `claude` vs `claude-2`).
   */
  instanceId?: string;
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

export const InterruptButton = memo(function InterruptButton({
  worktreeId,
  cliToolId,
  instanceId,
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
      // Issue #901: include instanceId so interrupt targets only this split's
      // session. The primary instance (`=== cliToolId` or omitted) keeps sending
      // `{ cliToolId }` only, preserving the CLI broadcast behavior.
      const body = instanceId && instanceId !== cliToolId
        ? { cliToolId, instanceId }
        : { cliToolId };
      const response = await fetch(`/api/worktrees/${worktreeId}/interrupt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
  }, [worktreeId, cliToolId, instanceId, onInterrupt]);

  return (
    <button
      type="button"
      onClick={handleInterrupt}
      disabled={disabled || isLoading}
      className="flex-shrink-0 p-2 text-danger hover:bg-danger/10 rounded-full transition-colors disabled:text-muted-foreground/40 disabled:hover:bg-transparent"
      aria-label="Stop processing"
      data-testid="interrupt-button"
    >
      {isLoading ? (
        <Spinner size="md" />
      ) : (
        <StopIcon />
      )}
    </button>
  );
});

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
