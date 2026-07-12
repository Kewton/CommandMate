/**
 * HomeHeading Component
 *
 * Issue #1072: Functional page heading for Home. Replaces the tautological
 * "CommandMate" h1 (which repeated the header wordmark) with an "Overview"
 * title plus a live subline of running/waiting session counts. Counts are
 * derived from the shared worktrees cache passed in by the page (no new fetch).
 * Numbers use `tabular-nums` so the subline does not jitter as counts change.
 */

'use client';

import React, { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { Worktree } from '@/types/models';

export interface HomeHeadingProps {
  /** Worktrees to derive the live running/waiting counts from */
  worktrees: Worktree[];
}

export function HomeHeading({ worktrees }: HomeHeadingProps) {
  const t = useTranslations('home');

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
    <div className="mb-8">
      <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
      <p className="mt-1 text-sm text-muted-foreground" data-testid="home-subline">
        <span className="tabular-nums" data-testid="subline-running">
          {runningCount}
        </span>{' '}
        {t('running')}
        <span aria-hidden="true"> · </span>
        <span className="tabular-nums" data-testid="subline-waiting">
          {waitingCount}
        </span>{' '}
        {t('waiting')}
      </p>
    </div>
  );
}
