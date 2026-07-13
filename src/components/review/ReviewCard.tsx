/**
 * ReviewCard Component
 *
 * Issue #600: UX refresh - Review screen card showing worktree review status.
 * Displays repository name, branch name, status badge, and next action.
 */

'use client';

import React from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui';
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
  done: 'bg-success-subtle text-success-foreground',
  approval: 'bg-warning-subtle text-warning-foreground',
  stalled: 'bg-danger-subtle text-danger-foreground',
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
    <Card data-testid="review-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Link
            href={`/worktrees/${worktreeId}?pane=terminal`}
            data-testid="review-card-link"
            className="hover:underline"
          >
            <div className="text-sm font-medium text-foreground truncate">
              {repositoryName}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {branchName}
            </div>
          </Link>
          <div className="mt-2 text-xs text-muted-foreground">
            {nextAction}
          </div>
          {cliToolId && (
            <span className="mt-1 inline-block text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
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
      {children && <div className="mt-3 pt-3 border-t border-border">{children}</div>}
    </Card>
  );
}
