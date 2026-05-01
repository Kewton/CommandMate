/**
 * useWorktreesCache - Shared worktree list cache hook.
 *
 * Issue #600: UX refresh - single source of truth for worktree list [DR3-004]
 * Issue #608: Add adaptive polling for real-time sidebar status sync
 */

'use client';

import { useState, useEffect, useCallback, useRef, startTransition } from 'react';
import type { Worktree } from '@/types/models';
import type { RepositorySummary } from '@/lib/api-client';

/** Polling interval when at least one session is running (5s) */
export const POLLING_INTERVAL_ACTIVE = 5000;

/** Polling interval when no sessions are active (30s) */
export const POLLING_INTERVAL_IDLE = 30000;

/**
 * Return value of useWorktreesCache hook.
 */
export interface UseWorktreesCacheReturn {
  /** List of worktrees */
  worktrees: Worktree[];
  /**
   * List of repositories returned by the same /api/worktrees response
   * (Issue #690). Used by the Sidebar to filter out hidden repositories.
   */
  repositories: RepositorySummary[];
  /** Whether the initial load is in progress */
  isLoading: boolean;
  /** Last error, if any */
  error: Error | null;
  /** Manually trigger a refresh */
  refresh: () => Promise<void>;
}

/**
 * Hook that provides cached access to the worktree list.
 *
 * Includes adaptive polling: 5s when any session is running, 30s when idle.
 * Pauses polling when the tab is hidden and resumes on visibility change.
 *
 * @returns Worktree list, loading state, error state, and refresh function
 */
export function useWorktreesCache(): UseWorktreesCacheReturn {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // Issue #690: Cache repositories alongside worktrees so the Sidebar
  // can filter out hidden repositories (visible=false) without an extra
  // round-trip.
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const worktreesRef = useRef<Worktree[]>([]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/worktrees');
      if (!response.ok) {
        throw new Error(`Failed to fetch worktrees: ${response.status}`);
      }
      const data = await response.json();
      const wts = data.worktrees ?? [];
      const repos = data.repositories ?? [];
      // Mark polling state updates as low-priority transitions so urgent
      // user interactions (clicks, keypresses) are never blocked by a
      // poll-induced list reorder landing mid-click.
      startTransition(() => {
        setWorktrees(wts);
        setRepositories(repos);
      });
      worktreesRef.current = wts;
    } catch (err) {
      const fetchError = err instanceof Error ? err : new Error(String(err));
      setError(fetchError);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Adaptive polling
  useEffect(() => {
    const hasActiveSession = () =>
      worktreesRef.current.some((wt) => wt.isSessionRunning === true);

    const startPolling = () => {
      stopPolling();
      const interval = hasActiveSession()
        ? POLLING_INTERVAL_ACTIVE
        : POLLING_INTERVAL_IDLE;
      intervalRef.current = setInterval(() => {
        refresh();
      }, interval);
    };

    const stopPolling = () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        refresh();
        startPolling();
      }
    };

    // Start polling after initial load settles (next tick)
    const timeoutId = setTimeout(() => {
      startPolling();
    }, 0);

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearTimeout(timeoutId);
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refresh]);

  // Re-establish polling when worktrees change (interval may need updating)
  useEffect(() => {
    worktreesRef.current = worktrees;
  }, [worktrees]);

  return { worktrees, repositories, isLoading, error, refresh };
}
