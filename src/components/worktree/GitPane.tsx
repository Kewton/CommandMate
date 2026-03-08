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
import type { CommitInfo, ChangedFile } from '@/types/git';

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

  // ========================================================================
  // Render
  // ========================================================================

  return (
    <div className={`flex flex-col overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Commit History
        </h3>
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
      {isLoading && (
        <div className="flex items-center justify-center py-8" role="status">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cyan-500" />
          <span className="sr-only">Loading commit history...</span>
        </div>
      )}

      {/* Commit-level error state */}
      {commitError && !isLoading && (
        <div className="px-3 py-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {commitError}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !commitError && commits.length === 0 && (
        <div className="px-3 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No commits found
        </div>
      )}

      {/* Commit list + detail split layout */}
      {!isLoading && !commitError && commits.length > 0 && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Upper: Commit list (scrollable, max 40%) */}
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

          {/* Lower: Changed files + Diff (scrollable) */}
          {selectedCommit && (
            <div className="flex-1 overflow-y-auto min-h-0 border-t border-gray-200 dark:border-gray-700">
              {/* Changed files header */}
              <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 sticky top-0 z-10">
                Changed Files
              </div>

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
                        <span className={`inline-block w-14 font-medium ${
                          file.status === 'added' ? 'text-green-600 dark:text-green-400' :
                          file.status === 'deleted' ? 'text-red-600 dark:text-red-400' :
                          file.status === 'renamed' ? 'text-blue-600 dark:text-blue-400' :
                          'text-yellow-600 dark:text-yellow-400'
                        }`}>
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

              {/* Inline diff viewer (mobile only) */}
              {isMobile && selectedFile && (
                <div className="border-t border-gray-200 dark:border-gray-700">
                  <div className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 sticky top-0 z-10">
                    Diff: {selectedFile}
                  </div>
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
