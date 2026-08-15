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
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Skeleton, StatusDot } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { ATTENTION_REVIEW_HREF } from '@/config/review-config';
import { selectAttentionCount } from '@/hooks/useAttentionCount';
import type { Worktree } from '@/types/models';

export interface HomeSessionSummaryProps {
  /** Worktrees to aggregate counts from */
  worktrees: Worktree[];
  /** [Issue #1118] First-load skeleton (shapes match the loaded stat boxes) */
  isLoading?: boolean;
}

/**
 * Displays Running and Waiting session counts as compact inline stats.
 */
export function HomeSessionSummary({ worktrees, isLoading = false }: HomeSessionSummaryProps) {
  const t = useTranslations('home');
  const runningCount = useMemo(
    () => worktrees.filter((wt) => wt.isSessionRunning).length,
    [worktrees],
  );
  // Issue #1788: derived by the shared selector, not by a second local filter.
  // This tile, the sidebar badge, the mobile nav bubble and (next) #1789's tab
  // title now all read the same number — and it is the number the link below
  // opens, because `approval` uses the identical predicate.
  //
  // Deliberate behavior change: the old local count required `isSessionRunning`
  // as well. The server only ever sets `isWaitingForResponse` from a live probe,
  // so the pair moved together in practice; dropping the extra condition is what
  // makes this tile agree with the Review list instead of quietly showing one
  // fewer.
  const waitingCount = useMemo(() => selectAttentionCount(worktrees), [worktrees]);

  if (isLoading) {
    // Same box chrome as the loaded stats; label (text-xs ≈ h-4) and count
    // (text-3xl ≈ h-9) skeletons keep the tile height stable on swap.
    return (
      <div
        className="grid grid-cols-2 gap-3"
        data-testid="home-session-summary-loading"
        role="status"
        aria-label={t('sessionSummary.loading')}
      >
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
            <div className="flex h-4 items-center">
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="flex h-9 items-center">
              <Skeleton className="h-7 w-10" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3" data-testid="home-session-summary">
      <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot
            status={runningCount > 0 ? 'running' : 'idle'}
            size="sm"
            label={t('sessionSummary.running')}
          />
          {t('sessionSummary.running')}
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
      {/* Issue #1788: the Waiting stat is the answer to "who needs me?", so it
          is now the link to that list rather than a dead number. Rendered as an
          anchor unconditionally (also at zero) so its box chrome and height do
          not shift when the count crosses zero; the destination is simply an
          empty approval list in that case. */}
      <Link
        href={ATTENTION_REVIEW_HREF}
        data-testid="waiting-count-link"
        aria-label={t('sessionSummary.waitingLinkLabel', { count: waitingCount })}
        className="block rounded-lg border border-border bg-surface-2 px-3 py-2
          transition-colors hover:border-warning-border hover:bg-warning-subtle
          focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot
            status={waitingCount > 0 ? 'waiting' : 'idle'}
            size="sm"
            label={t('sessionSummary.waiting')}
          />
          {t('sessionSummary.waiting')}
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
      </Link>
    </div>
  );
}
