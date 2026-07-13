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
import { Card } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { REVIEW_POLL_INTERVAL_MS } from '@/config/review-config';
import { DEFAULT_SELECTED_AGENTS } from '@/lib/selected-agents-validator';
import { deriveCliStatus } from '@/types/sidebar';
import { getCliToolDisplayName } from '@/lib/cli-tools/types';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import type { Worktree } from '@/types/models';
import type { BranchStatus } from '@/types/sidebar';

type ReviewFilter = 'in_review' | 'approval' | 'stalled';

const FILTER_TABS: Array<{ value: ReviewFilter; label: string }> = [
  { value: 'in_review', label: 'In Review' },
  { value: 'approval', label: 'Approval' },
  { value: 'stalled', label: 'Stalled' },
];

/** Membership predicate per filter. Shared by the visible list and the chip
 * counts so both always agree (counts are derived, never fetched separately). */
const FILTER_PREDICATES: Record<ReviewFilter, (wt: Worktree) => boolean> = {
  in_review: (wt) => wt.status === 'in_review',
  approval: (wt) => wt.isWaitingForResponse === true,
  stalled: (wt) => wt.isStalled === true,
};

/** Small CLI status dot */
function CliDot({ status, label }: { status: BranchStatus; label: string }) {
  const config = SIDEBAR_STATUS_CONFIG[status];
  const title = `${label}: ${config.label}`;
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
      return 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400';
    case 'approval':
      return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400';
    case 'stalled':
      return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400';
  }
}

/** Border color per filter */
function getBorderClass(filter: ReviewFilter): string {
  switch (filter) {
    case 'in_review':
      return 'border-purple-200 dark:border-purple-800 hover:border-purple-400 dark:hover:border-purple-600';
    case 'approval':
      return 'border-yellow-200 dark:border-yellow-800 hover:border-yellow-400 dark:hover:border-yellow-600';
    case 'stalled':
      return 'border-red-200 dark:border-red-800 hover:border-red-400 dark:hover:border-red-600';
  }
}

export default function ReviewTab() {
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
        return 'No worktrees in review.';
      case 'approval':
        return 'No worktrees waiting for approval.';
      case 'stalled':
        return 'No stalled worktrees detected.';
    }
  }, [activeFilter]);

  return (
    <>
      {/* Filter segmented control: quiet selection (subtle accent tint), clearly
          distinct from a solid CTA. Each chip shows its live filtered count. */}
      <div
        className="mb-6 inline-flex items-center gap-1 rounded-lg bg-muted p-1"
        role="group"
        aria-label="Review filters"
        data-testid="review-filters"
      >
        {FILTER_TABS.map((tab) => {
          const isActive = activeFilter === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActiveFilter(tab.value)}
              data-testid={`review-filter-${tab.value}`}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'bg-accent-500/15 text-accent-700 dark:text-accent-300'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {tab.label}
              <span
                className={cn(
                  'text-xs font-semibold tabular-nums',
                  isActive ? 'text-accent-700 dark:text-accent-300' : 'text-muted-foreground'
                )}
              >
                {filterCounts[tab.value]}
              </span>
            </button>
          );
        })}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="text-gray-500 dark:text-gray-400" data-testid="review-loading">
          Loading...
        </div>
      )}

      {/* Review list */}
      {!isLoading && (
        <div className="space-y-2" data-testid="review-list">
          {filteredWorktrees.length === 0 ? (
            <div className="text-gray-500 dark:text-gray-400 py-8 text-center" data-testid="review-empty">
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
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {wt.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {wt.repositoryName}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded ${getBadgeClass(activeFilter)}`}>
                        {FILTER_TABS.find((t) => t.value === activeFilter)?.label}
                      </span>
                      {agents.map((agent) => {
                        const agentStatus = deriveCliStatus(wt.sessionStatusByCli?.[agent]);
                        return (
                          <div key={agent} className="flex items-center gap-1">
                            <CliDot status={agentStatus} label={getCliToolDisplayName(agent)} />
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {getCliToolDisplayName(agent)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {wt.description && (
                    <div className="mt-2">
                      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 whitespace-pre-wrap">
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
