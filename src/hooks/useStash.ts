/**
 * useStash (Issue #782, extracted in #922)
 *
 * Owns the Stash state: the stash list, busy / error / conflict flags, and the
 * push / pop / apply / drop handlers. NO new 5s poll (S3-004): fetched on mount
 * + after a mutation only. A stash op changes the working tree, so each mutation
 * runs `onStashMutated` (current status + changes) alongside this hook's own
 * stash refetch. pop/apply can succeed (HTTP 200) yet leave conflict markers;
 * the conflict notice is surfaced like the Danger Zone revert path.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StashInfo } from '@/types/git';

export interface UseStashOptions {
  /**
   * Cross-section refresh run after a stash mutation (working tree changed):
   * current status + changes. This hook adds its own stash refetch in parallel.
   */
  onStashMutated: () => Promise<void>;
}

export interface UseStashResult {
  stashes: StashInfo[];
  stashLoading: boolean;
  stashError: string | null;
  stashBusy: boolean;
  stashActionError: string | null;
  stashConflictNotice: string | null;
  fetchStash: () => Promise<void>;
  handleStashPush: (message: string, includeUntracked: boolean) => void;
  handleStashPop: (index: number) => void;
  handleStashApply: (index: number) => void;
  handleStashDrop: (index: number) => void;
}

export function useStash(worktreeId: string, options: UseStashOptions): UseStashResult {
  const { onStashMutated } = options;

  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const [stashLoading, setStashLoading] = useState(true);
  const [stashError, setStashError] = useState<string | null>(null);
  const [stashBusy, setStashBusy] = useState(false);
  const [stashActionError, setStashActionError] = useState<string | null>(null);
  const [stashConflictNotice, setStashConflictNotice] = useState<string | null>(null);

  /**
   * Fetch the stash list. Read-only; failures surface inline. NO new 5s poll
   * (S3-004): fetched on mount + after a stash mutation only.
   */
  const fetchStash = useCallback(async () => {
    setStashError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/stash`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStashError(data.error || 'Failed to fetch stashes');
        return;
      }
      const data = await response.json();
      setStashes(Array.isArray(data.stashes) ? data.stashes : []);
    } catch {
      setStashError('Failed to fetch stashes');
    } finally {
      setStashLoading(false);
    }
  }, [worktreeId]);

  // Mount fetch for stash list (no poll).
  useEffect(() => {
    fetchStash();
  }, [fetchStash]);

  /**
   * Shared stash-mutation cascade (S3-004): a stash op changes the working tree,
   * so refetch the stash list + status + staged.
   */
  const stashCascade = useCallback(async () => {
    await Promise.all([fetchStash(), onStashMutated()]);
  }, [fetchStash, onStashMutated]);

  const runStashOp = useCallback(
    async (url: string, init: RequestInit, failMessage: string) => {
      setStashBusy(true);
      setStashActionError(null);
      setStashConflictNotice(null);
      try {
        const response = await fetch(url, init);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setStashActionError(data.error || failMessage);
          return;
        }
        // pop/apply can succeed (HTTP 200) yet leave conflict markers; the API
        // returns { conflict, conflictFiles, stashRetained } in that case. Surface
        // it like the Danger Zone revert path instead of silently cascading.
        if (data.conflict) {
          const files = Array.isArray(data.conflictFiles) ? data.conflictFiles.join(', ') : '';
          const retained = data.stashRetained ? ' (stash retained)' : '';
          setStashConflictNotice(`Stash operation produced conflicts: ${files}${retained}`);
        }
        await stashCascade();
      } catch {
        setStashActionError(failMessage);
      } finally {
        setStashBusy(false);
      }
    },
    [stashCascade]
  );

  const handleStashPush = useCallback(
    (message: string, includeUntracked: boolean) => {
      void runStashOp(
        `/api/worktrees/${worktreeId}/git/stash/push`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: message || undefined, includeUntracked }),
        },
        'Failed to stash changes'
      );
    },
    [worktreeId, runStashOp]
  );

  const handleStashPop = useCallback(
    (index: number) => {
      void runStashOp(
        `/api/worktrees/${worktreeId}/git/stash/pop`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index }),
        },
        'Failed to pop stash'
      );
    },
    [worktreeId, runStashOp]
  );

  const handleStashApply = useCallback(
    (index: number) => {
      void runStashOp(
        `/api/worktrees/${worktreeId}/git/stash/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index }),
        },
        'Failed to apply stash'
      );
    },
    [worktreeId, runStashOp]
  );

  const handleStashDrop = useCallback(
    (index: number) => {
      void runStashOp(
        `/api/worktrees/${worktreeId}/git/stash/${index}`,
        { method: 'DELETE' },
        'Failed to drop stash'
      );
    },
    [worktreeId, runStashOp]
  );

  return {
    stashes,
    stashLoading,
    stashError,
    stashBusy,
    stashActionError,
    stashConflictNotice,
    fetchStash,
    handleStashPush,
    handleStashPop,
    handleStashApply,
    handleStashDrop,
  };
}
