/**
 * useGenerationStatus Hook
 * Polls /api/daily-summary/status to detect ongoing report generation.
 *
 * Issue #638: Report generation status visibility
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

/** Polling interval for status check (5 seconds) */
const STATUS_POLL_INTERVAL_MS = 5_000;

export interface GenerationStatusState {
  generating: boolean;
  date?: string;
  tool?: string;
  startedAt?: string;
}

/**
 * Poll the generation status endpoint.
 * @param enabled - Whether polling is active
 * @returns Current generation status
 */
export function useGenerationStatus(enabled: boolean): GenerationStatusState {
  const [status, setStatus] = useState<GenerationStatusState>({ generating: false });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/daily-summary/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {
      // Silently ignore fetch errors - keep last known state
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus({ generating: false });
      return;
    }

    // Initial fetch
    fetchStatus();

    // Set up polling
    timerRef.current = setInterval(fetchStatus, STATUS_POLL_INTERVAL_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, fetchStatus]);

  return status;
}
