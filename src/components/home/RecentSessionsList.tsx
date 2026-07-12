/**
 * RecentSessionsList Component
 *
 * Issue #1052: Home bento grid — "Recent sessions" tile content.
 * Renders the most recently active worktrees (top N by recency) as links to
 * their detail page. Reuses the shared worktrees data (no new API); recency is
 * derived from `lastUserMessageAt` with a fallback to `updatedAt`.
 */

'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { compareByTimestamp } from '@/lib/sidebar-utils';
import { formatRelativeTimeShort } from '@/lib/date-utils';
import type { Worktree } from '@/types/models';

export interface RecentSessionsListProps {
  /** Worktrees to pick the most recent sessions from */
  worktrees: Worktree[];
  /** Max number of sessions to show (default 5) */
  limit?: number;
}

/** Recency signal for a worktree: last user message, falling back to update time. */
function recencyOf(wt: Worktree): Date | string | undefined {
  return wt.lastUserMessageAt ?? wt.updatedAt;
}

/** Small status dot reflecting whether the session is active/waiting. */
function statusDotClass(wt: Worktree): string {
  if (wt.isWaitingForResponse) {
    return 'bg-amber-500 dark:bg-amber-400';
  }
  if (wt.isSessionRunning) {
    return 'bg-green-500 dark:bg-green-400';
  }
  return 'bg-gray-300 dark:bg-gray-600';
}

export function RecentSessionsList({ worktrees, limit = 5 }: RecentSessionsListProps) {
  const recent = useMemo(() => {
    return [...worktrees]
      .sort((a, b) => compareByTimestamp(recencyOf(a), recencyOf(b)))
      .slice(0, limit);
  }, [worktrees, limit]);

  if (recent.length === 0) {
    return (
      <p
        className="text-sm text-gray-500 dark:text-gray-400"
        data-testid="recent-sessions-empty"
      >
        No recent sessions yet.
      </p>
    );
  }

  return (
    <ul className="space-y-1" data-testid="recent-sessions">
      {recent.map((wt) => {
        const recency = recencyOf(wt);
        const relativeTime = recency ? formatRelativeTimeShort(String(recency)) : '';
        return (
          <li key={wt.id}>
            <Link
              href={`/worktrees/${wt.id}`}
              data-testid={`recent-session-${wt.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(wt)}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {wt.repositoryDisplayName ?? wt.repositoryName}
                </span>
                <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                  {wt.name}
                </span>
              </span>
              {relativeTime && (
                <span className="shrink-0 text-xs tabular-nums text-gray-400 dark:text-gray-500">
                  {relativeTime}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
