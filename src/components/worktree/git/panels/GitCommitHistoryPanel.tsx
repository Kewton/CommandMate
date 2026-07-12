/**
 * GitCommitHistoryPanel (Issue #447/#816, extracted in #922)
 *
 * Read-only commit history list with the per-commit inline "View diff" accordion
 * (Issue #816 B), the selected-commit Changed Files detail list, and the mobile
 * inline diff viewer. Collapse state for the history list is persisted by the
 * caller (useGitPaneTabState); the Changed Files / Diff collapse states are
 * local UI concerns owned here. `isMobile` is read from GitPaneContext.
 */

'use client';

import { memo, useState } from 'react';
import type { ChangedFile, CommitInfo } from '@/types/git';
import {
  STATUS_TEXT_COLOR,
  DiffLine,
  InlineError,
  RefreshIcon,
} from '@/components/worktree/git/gitPaneShared';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';

export interface GitCommitHistoryPanelProps {
  commits: CommitInfo[];
  isLoading: boolean;
  commitError: string | null;
  /** Commit History collapse state (persisted by useGitPaneTabState). */
  commitListOpen: boolean;
  onToggleCommitList: () => void;
  onRefresh: () => void;
  selectedCommit: string | null;
  onCommitSelect: (commitHash: string) => void;
  /** Issue #816 (B): inline "View diff" accordion. */
  inlineDiffCommit: string | null;
  inlineFiles: ChangedFile[];
  inlineFilesLoading: boolean;
  inlineFilesError: string | null;
  onToggleInlineDiff: (commitHash: string) => void;
  onInlineDiffFile: (commitHash: string, filePath: string) => void;
  /** Selected-commit detail (Changed Files) state. */
  changedFiles: ChangedFile[];
  isLoadingFiles: boolean;
  detailError: string | null;
  selectedFile: string | null;
  onFileSelect: (filePath: string) => void;
  /** Diff state (mobile inline viewer + PC indicator). */
  diffContent: string | null;
  isLoadingDiff: boolean;
}

export const GitCommitHistoryPanel = memo(function GitCommitHistoryPanel({
  commits,
  isLoading,
  commitError,
  commitListOpen,
  onToggleCommitList,
  onRefresh,
  selectedCommit,
  onCommitSelect,
  inlineDiffCommit,
  inlineFiles,
  inlineFilesLoading,
  inlineFilesError,
  onToggleInlineDiff,
  onInlineDiffFile,
  changedFiles,
  isLoadingFiles,
  detailError,
  selectedFile,
  onFileSelect,
  diffContent,
  isLoadingDiff,
}: GitCommitHistoryPanelProps) {
  const { isMobile } = useGitPaneContext();

  // Collapsible section states (local UI concern for the detail view).
  const [changedFilesOpen, setChangedFilesOpen] = useState(true);
  const [diffOpen, setDiffOpen] = useState(true);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <button
          type="button"
          onClick={onToggleCommitList}
          className="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer hover:text-gray-900 dark:hover:text-gray-100"
        >
          <span className="text-xs w-4 text-center">{commitListOpen ? '▼' : '▶'}</span>
          Commit History
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className="p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded"
          aria-label="Refresh commit history"
        >
          <RefreshIcon />
        </button>
      </div>

      {/* Loading state */}
      {commitListOpen && isLoading && (
        <div className="flex items-center justify-center py-8" role="status">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-500" />
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
                {commits.map((commit) => {
                  // Issue #816 (B): inline "View diff" accordion open-state.
                  const inlineOpen = inlineDiffCommit === commit.hash;
                  return (
                    <li key={commit.hash}>
                      <div className="flex items-stretch">
                        <button
                          type="button"
                          onClick={() => onCommitSelect(commit.hash)}
                          className={`flex-1 min-w-0 text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                            selectedCommit === commit.hash
                              ? 'bg-accent-50 dark:bg-accent-900/30'
                              : ''
                          }`}
                        >
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-xs text-accent-600 dark:text-accent-400 shrink-0">
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
                        {/* Issue #816 (B): inline diff toggle. Sibling (not nested)
                            so it does not trigger the commit-select button. */}
                        <button
                          type="button"
                          onClick={() => onToggleInlineDiff(commit.hash)}
                          className="shrink-0 px-2 text-xs text-accent-600 dark:text-accent-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:underline"
                          aria-label={`View diff for ${commit.shortHash}`}
                          aria-expanded={inlineOpen}
                          data-testid="git-commit-view-diff-button"
                        >
                          {inlineOpen ? 'Hide diff' : 'View diff'}
                        </button>
                      </div>

                      {/* Issue #816 (B): inline accordion file list for this commit */}
                      {inlineOpen && (
                        <div
                          className="border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-800/30"
                          data-testid="git-commit-inline-files"
                        >
                          {inlineFilesLoading && (
                            <div className="flex items-center justify-center py-3" role="status">
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent-500" />
                              <span className="sr-only">Loading changed files...</span>
                            </div>
                          )}
                          {inlineFilesError && <InlineError message={inlineFilesError} />}
                          {!inlineFilesLoading && !inlineFilesError && inlineFiles.length === 0 && (
                            <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                              No changed files
                            </div>
                          )}
                          {!inlineFilesLoading && inlineFiles.length > 0 && (
                            <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                              {inlineFiles.map((file) => (
                                <li key={file.path}>
                                  <button
                                    type="button"
                                    onClick={() => onInlineDiffFile(commit.hash, file.path)}
                                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${
                                      selectedFile === file.path && selectedCommit === commit.hash
                                        ? 'bg-accent-50 dark:bg-accent-900/30'
                                        : ''
                                    }`}
                                    aria-label={`Show commit diff for ${file.path}`}
                                    data-testid="git-commit-inline-file"
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
                        </div>
                      )}
                    </li>
                  );
                })}
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
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent-500" />
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
                            onClick={() => onFileSelect(file.path)}
                            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${
                              selectedFile === file.path
                                ? 'bg-accent-50 dark:bg-accent-900/30'
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
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent-500" />
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
    </>
  );
});

export default GitCommitHistoryPanel;
