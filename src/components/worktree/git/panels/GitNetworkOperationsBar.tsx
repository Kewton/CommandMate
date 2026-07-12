/**
 * GitNetworkOperationsBar (Issue #783, extracted in #922)
 *
 * Renders the MVP's only required entry point: explicit Pull / Push / Fetch
 * buttons. The Push button works even when upstream is unset (the GitPane body
 * passes setUpstream when there is no upstream). DR1-005: the ahead/behind chip
 * stays visual-only (no click dropdown — deferred).
 *
 * Progress UI (§7.4): while running, a spinner (role=status) + an abort button
 * are shown. DR3-005: the OPTIONAL elapsed-seconds tick lives in THIS section's
 * own useState — never in the GitPane body — so a 60s push re-renders only this
 * section once per second, not the other panels.
 *
 * DR3-007: on mobile the progress bar is rendered sticky (z-40, BELOW the z-50
 * confirm modals) inside the GitPane scroll container so the modals still stack
 * above it. `isMobile` is read from GitPaneContext.
 */

'use client';

import React, { memo, useEffect, useState } from 'react';
import type { GitNetworkOperation } from '@/types/git';
import { useGitPaneContext } from '@/components/worktree/git/GitPaneContext';

export interface GitNetworkOperationsBarProps {
  /** 3-value progress state from useGitPaneNetworkOps. */
  progressState: 'idle' | 'running' | 'error';
  /** The in-flight operation tag (for the spinner label), or null. */
  operation: GitNetworkOperation | null;
  /** Friendly error message (mapped by reason), or null. */
  error: string | null;
  /** Pull conflict flag (HTTP 200 quasi-error, DR1-010). */
  conflict: boolean;
  /** Files in conflict after a pull. */
  conflictFiles: string[];
  /** True when the current status has no upstream (chip absent). */
  hasUpstream: boolean;
  /**
   * Issue #815: Fetch was demoted to "Advanced operations". When omitted, the
   * Fetch button is not rendered here (Pull/Push stay as the core Quick actions).
   */
  onFetch?: () => void;
  onPull: () => void;
  onPush: () => void;
  onAbort: () => void;
  /**
   * Issue #815: optional slot rendered alongside Pull/Push in the button row
   * (e.g. the core BranchCheckoutDropdown), keeping checkout beside Quick actions.
   */
  extraActions?: React.ReactNode;
}

export const GitNetworkOperationsBar = memo(function GitNetworkOperationsBar({
  progressState,
  operation,
  error,
  conflict,
  conflictFiles,
  hasUpstream,
  onFetch,
  onPull,
  onPush,
  onAbort,
  extraActions,
}: GitNetworkOperationsBarProps) {
  const { isMobile } = useGitPaneContext();
  const running = progressState === 'running';

  // DR3-005: elapsed-seconds tick isolated to this section. A plain spinner is
  // sufficient, but the elapsed seconds reassure the user during a long op. The
  // tick state lives here so it does not re-render the GitPane body or the other
  // panels every second.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <div
      className="flex flex-col gap-1.5 px-3 py-2 border-b border-gray-200 dark:border-gray-700"
      data-testid="git-network-section"
    >
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
        Quick actions
      </span>

      <div className={`flex items-center ${isMobile ? 'flex-wrap gap-1.5' : 'gap-2'}`}>
        {/* Fetch is rendered here only when onFetch is provided; Issue #815 moved
            the core Fetch button into the collapsed Advanced operations group. */}
        {onFetch && (
          <button
            type="button"
            onClick={onFetch}
            disabled={running}
            className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            data-testid="git-fetch-button"
          >
            Fetch
          </button>
        )}
        <button
          type="button"
          onClick={onPull}
          disabled={running}
          className="px-2 py-1 text-xs rounded border border-accent-300 dark:border-accent-700 text-accent-700 dark:text-accent-300 hover:bg-accent-50 dark:hover:bg-accent-900/30 disabled:opacity-50"
          data-testid="git-pull-button"
        >
          Pull
        </button>
        <button
          type="button"
          onClick={onPush}
          disabled={running}
          className="px-2 py-1 text-xs rounded border border-green-300 dark:border-green-700 text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 disabled:opacity-50"
          data-testid="git-push-button"
          title={hasUpstream ? undefined : 'No upstream — will set upstream on push'}
        >
          Push
        </button>
        {/* Issue #815: core BranchCheckoutDropdown slotted beside Quick actions. */}
        {extraActions}
      </div>

      {/* Progress / abort bar (sticky on mobile, z-40 < confirm modals z-50) */}
      {running && (
        <div
          className={`flex items-center gap-2 rounded px-2 py-1 text-xs bg-accent-50 text-accent-800 dark:bg-accent-900/20 dark:text-accent-300 ${
            isMobile ? 'sticky top-0 z-40' : ''
          }`}
          data-testid="git-network-progress-bar"
        >
          <span className="flex items-center gap-2" role="status" data-testid="git-network-operation-spinner">
            <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent-500" aria-hidden="true" />
            <span>
              {operation === 'push' ? 'Pushing' : operation === 'pull' ? 'Pulling' : 'Fetching'}… {elapsed}s
            </span>
          </span>
          <button
            type="button"
            onClick={onAbort}
            className="ml-auto px-1.5 py-0.5 rounded border border-accent-400 dark:border-accent-600 hover:bg-accent-100 dark:hover:bg-accent-900/40"
            data-testid="git-network-abort-button"
          >
            Abort
          </button>
        </div>
      )}

      {/* Error (role=alert) — pull conflict is surfaced as a quasi-error here */}
      {progressState === 'error' && error && (
        <div
          className="text-xs text-red-600 dark:text-red-400"
          role="alert"
          data-testid="git-network-operation-error"
        >
          {error}
        </div>
      )}

      {/* Pull conflict (HTTP 200 quasi-error, DR1-010): list files + terminal guidance */}
      {conflict && (
        <div
          className="text-xs text-orange-600 dark:text-orange-400"
          role="status"
          data-testid="git-network-conflict"
        >
          Pull produced conflicts: {conflictFiles.join(', ')}. Resolve them in the terminal.
        </div>
      )}
    </div>
  );
});

export default GitNetworkOperationsBar;
