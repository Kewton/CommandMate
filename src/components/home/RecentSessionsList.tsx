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
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui';
import { compareByTimestamp } from '@/lib/sidebar-utils';
import { formatRelativeTimeShort } from '@/lib/date-utils';
import type { Worktree } from '@/types/models';

export interface RecentSessionsListProps {
  /** Worktrees to pick the most recent sessions from */
  worktrees: Worktree[];
  /** Max number of sessions to show (default 5) */
  limit?: number;
  /** [Issue #1118] First-load skeleton (rows match the loaded list rows) */
  isLoading?: boolean;
}

/** Recency signal for a worktree: last user message, falling back to update time. */
function recencyOf(wt: Worktree): Date | string | undefined {
  return wt.lastUserMessageAt ?? wt.updatedAt;
}

/** Small status dot reflecting whether the session is active/waiting. */
function statusDotClass(wt: Worktree): string {
  if (wt.isWaitingForResponse) {
    return 'bg-warning';
  }
  if (wt.isSessionRunning) {
    return 'bg-success';
  }
  return 'bg-muted-foreground';
}

export function RecentSessionsList({ worktrees, limit = 5, isLoading = false }: RecentSessionsListProps) {
  const t = useTranslations('home');

  const recent = useMemo(() => {
    return [...worktrees]
      .sort((a, b) => compareByTimestamp(recencyOf(a), recencyOf(b)))
      .slice(0, limit);
  }, [worktrees, limit]);

  if (isLoading) {
    // Rows mirror the loaded link rows (dot + two text lines + time) so the
    // list height does not jump when real sessions replace the skeleton.
    return (
      <ul
        className="space-y-1"
        data-testid="recent-sessions-loading"
        role="status"
        aria-label="Loading recent sessions"
      >
        {Array.from({ length: limit }, (_, i) => (
          <li key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
            <span className="min-w-0 flex-1 space-y-1">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </span>
            <Skeleton className="h-3 w-8 shrink-0" />
          </li>
        ))}
      </ul>
    );
  }

  if (recent.length === 0) {
    // Issue #1199: the empty list always means zero repositories — `repositories`
    // is derived from the worktrees table — so the CTA has a single destination.
    return (
      <div className="space-y-2">
        <p
          className="text-sm text-muted-foreground"
          data-testid="recent-sessions-empty"
        >
          {t('recentSessions.empty')}
        </p>
        <Link
          href="/repositories"
          data-testid="recent-sessions-cta"
          className="inline-block text-sm font-medium text-accent-600 transition-colors hover:text-accent-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-accent-400 dark:hover:text-accent-300"
        >
          {t('recentSessions.cta')}
        </Link>
      </div>
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
              className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(wt)}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {wt.repositoryDisplayName ?? wt.repositoryName}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {wt.name}
                </span>
              </span>
              {relativeTime && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
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
