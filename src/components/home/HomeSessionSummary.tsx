/**
 * HomeSessionSummary Component
 *
 * Issue #600: UX refresh - Running/Waiting session count display for Home screen.
 * Client-side aggregate from worktrees API response.
 *
 * Security [DR4-005]: Counts are for display only, not access control.
 */

'use client';

import React, { useMemo } from 'react';
import { Card, StatusDot } from '@/components/ui';
import type { Worktree } from '@/types/models';

export interface HomeSessionSummaryProps {
  /** Worktrees to aggregate counts from */
  worktrees: Worktree[];
}

/**
 * Displays Running and Waiting session counts.
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
    <div className="grid grid-cols-2 gap-4" data-testid="home-session-summary">
      {/* Issue #1051: status-colored left accent + a StatusDot that only "comes
          alive" (glow/blink) while the corresponding count is non-zero. */}
      <Card className="border-l-2 border-l-success/70">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <StatusDot status={runningCount > 0 ? 'running' : 'idle'} size="sm" label="Running" />
          Running
        </div>
        <div className="text-2xl font-bold text-green-600 dark:text-green-400" data-testid="running-count">
          {runningCount}
        </div>
      </Card>
      <Card className="border-l-2 border-l-warning/70">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <StatusDot status={waitingCount > 0 ? 'waiting' : 'idle'} size="sm" label="Waiting" />
          Waiting
        </div>
        <div className="text-2xl font-bold text-amber-600 dark:text-amber-400" data-testid="waiting-count">
          {waitingCount}
        </div>
      </Card>
    </div>
  );
}
