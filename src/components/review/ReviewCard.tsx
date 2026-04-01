/**
 * ReviewCard Component
 *
 * Issue #600: UX refresh - Review screen card showing worktree review status.
 * Displays repository name, branch name, status badge, and next action.
 */

'use client';

import React from 'react';
import Link from 'next/link';
import type { ReviewStatus } from '@/lib/session/next-action-helper';

export interface ReviewCardProps {
  /** Worktree ID */
  worktreeId: string;
  /** Repository display name */
  repositoryName: string;
  /** Branch display name */
  branchName: string;
  /** Review status */
  status: ReviewStatus;
  /** Next action text */
  nextAction: string;
  /** CLI tool identifier */
  cliToolId: string;
  /** Optional inline reply component */
  children?: React.ReactNode;
}

/**
 * Status badge color mapping.
 */
const STATUS_COLORS: Record<ReviewStatus, string> = {
  done: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  approval: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  stalled: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
};

/**
 * Status badge label mapping.
 */
const STATUS_LABELS: Record<ReviewStatus, string> = {
  done: 'Done',
  approval: 'Approval',
  stalled: 'Stalled',
};

/**
 * ReviewCard displays a worktree's review status with optional inline reply.
 */
export function ReviewCard({
  worktreeId,
  repositoryName,
  branchName,
  status,
  nextAction,
  cliToolId,
  children,
}: ReviewCardProps) {
  return (
    <div
      data-testid="review-card"
      className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Link
            href={`/worktrees/${worktreeId}?pane=terminal`}
            data-testid="review-card-link"
            className="hover:underline"
          >
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {repositoryName}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {branchName}
            </div>
          </Link>
          <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
            {nextAction}
          </div>
          {cliToolId && (
            <span className="mt-1 inline-block text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              {cliToolId}
            </span>
          )}
        </div>
        <span
          data-testid="review-status-badge"
          className={`text-xs px-2 py-1 rounded-full font-medium whitespace-nowrap ${STATUS_COLORS[status]}`}
        >
          {STATUS_LABELS[status]}
        </span>
      </div>
      {children && <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">{children}</div>}
    </div>
  );
}
