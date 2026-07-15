/**
 * SessionOverviewTile Component
 *
 * Issue #1052: Home bento grid — large "Session Overview" tile combining the
 * Running/Waiting counts with a list of the most recent sessions. Pure display
 * component: worktrees are passed in from the shared cache (no new API).
 */

'use client';

import React from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui';
import { HomeSessionSummary } from '@/components/home/HomeSessionSummary';
import { RecentSessionsList } from '@/components/home/RecentSessionsList';
import type { Worktree } from '@/types/models';

export interface SessionOverviewTileProps {
  /** Worktrees to render counts and recent sessions from */
  worktrees: Worktree[];
  /**
   * [Issue #1118] First-load skeleton: headings stay, stats and the recent
   * list render as placeholders. Callers should gate this to the initial load
   * (e.g. `isLoading && worktrees.length === 0`) so poll re-fetches never
   * flip the tile back to skeletons.
   */
  isLoading?: boolean;
}

export function SessionOverviewTile({ worktrees, isLoading = false }: SessionOverviewTileProps) {
  return (
    <Card variant="elevated" className="h-full" data-testid="session-overview-tile">
      <h2 className="mb-3 text-lg font-semibold text-foreground">
        Session Overview
      </h2>

      <HomeSessionSummary worktrees={worktrees} isLoading={isLoading} />

      <div className="mt-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Recent sessions
        </h3>
        <Link
          href="/sessions"
          className="text-xs text-accent-600 hover:underline dark:text-accent-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          data-testid="session-overview-view-all"
        >
          View all
        </Link>
      </div>
      <div className="mt-2">
        <RecentSessionsList worktrees={worktrees} isLoading={isLoading} />
      </div>
    </Card>
  );
}
