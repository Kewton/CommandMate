/**
 * useVisibilityRecovery hook (Issue #923)
 *
 * Owns the page-visibility background recovery extracted from
 * `useWorktreeDetailController` as a pure structural refactor (no behavior
 * change). One of the Phase 1 "low-risk, no cross-concern coupling" sub-hooks:
 * it fully encapsulates the throttle ref, the `visibilitychange` handler, and
 * the listener registration effect (Issue #246, Issue #266).
 *
 * The controller passes in its data fetchers, error state, and recovery
 * handler; the hook registers the listener and drives recovery, returning
 * nothing (the controller never consumed `handleVisibilityChange` directly).
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Worktree } from '@/types/models';

/**
 * Throttle interval for visibilitychange recovery (ms).
 * Prevents excessive API calls when the page rapidly transitions between
 * visible and hidden states.
 * Same value as IDLE_POLLING_INTERVAL_MS but semantically independent:
 * - IDLE_POLLING_INTERVAL_MS: steady-state polling frequency
 * - RECOVERY_THROTTLE_MS: visibilitychange burst prevention threshold
 * (Issue #246, SF-001)
 */
const RECOVERY_THROTTLE_MS = 5000;

/** Dependencies injected by the controller into {@link useVisibilityRecovery}. */
export interface UseVisibilityRecoveryParams {
  /** Current error state; when set, recovery defers to {@link handleRetry}. */
  error: string | null;
  /** Full recovery (resets loading state and rebuilds the UI from error). */
  handleRetry: () => void;
  /** Re-fetch worktree metadata. */
  fetchWorktree: () => Promise<Worktree | null>;
  /** Re-fetch message history. */
  fetchMessages: () => Promise<void>;
  /** Re-fetch current terminal output / prompt status. */
  fetchCurrentOutput: () => Promise<void>;
  /** Clear the error state (counters internal setError from fetchWorktree). */
  setError: (error: string | null) => void;
}

/**
 * Register a `visibilitychange` listener that re-syncs data when the page
 * returns to the foreground (e.g. smartphone foreground restoration).
 */
export function useVisibilityRecovery({
  error,
  handleRetry,
  fetchWorktree,
  fetchMessages,
  fetchCurrentOutput,
  setError,
}: UseVisibilityRecoveryParams): void {
  /**
   * Timestamp of the last visibilitychange recovery to prevent rapid re-fetches.
   * Used as a throttle guard: if less than RECOVERY_THROTTLE_MS has elapsed
   * since the last recovery, the handler skips execution.
   */
  const lastRecoveryTimestampRef = useRef<number>(0);

  /**
   * Handle page visibility change for background recovery.
   * When the page becomes visible again (e.g., smartphone foreground restoration),
   * performs data re-fetch to synchronize stale state.
   *
   * Design rationale (Issue #246, Issue #266):
   *
   * [SF-001] SRP: handleVisibilityChange is responsible for "background recovery
   *   data sync" only. Full recovery (handleRetry) is a separate concern.
   *
   * [SF-002] KISS: Simple error guard - error state uses handleRetry (full recovery),
   *   normal state uses lightweight recovery (no loading state change).
   *
   * [IA-002] Overlap: When the page becomes visible, up to 3 data-fetch
   *   sources may fire concurrently:
   *   1. This visibilitychange handler (lightweight recovery)
   *   2. The setInterval polling timer (if it fires during the same tick)
   *   3. WebSocket reconnection triggering a broadcast-based fetch
   *   All fetches are idempotent GET requests, so concurrent execution is
   *   safe -- it may cause redundant network calls but no data corruption.
   */
  const handleVisibilityChange = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;

    const now = Date.now();
    if (now - lastRecoveryTimestampRef.current < RECOVERY_THROTTLE_MS) {
      return;
    }
    lastRecoveryTimestampRef.current = now;

    // [SF-001] Error state requires full recovery (handleRetry) to reset
    // loading state and rebuild the UI from ErrorDisplay back to normal.
    if (error) {
      handleRetry();
      return;
    }

    // [SF-002] Normal state uses lightweight recovery (loading state unchanged).
    // This preserves the component tree, preventing MessageInput/PromptPanel
    // content from being cleared by unmount/remount caused by setLoading(true/false).
    //
    // [SF-DRY-001] Note: These fetch calls duplicate the data retrieval done by
    // handleRetry(). handleRetry uses setLoading(true/false) for full recovery,
    // while this path intentionally omits loading state changes for lightweight
    // recovery. When adding/changing fetch functions, update handleRetry() as well.
    //
    // [SF-CONS-001] handleRetry uses a sequential pattern (fetchWorktree first,
    // then conditionally fetchMessages/fetchCurrentOutput). Lightweight recovery
    // uses Promise.all for parallel execution because: failure is silently ignored
    // (next polling cycle recovers), all requests are idempotent GETs (no data
    // corruption risk), and parallel execution improves response time.
    try {
      await Promise.all([
        fetchWorktree(),
        fetchMessages(),
        fetchCurrentOutput(),
      ]);
    } finally {
      // [SF-IMP-001] fetchWorktree() internally catches errors and calls
      // setError(message) without rethrowing. This means Promise.all resolves
      // successfully even when fetchWorktree fails, but error state has already
      // been set internally. Call setError(null) unconditionally to counter any
      // internal setError() calls and maintain the component tree.
      // On success, this is a no-op (error is already null).
      // On failure, this prevents ErrorDisplay from replacing the normal UI,
      // allowing the next polling cycle to recover naturally.
      setError(null);
    }
    // [SF-IMP-002] Note: error in the dependency array causes useCallback to
    // regenerate when error state changes, triggering useEffect listener
    // re-registration (removeEventListener/addEventListener). Performance impact
    // is negligible as these are synchronous lightweight operations.
  }, [error, handleRetry, fetchWorktree, fetchMessages, fetchCurrentOutput, setError]);

  /**
   * Register visibilitychange event listener for background recovery (Issue #246, #266).
   * When the page becomes visible, performs lightweight recovery (normal state)
   * or full recovery via handleRetry() (error state) to re-fetch all data.
   * This handles the case where the browser suspended network requests while
   * the page was in the background (common on mobile browsers).
   *
   * Unlike the former worktree list UI (removed in #1115), this hook needs:
   * - Error state branching: full recovery (handleRetry) vs lightweight recovery
   * - Throttle guard (RECOVERY_THROTTLE_MS) to prevent rapid re-fetches
   */
  useEffect(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [handleVisibilityChange]);
}
