/**
 * GitPane Component
 * Issue #447: Git tab - commit history & diff display
 *
 * Displays commit history, changed files per commit, and file diffs.
 * Uses execFile-based API endpoints for security.
 *
 * PC: Clicking a file triggers onDiffSelect to show diff in the right pane.
 * Mobile: Diff is displayed inline within this component.
 */

'use client';

import React, { useEffect, useState, useCallback, memo } from 'react';
import type { CommitInfo, ChangedFile, GitStagedResponse } from '@/types/git';
import type { GitStatus } from '@/types/models';
import { useFilePolling } from '@/hooks/useFilePolling';
import { GIT_STATUS_POLL_INTERVAL_MS } from '@/config/git-status-config';

// ============================================================================
// Types
// ============================================================================

interface GitPaneProps {
  worktreeId: string;
  /** Called when a diff is selected (PC: displays in right pane) */
  onDiffSelect: (diff: string, filePath: string) => void;
  /** When true, shows diff inline instead of calling onDiffSelect */
  isMobile?: boolean;
  className?: string;
}

// ============================================================================
// Status -> color mapping (Issue #780)
// Exhaustive Record over ChangedFile['status']; untracked/unmerged get distinct
// colors so they never silently fall back to the modified yellow.
// ============================================================================

const STATUS_TEXT_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-green-600 dark:text-green-400',
  modified: 'text-yellow-600 dark:text-yellow-400',
  deleted: 'text-red-600 dark:text-red-400',
  renamed: 'text-blue-600 dark:text-blue-400',
  untracked: 'text-teal-600 dark:text-teal-400',
  unmerged: 'text-orange-600 dark:text-orange-400',
};

// ============================================================================
// Sub-components
// ============================================================================

const RefreshIcon = memo(function RefreshIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
});

/**
 * Render a single diff line with appropriate color
 */
const DiffLine = memo(function DiffLine({ line }: { line: string }) {
  let className = 'whitespace-pre font-mono text-xs';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    className += ' text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    className += ' text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20';
  } else if (line.startsWith('@@')) {
    className += ' text-blue-600 dark:text-blue-400';
  } else {
    className += ' text-gray-700 dark:text-gray-300';
  }

  return <div className={className}>{line}</div>;
});

/**
 * Inline error display for sub-section errors
 */
const InlineError = memo(function InlineError({ message }: { message: string }) {
  return (
    <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400" role="alert">
      {message}
    </div>
  );
});

// ============================================================================
// Current Status section (Issue #779)
// ============================================================================

interface CurrentStatusSectionProps {
  gitStatus: GitStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  isMobile: boolean;
  onRefresh: () => void;
}

/**
 * Current Status section displayed at the top of GitPane (Issue #779).
 *
 * Shows the current branch chip, an "uncommitted" dirty badge, ahead/behind
 * counts (only when aheadBehind is non-null), a branch-mismatch warning, and a
 * dedicated refresh button. Failures are surfaced inline and never affect the
 * commit history / diff sections below.
 */
