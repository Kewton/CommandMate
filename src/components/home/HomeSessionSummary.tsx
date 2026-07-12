/**
 * HomeSessionSummary Component
 *
 * Issue #600: UX refresh - Running/Waiting session count display for Home screen.
 * Issue #1052: Rendered as compact inline stats inside the Session Overview
 * bento tile (no longer a standalone 2-card grid). Client-side aggregate from
 * worktrees API response.
 *
 * Security [DR4-005]: Counts are for display only, not access control.
 */

'use client';

import React, { useMemo } from 'react';
import type { Worktree } from '@/types/models';

export interface HomeSessionSummaryProps {
  /** Worktrees to aggregate counts from */
  worktrees: Worktree[];
}

/**
 * Displays Running and Waiting session counts as compact inline stats.
 */
export function HomeSessionSummary({ worktrees }: HomeSessionSummaryProps) {
  const { runningCount, waitingCount } = useMemo(() => {
    let running = 0;
    let waiting = 0;
    for (const wt of worktrees) {
      if (wt.isSessionRunning) {
        running++;
        if (wt.isWaitingForResponse) {
          waiting++;
        }
      }
    }
    return { runningCount: running, waitingCount: waiting };
  }, [worktrees]);

  return (
    <div className="grid grid-cols-2 gap-3" data-testid="home-session-summary">
      <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
        <div className="text-xs text-gray-500 dark:text-gray-400">Running</div>
        <div className="text-2xl font-bold text-green-600 dark:text-green-400" data-testid="running-count">
          {runningCount}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
        <div className="text-xs text-gray-500 dark:text-gray-400">Waiting</div>
        <div className="text-2xl font-bold text-amber-600 dark:text-amber-400" data-testid="waiting-count">
          {waitingCount}
        </div>
      </div>
    </div>
  );
}
