/**
 * useFilePolling Hook
 *
 * Manages polling lifecycle for file tree and file content auto-update.
 * Handles setInterval, visibilitychange, and cleanup on unmount.
 *
 * Issue #469: File auto-update (external change detection)
 */

'use client';

import { useEffect, useRef } from 'react';

export interface UseFilePollingOptions {
  /** Polling interval in milliseconds */
  intervalMs: number;
  /** Whether polling is enabled */
  enabled: boolean;
  /** Callback invoked on each poll tick */
  onPoll: () => void;
}

/**
 * Custom hook for polling lifecycle management.
 *
 * - Starts/stops setInterval based on `enabled`
 * - Pauses on document.visibilityState === 'hidden'
 * - Resumes with immediate onPoll on visible
 * - Cleans up on unmount
 * - Uses useRef to always call the latest onPoll callback
 *
 * The visibilitychange listener operates independently from any existing
 * visibility handlers (e.g., WorktreeDetailRefactored's handleVisibilityChange).
 * No throttle is needed because the polling interval (5s) acts as a natural throttle.
 */
export function useFilePolling({ intervalMs, enabled, onPoll }: UseFilePollingOptions): void {
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const intervalIdRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function clearPolling() {
      if (intervalIdRef.current !== null) {
        clearInterval(intervalIdRef.current);
        intervalIdRef.current = null;
      }
    }

    function startPolling() {
      clearPolling();
      intervalIdRef.current = setInterval(() => {
        onPollRef.current();
      }, intervalMs);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        clearPolling();
      } else if (document.visibilityState === 'visible') {
        if (enabledRef.current) {
          onPollRef.current();
          startPolling();
        }
      }
    }

    if (enabled) {
      startPolling();
    } else {
      clearPolling();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
