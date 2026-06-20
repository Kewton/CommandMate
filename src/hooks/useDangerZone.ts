/**
 * useDangerZone (Issue #782, extracted in #922)
 *
 * Owns the Danger Zone reset / revert mutation state (busy / error / conflict)
 * and handlers. Both ops move HEAD, so their success runs `onHeadMoved` — the
 * S3-005 cascade (current status + changes + branches ahead/behind freshness +
 * commit history). This hook holds no read state of its own; the reset target /
 * revert commit hash are supplied by the caller from the Commit History
 * selectedCommit (S3-003). Force-push lives in the network hook (not here).
 */

'use client';

import { useCallback, useState } from 'react';
import type { GitResetMode } from '@/types/git';

export interface UseDangerZoneOptions {
  /**
   * Cross-section refresh run after a reset / revert (HEAD moved): current
   * status + changes + branches + commit history.
   */
  onHeadMoved: () => Promise<void>;
}

export interface UseDangerZoneResult {
  dangerBusy: boolean;
  dangerActionError: string | null;
  dangerConflictNotice: string | null;
  handleReset: (target: string, mode: GitResetMode, confirmBranch: string | undefined) => Promise<void>;
  handleRevert: (commitHash: string, noCommit: boolean) => Promise<void>;
}

export function useDangerZone(worktreeId: string, options: UseDangerZoneOptions): UseDangerZoneResult {
  const { onHeadMoved } = options;

  const [dangerBusy, setDangerBusy] = useState(false);
  const [dangerActionError, setDangerActionError] = useState<string | null>(null);
  const [dangerConflictNotice, setDangerConflictNotice] = useState<string | null>(null);

  const handleReset = useCallback(
    async (target: string, mode: GitResetMode, confirmBranch: string | undefined) => {
      setDangerBusy(true);
      setDangerActionError(null);
      setDangerConflictNotice(null);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/git/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, mode, confirmBranch }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setDangerActionError(data.error || 'Failed to reset');
          return;
        }
        await onHeadMoved();
      } catch {
        setDangerActionError('Failed to reset');
      } finally {
        setDangerBusy(false);
      }
    },
    [worktreeId, onHeadMoved]
  );

  const handleRevert = useCallback(
    async (commitHash: string, noCommit: boolean) => {
      setDangerBusy(true);
      setDangerActionError(null);
      setDangerConflictNotice(null);
      try {
        const response = await fetch(`/api/worktrees/${worktreeId}/git/revert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commitHash, noCommit }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setDangerActionError(data.error || 'Failed to revert');
          return;
        }
        const data = await response.json().catch(() => ({}));
        if (data.conflict) {
          const files = Array.isArray(data.conflictFiles) ? data.conflictFiles.join(', ') : '';
          setDangerConflictNotice(`Revert produced conflicts: ${files}`);
        }
        await onHeadMoved();
      } catch {
        setDangerActionError('Failed to revert');
      } finally {
        setDangerBusy(false);
      }
    },
    [worktreeId, onHeadMoved]
  );

  return {
    dangerBusy,
    dangerActionError,
    dangerConflictNotice,
    handleReset,
    handleRevert,
  };
}
