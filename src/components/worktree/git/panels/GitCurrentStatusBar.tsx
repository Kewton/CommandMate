/**
 * GitCurrentStatusBar (Issue #779, extracted in #922)
 *
 * Current Status section displayed at the top of GitPane. Shows the current
 * branch chip, an "uncommitted" dirty badge, ahead/behind counts (only when
 * aheadBehind is non-null), a branch-mismatch warning, and a dedicated refresh
 * button. Failures are surfaced inline and never affect the commit history /
 * diff sections below. `isMobile` is read from GitPaneContext.
 */

'use client';

import { memo } from 'react';
import type { GitStatus } from '@/types/models';
import { RefreshIcon } from '@/components/worktree/git/gitPaneShared';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';
import { Spinner } from '@/components/ui/Spinner';

export interface GitCurrentStatusBarProps {
  gitStatus: GitStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  onRefresh: () => void;
}

export const GitCurrentStatusBar = memo(function GitCurrentStatusBar({
  gitStatus,
  statusLoading,
  statusError,
  onRefresh,
}: GitCurrentStatusBarProps) {
  const { isMobile } = useGitPaneContext();
  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 border-b border-border"
      data-testid="git-status-section"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Current Status
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="p-1 text-muted-foreground hover:text-foreground rounded"
          aria-label="Refresh git status"
        >
          <RefreshIcon />
        </button>
      </div>

      {/* Loading: only show the spinner before the first successful load */}
      {statusLoading && !gitStatus && (
        <div className="flex items-center gap-2 py-1" role="status">
          <Spinner size="sm" variant="accent" />
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
              className="inline-flex items-center max-w-full truncate rounded px-2 py-0.5 text-xs font-mono bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300"
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
                className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-mono bg-muted text-foreground"
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

export default GitCurrentStatusBar;
