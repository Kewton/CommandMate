/**
 * useWorktreesCache - Shared worktree list cache hook.
 *
 * Issue #600: UX refresh - single source of truth for worktree list [DR3-004]
 * Phase 1: Thin wrapper around direct fetch.
 * Phase 2: Will be upgraded to a proper cache implementation.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Worktree } from '@/types/models';

/**
 * Return value of useWorktreesCache hook.
 */
export interface UseWorktreesCacheReturn {
  /** List of worktrees */
  worktrees: Worktree[];
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
 * Phase 1 implementation: Direct fetch wrapper.
 * This is the single source of truth for worktree list data.
 * All components that need worktree list should use this hook
 * instead of making their own API calls.
 *
 * @returns Worktree list, loading state, error state, and refresh function
 */
export function useWorktreesCache(): UseWorktreesCacheReturn {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/worktrees');
      if (!response.ok) {
        throw new Error(`Failed to fetch worktrees: ${response.status}`);
      }
      const data = await response.json();
      setWorktrees(data.worktrees ?? []);
    } catch (err) {
      const fetchError = err instanceof Error ? err : new Error(String(err));
      setError(fetchError);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { worktrees, isLoading, error, refresh };
}
