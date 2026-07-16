/**
 * ReviewTab Component
 * Extracted from review/page.tsx for separation of concerns.
 *
 * Issue #607: Daily summary feature (DR1-008)
 * Contains the existing review filter + card display logic.
 */

'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { REVIEW_POLL_INTERVAL_MS } from '@/config/review-config';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import { deriveCliStatus } from '@/types/sidebar';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import type { Worktree } from '@/types/models';
import type { BranchStatus } from '@/types/sidebar';

type ReviewFilter = 'in_review' | 'approval' | 'stalled';

/** Keys rather than literals: t() cannot be called at module scope, where a
 * literal would pin the chip labels to English (Issue #1271/#1273). A total
 * Record keyed by ReviewFilter so the active-filter badge and the chips read
 * the same label from one place. */
const FILTER_LABEL_KEYS: Record<ReviewFilter, string> = {
  in_review: 'status.inReview',
  approval: 'status.approval',
  stalled: 'status.stalled',
};

/** Chip display order. */
const FILTER_TABS: ReviewFilter[] = ['in_review', 'approval', 'stalled'];

/** Membership predicate per filter. Shared by the visible list and the chip
 * counts so both always agree (counts are derived, never fetched separately). */
const FILTER_PREDICATES: Record<ReviewFilter, (wt: Worktree) => boolean> = {
  in_review: (wt) => wt.status === 'in_review',
  approval: (wt) => wt.isWaitingForResponse === true,
  stalled: (wt) => wt.isStalled === true,
};

/** Small CLI status dot */
function CliDot({ status, label }: { status: BranchStatus; label: string }) {
  const tCommon = useTranslations('common');
  const config = SIDEBAR_STATUS_CONFIG[status];
  const title = `${label}: ${tCommon(config.labelKey)}`;
  const base = 'w-2.5 h-2.5 rounded-full flex-shrink-0';

  if (config.type === 'spinner') {
    return (
      <span className={`${base} border-2 border-t-transparent animate-spin ${config.className}`} title={title} />
    );
  }
  return <span className={`${base} ${config.className}`} title={title} />;
}

/** Badge color per filter */
function getBadgeClass(filter: ReviewFilter): string {
  switch (filter) {
    case 'in_review':
      return 'bg-info-subtle text-info-foreground';
    case 'approval':
      return 'bg-warning-subtle text-warning-foreground';
    case 'stalled':
      return 'bg-danger-subtle text-danger-foreground';
  }
}

/** Border color per filter */
function getBorderClass(filter: ReviewFilter): string {
  switch (filter) {
    case 'in_review':
      return 'border-info-border hover:border-info-border';
    case 'approval':
      return 'border-warning-border hover:border-warning-border';
    case 'stalled':
      return 'border-danger-border hover:border-danger-border';
  }
}

export default function ReviewTab() {
  const t = useTranslations('review');
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<ReviewFilter>('in_review');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchWorktrees = useCallback(async () => {
    try {
      const response = await fetch('/api/worktrees?include=review');
      if (response.ok) {
        const data = await response.json();
        setWorktrees(data.worktrees ?? []);
      }
    } catch {
      // Silently handle errors in polling
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorktrees();
    intervalRef.current = setInterval(fetchWorktrees, REVIEW_POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchWorktrees]);

  const filteredWorktrees = useMemo(
    () => worktrees.filter(FILTER_PREDICATES[activeFilter]),
    [worktrees, activeFilter]
  );

  const filterCounts = useMemo<Record<ReviewFilter, number>>(
    () => ({
      in_review: worktrees.filter(FILTER_PREDICATES.in_review).length,
      approval: worktrees.filter(FILTER_PREDICATES.approval).length,
      stalled: worktrees.filter(FILTER_PREDICATES.stalled).length,
    }),
    [worktrees]
  );

  const emptyMessage = useMemo(() => {
    switch (activeFilter) {
      case 'in_review':
        return t('empty.inReview');
      case 'approval':
        return t('empty.approval');
      case 'stalled':
        return t('empty.stalled');
    }
  }, [activeFilter, t]);

  return (
    <>
      {/* Filter segmented control: quiet selection (subtle accent tint), clearly
          distinct from a solid CTA. Each chip shows its live filtered count. */}
      <div
        className="mb-6 inline-flex items-center gap-1 rounded-lg bg-muted p-1"
        role="group"
        aria-label={t('filters.ariaLabel')}
        data-testid="review-filters"
      >
        {FILTER_TABS.map((filter) => {
          const isActive = activeFilter === filter;
          return (
            <button
              key={filter}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActiveFilter(filter)}
              data-testid={`review-filter-${filter}`}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-accent-500/15 text-accent-700 dark:text-accent-300'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(FILTER_LABEL_KEYS[filter])}
              <span
                className={cn(
                  'text-xs font-semibold tabular-nums',
                  isActive ? 'text-accent-700 dark:text-accent-300' : 'text-muted-foreground'
                )}
              >
                {filterCounts[filter]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Loading — card-shaped skeletons mirroring review list items (Issue #1118) */}
      {isLoading && (
        <div
          className="space-y-2"
          data-testid="review-loading"
          role="status"
          aria-label={t('filters.loading')}
        >
          {[0, 1, 2].map((i) => (
            <Card key={i} padding="md">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40 max-w-full" />
                  <Skeleton className="h-3 w-24 max-w-full" />
                </div>
                <Skeleton className="ml-4 h-5 w-16 flex-shrink-0" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Review list */}
      {!isLoading && (
        <div className="space-y-2" data-testid="review-list">
          {filteredWorktrees.length === 0 ? (
            <div className="text-muted-foreground py-8 text-center" data-testid="review-empty">
              {emptyMessage}
            </div>
          ) : (
            filteredWorktrees.map((wt) => {
              const agents = wt.selectedAgents ?? DEFAULT_SELECTED_AGENTS;
              return (
                <Link
                  key={wt.id}
                  href={`/worktrees/${wt.id}`}
                  className="block"
                  data-testid={`review-item-${wt.id}`}
                >
                  <Card padding="md" className={`transition-colors ${getBorderClass(activeFilter)}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground truncate">
                        {wt.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {wt.repositoryName}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded ${getBadgeClass(activeFilter)}`}>
                        {t(FILTER_LABEL_KEYS[activeFilter])}
                      </span>
                      {agents.map((agent) => {
                        const agentStatus = deriveCliStatus(wt.sessionStatusByCli?.[agent]);
                        return (
                          <div key={agent} className="flex items-center gap-1">
                            <CliDot status={agentStatus} label={getCliToolDisplayName(agent)} />
                            <span className="text-xs text-muted-foreground">
                              {getCliToolDisplayName(agent)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {wt.description && (
                    <div className="mt-2">
                      <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">
                        {wt.description}
                      </p>
                    </div>
                  )}
                  </Card>
                </Link>
              );
            })
          )}
        </div>
      )}
    </>
  );
}
