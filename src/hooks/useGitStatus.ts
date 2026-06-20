/**
 * useGitStatus (Issue #779, extracted in #922)
 *
 * Owns the GitPane "Current Status" data: the read-only branch / dirty /
 * ahead-behind snapshot. Self-fetched on mount; the 5s poll is registered by the
 * GitPane body (its `enabled` is gated on the network-op progress state, so the
 * poll lives at the coordinator level — see useFilePolling there). `fetchStatus`
 * is exposed so sibling mutations (commit / checkout / stash / reset / network)
 * can refresh the status as part of their cascade.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GitStatus } from '@/types/models';

export interface UseGitStatusResult {
  gitStatus: GitStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  /** Re-fetch the current git status. Read-only and idempotent. */
  fetchStatus: () => Promise<void>;
}

export function useGitStatus(worktreeId: string): UseGitStatusResult {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  /**
   * Fetch current git status (branch / dirty / ahead-behind). Issue #779.
   * Read-only and idempotent; the status section never affects commits/diff.
   */
  const fetchStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/status`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStatusError(data.error || 'Failed to fetch git status');
        return;
      }
      const data: GitStatus = await response.json();
      setGitStatus(data);
    } catch {
      setStatusError('Failed to fetch git status');
    } finally {
      setStatusLoading(false);
    }
  }, [worktreeId]);

  // Mount fetch for current status
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return { gitStatus, statusLoading, statusError, fetchStatus };
}
