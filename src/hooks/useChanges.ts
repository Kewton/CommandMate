/**
 * useChanges (Issue #780, extracted in #922)
 *
 * Owns the working-tree "Changes" state: staged / unstaged / untracked lists,
 * the commit message + amend form, and the stage / unstage / commit / diff /
 * preview handlers. The commit cascade refetches the changes list itself, then
 * calls `onCommitted` for the cross-section refresh (commit history + current
 * status) so this hook stays decoupled from those siblings. `commitAndPush`
 * (Issue #816 A) commits, then runs the injected push only if the commit
 * succeeds — the GitPane body supplies the network push.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { GitStagedResponse } from '@/types/git';
import type { ChangesDiffMode } from '@/components/worktree/git/gitPaneShared';

export interface UseChangesOptions {
  /**
   * Show a working-tree file diff. The GitPane body composes this from the
   * commit-history `setDiffContent` (so the mobile inline viewer updates) and
   * the external `onDiffSelect` (so the PC right-hand file pane updates) — the
   * exact pair the former god-component ran inline.
   */
  onWorkingDiff: (diff: string, filePath: string) => void;
  /**
   * Cross-section refresh run after a successful commit (commit history +
   * current status). The changes list itself is refetched by this hook first.
   */
  onCommitted: () => Promise<void>;
}

export interface UseChangesResult {
  staged: GitStagedResponse | null;
  stagedLoading: boolean;
  stagedError: string | null;
  opBusy: boolean;
  commitMessage: string;
  setCommitMessage: (value: string) => void;
  amend: boolean;
  setAmend: (value: boolean) => void;
  committing: boolean;
  changesCommitError: string | null;
  fetchStaged: () => Promise<void>;
  handleStage: (filePath: string) => Promise<void>;
  handleUnstage: (filePath: string) => Promise<void>;
  handleChangesDiff: (filePath: string, mode: ChangesDiffMode) => Promise<void>;
  fetchWorkingDiffText: (filePath: string, mode: ChangesDiffMode) => Promise<string | null>;
  /** Commit (manages the `committing` flag). */
  commit: () => Promise<void>;
  /** Issue #816 (A): commit, then run `push` only if the commit succeeded. */
  commitAndPush: (push: () => Promise<void>) => Promise<void>;
}

export function useChanges(worktreeId: string, options: UseChangesOptions): UseChangesResult {
  const { onWorkingDiff, onCommitted } = options;

  const [staged, setStaged] = useState<GitStagedResponse | null>(null);
  const [stagedLoading, setStagedLoading] = useState(true);
  const [stagedError, setStagedError] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [changesCommitError, setChangesCommitError] = useState<string | null>(null);

  /**
   * Fetch the working-tree changes (staged / unstaged / untracked). Issue #780.
   * Read-only; failures surface inline and never affect commits/diff.
   */
  const fetchStaged = useCallback(async () => {
    setStagedError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/staged`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStagedError(data.error || 'Failed to fetch changes');
        return;
      }
      const data: GitStagedResponse = await response.json();
      setStaged(data);
    } catch {
      setStagedError('Failed to fetch changes');
    } finally {
      setStagedLoading(false);
    }
  }, [worktreeId]);

  // Mount fetch for changes
  useEffect(() => {
    fetchStaged();
  }, [fetchStaged]);

  /**
   * Stage one or more files, then immediately refetch the changes list.
   */
  const handleStage = useCallback(async (filePath: string) => {
    setOpBusy(true);
    setStagedError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [filePath] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStagedError(data.error || 'Failed to stage file');
        return;
      }
      await fetchStaged();
    } catch {
      setStagedError('Failed to stage file');
    } finally {
      setOpBusy(false);
    }
  }, [worktreeId, fetchStaged]);

  /**
   * Unstage one or more files, then immediately refetch the changes list.
   */
  const handleUnstage = useCallback(async (filePath: string) => {
    setOpBusy(true);
    setStagedError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/unstage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [filePath] }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setStagedError(data.error || 'Failed to unstage file');
        return;
      }
      await fetchStaged();
    } catch {
      setStagedError('Failed to unstage file');
    } finally {
      setOpBusy(false);
    }
  }, [worktreeId, fetchStaged]);

  /**
   * Create a commit. On success: clear the message, refetch changes, AND
   * refetch commit history + current status immediately (do not wait for the
   * 5s poll). The /git/log refresh button (handleRefresh) is deliberately NOT
   * wired here so the existing GitPane test stays intact.
   */
  const doCommit = useCallback(async (): Promise<boolean> => {
    setChangesCommitError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMessage, amend }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setChangesCommitError(data.error || 'Failed to commit');
        return false;
      }
      setCommitMessage('');
      setAmend(false);
      await fetchStaged();
      await onCommitted();
      return true;
    } catch {
      setChangesCommitError('Failed to commit');
      return false;
    }
  }, [worktreeId, commitMessage, amend, fetchStaged, onCommitted]);

  const commit = useCallback(async () => {
    setCommitting(true);
    try {
      await doCommit();
    } finally {
      setCommitting(false);
    }
  }, [doCommit]);

  /**
   * Issue #816 (A): commit, then push in one action. The push runs ONLY if the
   * commit succeeds (doCommit returns false + surfaces the inline commit error
   * otherwise). A push failure is surfaced by the NetworkOperationsSection; the
   * commit is already saved (no rollback — the button title states this).
   */
  const commitAndPush = useCallback(async (push: () => Promise<void>) => {
    setCommitting(true);
    try {
      const ok = await doCommit();
      if (ok) {
        await push();
      }
    } finally {
      setCommitting(false);
    }
  }, [doCommit]);

  /**
   * Show the diff for a working-tree file (Issue #780). Uses the dedicated
   * working-tree diff endpoint (NOT the commit-scoped /git/diff route), passing
   * the list's mode (staged / unstaged / untracked). Routes the result through
   * onWorkingDiff (setDiffContent + onDiffSelect), the same display path as
   * commit diffs. Failures are kept non-fatal, though they should not occur for
   * valid files.
   */
  const handleChangesDiff = useCallback(async (filePath: string, mode: ChangesDiffMode) => {
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/git/working-diff?file=${encodeURIComponent(filePath)}&mode=${mode}`
      );
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (typeof data.diff === 'string') {
        onWorkingDiff(data.diff, filePath);
      }
    } catch {
      // Diff failures for working-tree files are non-fatal; ignored.
    }
  }, [worktreeId, onWorkingDiff]);

  /**
   * Issue #816 (C): fetch the raw working-tree diff text for the inline preview
   * caret in the Changes section. Unlike handleChangesDiff, this RETURNS the diff
   * string (does NOT route through onDiffSelect), so the caller can render a short
   * inline preview. Failures resolve to null (preview shows "No diff available").
   */
  const fetchWorkingDiffText = useCallback(
    async (filePath: string, mode: ChangesDiffMode): Promise<string | null> => {
      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/git/working-diff?file=${encodeURIComponent(filePath)}&mode=${mode}`
        );
        if (!response.ok) return null;
        const data = await response.json();
        return typeof data.diff === 'string' ? data.diff : null;
      } catch {
        return null;
      }
    },
    [worktreeId]
  );

  return {
    staged,
    stagedLoading,
    stagedError,
    opBusy,
    commitMessage,
    setCommitMessage,
    amend,
    setAmend,
    committing,
    changesCommitError,
    fetchStaged,
    handleStage,
    handleUnstage,
    handleChangesDiff,
    fetchWorkingDiffText,
    commit,
    commitAndPush,
  };
}