const CurrentStatusSection = memo(function CurrentStatusSection({
  gitStatus,
  statusLoading,
  statusError,
  isMobile,
  onRefresh,
}: CurrentStatusSectionProps) {
  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 border-b border-gray-200 dark:border-gray-700"
      data-testid="git-status-section"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Current Status
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
          aria-label="Refresh git status"
        >
          <RefreshIcon />
        </button>
      </div>

      {/* Loading: only show the spinner before the first successful load */}
      {statusLoading && !gitStatus && (
        <div className="flex items-center gap-2 py-1" role="status">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
          <span className="sr-only">Loading git status...</span>
        </div>
      )}

      {/* Error (does not affect commit history / diff) */}
      {statusError && !gitStatus && (
        <div
          className="text-xs text-red-600 dark:text-red-400"
          role="alert"
          data-testid="git-status-error"
        >
          {statusError}
        </div>
      )}

      {gitStatus && (
        <>
          <div className={`flex items-center flex-wrap ${isMobile ? 'gap-1.5' : 'gap-2'}`}>
            {/* Branch chip */}
            <span
              className="inline-flex items-center max-w-full truncate rounded px-2 py-0.5 text-xs font-mono bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300"
              data-testid="git-status-branch-chip"
              title={gitStatus.currentBranch}
            >
              {gitStatus.currentBranch}
            </span>

            {/* Dirty badge */}
            {gitStatus.isDirty && (
              <span
                className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300"
                data-testid="git-status-dirty-badge"
              >
                uncommitted
              </span>
            )}

            {/* Ahead/behind (only when non-null) */}
            {gitStatus.aheadBehind && (
              <span
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-mono bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                data-testid="git-status-ahead-behind"
              >
                <span title="commits ahead of upstream">↑{gitStatus.aheadBehind.ahead}</span>
                <span title="commits behind upstream">↓{gitStatus.aheadBehind.behind}</span>
              </span>
            )}
          </div>

          {/* Branch mismatch warning */}
          {gitStatus.isBranchMismatch && (
            <div
              className="flex items-center gap-1.5 rounded px-2 py-1 text-xs bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40"
              role="alert"
              data-testid="git-status-mismatch-warning"
            >
              <span aria-hidden="true">⚠</span>
              <span>
                Branch changed from{' '}
                <span className="font-medium">{gitStatus.initialBranch}</span>
                {' '}to{' '}
                <span className="font-medium">{gitStatus.currentBranch}</span>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
});

// ============================================================================
// Changes section (Issue #780): staged / unstaged / untracked + commit form
// ============================================================================

/**
 * Working-tree diff mode for the Changes section (Issue #780). Identifies which
 * git working-tree diff the per-file Diff button should request.
 */
type ChangesDiffMode = 'staged' | 'unstaged' | 'untracked';

interface ChangedFileListProps {
  title: string;
  testId: string;
  files: ChangedFile[];
  /** Action label for the per-file toggle button (e.g. 'Stage' / 'Unstage') */
  actionLabel: string;
  /** Which working-tree diff this list's Diff button should request */
  mode: ChangesDiffMode;
  defaultOpen: boolean;
  busy: boolean;
  onDiff: (filePath: string, mode: ChangesDiffMode) => void;
  onToggleStage: (filePath: string) => void;
}

/**
 * A single collapsible list of changed files (Staged / Unstaged / Untracked).
 * Each row shows the status badge, the path, a diff button, and a
 * stage/unstage toggle button.
 */
const ChangedFileList = memo(function ChangedFileList({
  title,
  testId,
  files,
  actionLabel,
  mode,
  defaultOpen,
  busy,
  onDiff,
  onToggleStage,
}: ChangedFileListProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-t border-gray-100 dark:border-gray-800" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
      >
        <span className="w-4 text-center">{open ? '▼' : '▶'}</span>
        {title} ({files.length})
      </button>
      {open && files.length === 0 && (
        <div className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500">None</div>
      )}
      {open && files.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {files.map((file) => (
            <li key={`${file.status}:${file.path}`} className="flex items-center gap-2 px-3 py-1.5">
              <span className={`inline-block w-16 shrink-0 text-xs font-medium ${STATUS_TEXT_COLOR[file.status]}`}>
                {file.status}
              </span>
              <span className="flex-1 truncate font-mono text-xs text-gray-700 dark:text-gray-300" title={file.path}>
                {file.path}
              </span>
              <button
                type="button"
                onClick={() => onDiff(file.path, mode)}
                className="shrink-0 px-1.5 py-0.5 text-xs text-cyan-600 dark:text-cyan-400 hover:underline"
                aria-label={`Show diff for ${file.path}`}
                data-testid="git-changes-diff-button"
              >
                Diff
              </button>
              <button
                type="button"
                onClick={() => onToggleStage(file.path)}
                disabled={busy}
                className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                aria-label={`${actionLabel} ${file.path}`}
                data-testid="git-changes-toggle-button"
              >
                {actionLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

interface ChangesSectionProps {
  staged: GitStagedResponse | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  commitMessage: string;
  amend: boolean;
  committing: boolean;
  commitError: string | null;
  isMobile: boolean;
  onRefresh: () => void;
  onDiff: (filePath: string, mode: ChangesDiffMode) => void;
  onStage: (filePath: string) => void;
  onUnstage: (filePath: string) => void;
  onCommitMessageChange: (value: string) => void;
  onAmendChange: (value: boolean) => void;
  onCommit: () => void;
}

/**
 * Changes section (Issue #780). Rendered directly below the #779 Current Status
 * section and above Commit History. Shows three collapsible lists
 * (Staged / Unstaged / Untracked) plus a commit message textarea, an amend
 * checkbox, and a commit button. On mobile the sub-lists default-collapse.
 */
const ChangesSection = memo(function ChangesSection({
  staged,
  loading,
  error,
  busy,
  commitMessage,
  amend,
  committing,
  commitError,
  isMobile,
  onRefresh,
  onDiff,
  onStage,
  onUnstage,
  onCommitMessageChange,
  onAmendChange,
  onCommit,
}: ChangesSectionProps) {
  const stagedFiles = staged?.staged ?? [];
  const unstagedFiles = staged?.unstaged ?? [];
  const untrackedFiles = staged?.untracked ?? [];

  // Commit is allowed when there are staged changes, OR when amending (which can
  // rewrite the previous commit without new staged content).
  const canCommit = !committing && commitMessage.trim().length > 0 && (stagedFiles.length > 0 || amend);
  // Sub-lists default open on PC, collapsed on mobile.
  const defaultOpen = !isMobile;

  return (
    <div
      className="flex flex-col border-b border-gray-200 dark:border-gray-700"
      data-testid="git-changes-section"
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Changes</span>
        <button
          type="button"
          onClick={onRefresh}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
          aria-label="Refresh changes"
        >
          <RefreshIcon />
        </button>
      </div>

      {loading && !staged && (
        <div className="flex items-center gap-2 px-3 pb-2" role="status">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
          <span className="sr-only">Loading changes...</span>
        </div>
      )}

      {error && !staged && (
        <div
          className="px-3 pb-2 text-xs text-red-600 dark:text-red-400"
          role="alert"
          data-testid="git-changes-error"
        >
          {error}
        </div>
      )}

      {staged && (
        <>
          <ChangedFileList
            title="Staged"
            testId="git-staged-list"
            files={stagedFiles}
            actionLabel="Unstage"
            mode="staged"
            defaultOpen={defaultOpen}
            busy={busy}
            onDiff={onDiff}
            onToggleStage={onUnstage}
          />
          <ChangedFileList
            title="Unstaged"
            testId="git-unstaged-list"
            files={unstagedFiles}
            actionLabel="Stage"
            mode="unstaged"
            defaultOpen={defaultOpen}
            busy={busy}
            onDiff={onDiff}
            onToggleStage={onStage}
          />
          <ChangedFileList
            title="Untracked"
            testId="git-untracked-list"
            files={untrackedFiles}
            actionLabel="Stage"
            mode="untracked"
            defaultOpen={defaultOpen}
            busy={busy}
            onDiff={onDiff}
            onToggleStage={onStage}
          />

          {/* Commit form */}
          <div className="flex flex-col gap-2 px-3 py-2 border-t border-gray-100 dark:border-gray-800">
            <textarea
              value={commitMessage}
              onChange={(e) => onCommitMessageChange(e.target.value)}
              placeholder="Commit message"
              rows={isMobile ? 2 : 3}
              className="w-full resize-y rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              data-testid="git-commit-message"
              aria-label="Commit message"
            />
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={amend}
                  onChange={(e) => onAmendChange(e.target.checked)}
                  data-testid="git-amend-checkbox"
                />
                Amend
              </label>
              <button
                type="button"
                onClick={onCommit}
                disabled={!canCommit}
                className="px-3 py-1 text-xs font-medium rounded bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="git-commit-button"
              >
                {committing ? 'Committing...' : 'Commit'}
              </button>
            </div>
            {commitError && (
              <div
                className="text-xs text-red-600 dark:text-red-400"
                role="alert"
                data-testid="git-commit-error"
              >
                {commitError}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});

// ============================================================================
// Main Component
// ============================================================================

export const GitPane = memo(function GitPane({
  worktreeId,
  onDiffSelect,
  isMobile = false,
  className = '',
}: GitPaneProps) {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Collapsible section states
  const [commitListOpen, setCommitListOpen] = useState(true);
  const [changedFilesOpen, setChangedFilesOpen] = useState(true);
  const [diffOpen, setDiffOpen] = useState(true);

  // Issue #779: Current Status (self-fetched, independent of commit history)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Issue #780: Changes (staged / unstaged / untracked) + commit form
  const [staged, setStaged] = useState<GitStagedResponse | null>(null);
  const [stagedLoading, setStagedLoading] = useState(true);
  const [stagedError, setStagedError] = useState<string | null>(null);
  const [opBusy, setOpBusy] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [changesCommitError, setChangesCommitError] = useState<string | null>(null);

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

  // Polling (5s, visibilitychange-aware). enabled=true is intentional (DR1-002):
  // keep polling through loading/error so recovery is automatic; stop is handled
  // by visibilitychange + unmount + worktreeId change.
  useFilePolling({ intervalMs: GIT_STATUS_POLL_INTERVAL_MS, enabled: true, onPoll: fetchStatus });

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

  /**
   * Handle current-status refresh (Issue #779)
   */
  const handleStatusRefresh = useCallback(() => {
    fetchStatus();
  }, [fetchStatus]);

  // ------------------------------------------------------------------------
  // Issue #780: Changes handlers (stage / unstage / commit + diff)
  // ------------------------------------------------------------------------

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
  const handleCommit = useCallback(async () => {
    setCommitting(true);
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
        return;
      }
      setCommitMessage('');
      setAmend(false);
      await fetchStaged();
      await fetchCommits();
      await fetchStatus();
    } catch {
      setChangesCommitError('Failed to commit');
    } finally {
      setCommitting(false);
    }
  }, [worktreeId, commitMessage, amend, fetchStaged, fetchCommits, fetchStatus]);

  /**
   * Show the diff for a working-tree file (Issue #780). Uses the dedicated
   * working-tree diff endpoint (NOT the commit-scoped /git/diff route), passing
   * the list's mode (staged / unstaged / untracked). Routes the result through
   * onDiffSelect, the same display path as commit diffs (mobile inline reuse
   * works because setDiffContent feeds the inline viewer). Failures are kept
   * non-fatal, though they should not occur for valid files.
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
        setDiffContent(data.diff);
        onDiffSelect(data.diff, filePath);
      }
    } catch {
      // Diff failures for working-tree files are non-fatal; ignored.
    }
  }, [worktreeId, onDiffSelect]);

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      {/* Current Status (Issue #779) - top of the pane, above Commit History */}
      <CurrentStatusSection
        gitStatus={gitStatus}
        statusLoading={statusLoading}
        statusError={statusError}
        isMobile={isMobile}
        onRefresh={handleStatusRefresh}
      />

      {/* Changes (Issue #780) - below Current Status, above Commit History */}
      <ChangesSection
        staged={staged}
        loading={stagedLoading}
        error={stagedError}
        busy={opBusy}
        commitMessage={commitMessage}
        amend={amend}
        committing={committing}
        commitError={changesCommitError}
        isMobile={isMobile}
        onRefresh={fetchStaged}
        onDiff={handleChangesDiff}
        onStage={handleStage}
        onUnstage={handleUnstage}
        onCommitMessageChange={setCommitMessage}
        onAmendChange={setAmend}
        onCommit={handleCommit}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={() => setCommitListOpen((prev) => !prev)}
          className="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer hover:text-gray-900 dark:hover:text-gray-100"
        >
          <span className="text-xs w-4 text-center">{commitListOpen ? '▼' : '▶'}</span>
          Commit History
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
          aria-label="Refresh commit history"
        >
          <RefreshIcon />
        </button>
      </div>

      {/* Loading state */}
      {commitListOpen && isLoading && (
        <div className="flex items-center justify-center py-8" role="status">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cyan-500" />
          <span className="sr-only">Loading commit history...</span>
        </div>
      )}

      {/* Commit-level error state */}
      {commitListOpen && commitError && !isLoading && (
        <div className="px-3 py-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {commitError}
        </div>
      )}

      {/* Empty state */}
      {commitListOpen && !isLoading && !commitError && commits.length === 0 && (
        <div className="px-3 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No commits found
        </div>
      )}

      {/* Commit list + detail split layout */}
      {!isLoading && !commitError && commits.length > 0 && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Upper: Commit list (scrollable, max 40% when open) */}
          {commitListOpen && (
            <div className={`overflow-y-auto ${selectedCommit ? 'max-h-[40%] shrink-0' : 'flex-1'}`}>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {commits.map((commit) => (
                  <li key={commit.hash}>
                    <button
                      type="button"
                      onClick={() => handleCommitSelect(commit.hash)}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                        selectedCommit === commit.hash
                          ? 'bg-cyan-50 dark:bg-cyan-900/30'
                          : ''
                      }`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-xs text-cyan-600 dark:text-cyan-400 shrink-0">
                          {commit.shortHash}
                        </span>
                        <span className="truncate text-gray-800 dark:text-gray-200">
                          {commit.message}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        <span>{commit.author}</span>
                        <span>{new Date(commit.date).toLocaleDateString()}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Lower: Changed files + Diff (scrollable) */}
          {selectedCommit && (
            <div className="flex-1 overflow-y-auto min-h-0 border-t border-gray-200 dark:border-gray-700">
              {/* Changed files header */}
              <button
                type="button"
                onClick={() => setChangedFilesOpen((prev) => !prev)}
                className="w-full flex items-center gap-1 px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 sticky top-0 z-10 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200"
              >
                <span className="w-4 text-center">{changedFilesOpen ? '▼' : '▶'}</span>
                Changed Files
              </button>

              {changedFilesOpen && (
                <>
                  {/* Detail-level error (files/diff) - shown inline */}
                  {detailError && <InlineError message={detailError} />}

                  {isLoadingFiles && (
                    <div className="flex items-center justify-center py-4" role="status">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
                      <span className="sr-only">Loading changed files...</span>
                    </div>
                  )}
                  {!isLoadingFiles && !detailError && changedFiles.length === 0 && (
                    <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                      No changed files
                    </div>
                  )}
                  {!isLoadingFiles && changedFiles.length > 0 && (
                    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                      {changedFiles.map((file) => (
                        <li key={file.path}>
                          <button
                            type="button"
                            onClick={() => handleFileSelect(file.path)}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                              selectedFile === file.path
                                ? 'bg-cyan-50 dark:bg-cyan-900/30'
                                : ''
                            }`}
                          >
                            <span className={`inline-block w-14 font-medium ${STATUS_TEXT_COLOR[file.status]}`}>
                              {file.status}
                            </span>
                            <span className="font-mono text-gray-700 dark:text-gray-300">
                              {file.path}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              {/* Inline diff viewer (mobile only) */}
              {isMobile && selectedFile && (
                <div className="border-t border-gray-200 dark:border-gray-700">
                  <button
                    type="button"
                    onClick={() => setDiffOpen((prev) => !prev)}
                    className="w-full flex items-center gap-1 px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 sticky top-0 z-10 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    <span className="w-4 text-center">{diffOpen ? '▼' : '▶'}</span>
                    Diff: {selectedFile}
                  </button>
                  {diffOpen && (
                    <>
                      {isLoadingDiff && (
                        <div className="flex items-center justify-center py-4" role="status">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500" />
                          <span className="sr-only">Loading diff...</span>
                        </div>
                      )}
                      {!isLoadingDiff && diffContent && (
                        <div className="overflow-x-auto p-2">
                          <pre className="text-xs">
                            <code>
                              {diffContent.split('\n').map((line, index) => (
                                <DiffLine key={index} line={line} />
                              ))}
                            </code>
                          </pre>
                        </div>
                      )}
                      {!isLoadingDiff && !diffContent && !detailError && (
                        <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                          No diff available
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* PC: show selected file indicator */}
              {!isMobile && selectedFile && !detailError && (
                <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700">
                  {isLoadingDiff ? 'Loading diff...' : `Diff displayed in file panel: ${selectedFile}`}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default GitPane;
