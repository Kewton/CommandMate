/**
 * Review Page (/review)
 *
 * Issue #600: UX refresh - Done/Approval/Stalled processing screen.
 * Phase 2: Done and Approval filters (Stalled requires API extension in Phase 3).
 * Polls with REVIEW_POLL_INTERVAL_MS (7s).
 */

'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AppShell } from '@/components/layout';
import { ReviewCard } from '@/components/review/ReviewCard';
import { SimpleMessageInput } from '@/components/review/SimpleMessageInput';
import { REVIEW_POLL_INTERVAL_MS } from '@/config/review-config';
import type { Worktree } from '@/types/models';

/**
 * Review filter tabs.
 * Phase 3: Done, Approval, and Stalled filters enabled.
 */
type ReviewFilter = 'done' | 'approval' | 'stalled';

const FILTER_TABS: Array<{ value: ReviewFilter; label: string }> = [
  { value: 'done', label: 'Done' },
  { value: 'approval', label: 'Approval' },
  { value: 'stalled', label: 'Stalled' },
];

export default function ReviewPage() {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<ReviewFilter>('done');
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

  // Initial fetch and polling
  useEffect(() => {
    fetchWorktrees();
    intervalRef.current = setInterval(fetchWorktrees, REVIEW_POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchWorktrees]);

  /**
   * Filter worktrees by review status.
   * Phase 3: Uses server-computed reviewStatus from ?include=review.
   * Falls back to client-side heuristics when reviewStatus is not available.
   */
  const filteredWorktrees = useMemo(() => {
    return worktrees.filter((wt) => {
      // Use server-computed reviewStatus when available (Phase 3)
      if (wt.reviewStatus !== undefined) {
        return wt.reviewStatus === activeFilter;
      }
      // Fallback for backward compatibility
      if (activeFilter === 'done') {
        return wt.status === 'done';
      }
      if (activeFilter === 'approval') {
        return wt.isWaitingForResponse === true;
      }
      if (activeFilter === 'stalled') {
        return wt.isStalled === true;
      }
      return false;
    });
  }, [worktrees, activeFilter]);

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Review</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Review sessions that need your attention.
          </p>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-6" data-testid="review-filters">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setActiveFilter(tab.value)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                activeFilter === tab.value
                  ? 'bg-cyan-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
              data-testid={`review-filter-${tab.value}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="text-gray-500 dark:text-gray-400" data-testid="review-loading">
            Loading...
          </div>
        )}

        {/* Review cards */}
        {!isLoading && (
          <div className="space-y-3" data-testid="review-list">
            {filteredWorktrees.length === 0 ? (
              <div className="text-gray-500 dark:text-gray-400 py-8 text-center" data-testid="review-empty">
                No {activeFilter} sessions found.
              </div>
            ) : (
              filteredWorktrees.map((wt) => (
                <ReviewCard
                  key={wt.id}
                  worktreeId={wt.id}
                  repositoryName={wt.repositoryName}
                  branchName={wt.name}
                  status={activeFilter}
                  nextAction={wt.nextAction ?? (activeFilter === 'done' ? 'Review completed' : activeFilter === 'stalled' ? 'Check stalled' : 'Approve / Reject')}
                  cliToolId={wt.cliToolId ?? 'claude'}
                >
                  {activeFilter === 'approval' && (
                    <SimpleMessageInput
                      worktreeId={wt.id}
                      cliToolId={wt.cliToolId ?? 'claude'}
                    />
                  )}
                </ReviewCard>
              ))
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
