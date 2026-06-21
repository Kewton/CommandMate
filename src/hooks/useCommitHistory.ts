/**
 * useCommitHistory (Issue #447/#816, extracted in #922)
 *
 * Owns the commit-history read state: the commit list, the selected-commit
 * Changed Files detail path, the per-commit inline "View diff" accordion
 * (Issue #816 B), and the diff content for the mobile inline viewer. `fetchDiff`
 * routes the result through `onDiffSelect` so the PC right-hand file pane updates,
 * exactly as before. `fetchCommits` is exposed so sibling mutations (commit /
 * checkout / reset / revert / pull) can refresh the log as part of their cascade.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ChangedFile, CommitInfo } from '@/types/git';

export interface UseCommitHistoryResult {
  commits: CommitInfo[];
  selectedCommit: string | null;
  changedFiles: ChangedFile[];
  inlineDiffCommit: string | null;
  inlineFiles: ChangedFile[];
  inlineFilesLoading: boolean;
  inlineFilesError: string | null;
  selectedFile: string | null;
  diffContent: string | null;
  isLoading: boolean;
  isLoadingFiles: boolean;
  isLoadingDiff: boolean;
  commitError: string | null;
  detailError: string | null;
  /**
   * Issue #816 (C): exposed so the Changes section's working-tree Diff button can
   * feed the same `diffContent` the mobile inline viewer reads (the former
   * god-component set this inline alongside onDiffSelect).
   */
  setDiffContent: (diff: string | null) => void;
  fetchCommits: () => Promise<void>;
  handleCommitSelect: (commitHash: string) => void;
  handleFileSelect: (filePath: string) => void;
  handleToggleInlineDiff: (commitHash: string) => Promise<void>;
  handleInlineDiffFile: (commitHash: string, filePath: string) => void;
  handleRefresh: () => void;
}

export function useCommitHistory(
  worktreeId: string,
  onDiffSelect: (diff: string, filePath: string) => void
): UseCommitHistoryResult {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);

  // Issue #816 (B): Commit History inline "View diff" accordion. Independent of
  // selectedCommit so the existing commit -> Changed Files detail path is kept.
  const [inlineDiffCommit, setInlineDiffCommit] = useState<string | null>(null);
  const [inlineFiles, setInlineFiles] = useState<ChangedFile[]>([]);
  const [inlineFilesLoading, setInlineFilesLoading] = useState(false);
  const [inlineFilesError, setInlineFilesError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  /**
   * Fetch commit history
   */
  const fetchCommits = useCallback(async () => {
    setIsLoading(true);
    setCommitError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/log`);
      if (!response.ok) {
        const data = await response.json();
        setCommitError(data.error || 'Failed to fetch commit history');
        return;
      }
      const data = await response.json();
      setCommits(data.commits);
    } catch {
      setCommitError('Failed to fetch commit history');
    } finally {
      setIsLoading(false);
    }
  }, [worktreeId]);

  /**
   * Fetch changed files for a commit
   */
  const fetchChangedFiles = useCallback(async (commitHash: string) => {
    setIsLoadingFiles(true);
    setChangedFiles([]);
    setSelectedFile(null);
    setDiffContent(null);
    setDetailError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/show/${commitHash}`);
      if (!response.ok) {
        const data = await response.json();
        setDetailError(data.error || 'Failed to fetch commit details');
        return;
      }
      const data = await response.json();
      setChangedFiles(data.files);
    } catch {
      setDetailError('Failed to fetch commit details');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [worktreeId]);

  /**
   * Fetch diff for a specific file
   */
  const fetchDiff = useCallback(async (commitHash: string, filePath: string) => {
    setIsLoadingDiff(true);
    setDiffContent(null);
    setDetailError(null);
    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/git/diff?commit=${commitHash}&file=${encodeURIComponent(filePath)}`
      );
      if (!response.ok) {
        const data = await response.json();
        setDetailError(data.error || 'Failed to fetch diff');
        return;
      }
      const data = await response.json();
      setDiffContent(data.diff);
      onDiffSelect(data.diff, filePath);
    } catch {
      setDetailError('Failed to fetch diff');
    } finally {
      setIsLoadingDiff(false);
    }
  }, [worktreeId, onDiffSelect]);

  // Fetch commits on mount
  useEffect(() => {
    fetchCommits();
  }, [fetchCommits]);

  /**
   * Handle commit selection
   */
  const handleCommitSelect = useCallback((commitHash: string) => {
    setSelectedCommit(commitHash);
    fetchChangedFiles(commitHash);
  }, [fetchChangedFiles]);

  /**
   * Handle file selection
   */
  const handleFileSelect = useCallback((filePath: string) => {
    if (!selectedCommit) return;
    setSelectedFile(filePath);
    fetchDiff(selectedCommit, filePath);
  }, [selectedCommit, fetchDiff]);

  /**
   * Issue #816 (B): toggle the inline "View diff" accordion for a commit row.
   * Expanding fetches the commit's changed-file list into a state SEPARATE from
   * the selectedCommit detail path (kept for backwards compat). Re-clicking the
   * same commit collapses it.
   */
  const handleToggleInlineDiff = useCallback(async (commitHash: string) => {
    if (inlineDiffCommit === commitHash) {
      setInlineDiffCommit(null);
      setInlineFiles([]);
      setInlineFilesError(null);
      return;
    }
    setInlineDiffCommit(commitHash);
    setInlineFiles([]);
    setInlineFilesError(null);
    setInlineFilesLoading(true);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/show/${commitHash}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setInlineFilesError(data.error || 'Failed to fetch commit details');
        return;
      }
      const data = await response.json();
      setInlineFiles(Array.isArray(data.files) ? data.files : []);
    } catch {
      setInlineFilesError('Failed to fetch commit details');
    } finally {
      setInlineFilesLoading(false);
    }
  }, [worktreeId, inlineDiffCommit]);

  /**
   * Issue #816 (B): a file clicked inside the inline accordion. Routes through
   * the existing selection state (selectedCommit / selectedFile / changedFiles)
   * so the diff is shown via onDiffSelect (PC) / the mobile inline viewer, and
   * the Danger Zone selectedCommit stays coherent — i.e. it reuses the same
   * "diff modal" display path as the detail list.
   */
  const handleInlineDiffFile = useCallback((commitHash: string, filePath: string) => {
    setSelectedCommit(commitHash);
    setSelectedFile(filePath);
    setChangedFiles(inlineFiles);
    fetchDiff(commitHash, filePath);
  }, [inlineFiles, fetchDiff]);

  /**
   * Handle refresh
   */
  const handleRefresh = useCallback(() => {
    setSelectedCommit(null);
    setChangedFiles([]);
    setSelectedFile(null);
    setDiffContent(null);
    setDetailError(null);
    fetchCommits();
  }, [fetchCommits]);

  return {
    commits,
    selectedCommit,
    changedFiles,
    inlineDiffCommit,
    inlineFiles,
    inlineFilesLoading,
    inlineFilesError,
    selectedFile,
    diffContent,
    isLoading,
    isLoadingFiles,
    isLoadingDiff,
    commitError,
    detailError,
    setDiffContent,
    fetchCommits,
    handleCommitSelect,
    handleFileSelect,
    handleToggleInlineDiff,
    handleInlineDiffFile,
    handleRefresh,
  };
}
