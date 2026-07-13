/**
 * HomeSessionSummary Component
 *
 * Issue #600: UX refresh - Running/Waiting session count display for Home screen.
 * Issue #1052: Rendered as compact inline stats inside the Session Overview
 * bento tile (no longer a standalone 2-card grid). Client-side aggregate from
 * worktrees API response.
 * Issue #1051: A StatusDot on each stat "comes alive" (glow/blink) while the
 * corresponding count is non-zero, so a running session reads as live.
 *
 * Security [DR4-005]: Counts are for display only, not access control.
 */

'use client';

import React, { useMemo } from 'react';
import { StatusDot } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
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
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot status={runningCount > 0 ? 'running' : 'idle'} size="sm" label="Running" />
          Running
        </div>
        <div
          className={cn(
            'text-3xl font-bold tabular-nums',
            runningCount > 0 ? 'text-foreground' : 'text-muted-foreground',
          )}
          data-testid="running-count"
        >
          {runningCount}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot status={waitingCount > 0 ? 'waiting' : 'idle'} size="sm" label="Waiting" />
          Waiting
        </div>
        <div
          className={cn(
            'text-3xl font-bold tabular-nums',
            waitingCount > 0 ? 'text-foreground' : 'text-muted-foreground',
          )}
          data-testid="waiting-count"
        >
          {waitingCount}
        </div>
      </div>
    </div>
  );
}
