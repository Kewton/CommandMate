/**
 * The worktree status pill on a sidebar branch row (Issue #3594).
 *
 * Issue #3604: moved out of BranchListItem, which re-exports the context.
 */

'use client';

import React, { createContext, useContext } from 'react';
import { useTranslations } from 'next-intl';
import {
  worktreeStatusLabelKey,
  WORKTREE_STATUS_BADGE_CLASSES,
  WORKTREE_STATUS_DOT_CLASSES,
  type WorktreeLifecycleStatus,
} from '@/lib/worktree-status';

/**
 * Whether rows draw the worktree status pill (or its dot). PC lists do (the
 * default); the phone's drawer provides `false` — there the status is only in
 * the row's "…" menu, and the row looks as it did before #3594.
 */
export const BranchRowStatusPillContext = createContext(true);

/** Renders nothing while the status is "Not set" or the context turns pills off. */
export function WorktreeStatusPill({
  worktreeStatus,
}: {
  worktreeStatus: WorktreeLifecycleStatus | null;
}) {
  const tWorktree = useTranslations('worktree');
  const showStatusPill = useContext(BranchRowStatusPillContext);
  if (!showStatusPill || !worktreeStatus) return null;

  return (
    <span
      data-testid="branch-worktree-status"
      data-status={worktreeStatus}
      className="flex-shrink-0 inline-flex items-center"
      title={tWorktree(worktreeStatusLabelKey(worktreeStatus))}
    >
      <span
        data-testid="branch-worktree-status-dot"
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full @min-[17rem]:hidden ${WORKTREE_STATUS_DOT_CLASSES[worktreeStatus]}`}
      />
      <span
        data-testid="branch-worktree-status-label"
        className={`sr-only @min-[17rem]:not-sr-only @min-[17rem]:max-w-[5.5rem] @min-[17rem]:truncate
                  @min-[17rem]:rounded-full @min-[17rem]:px-1.5 @min-[17rem]:text-[10px] @min-[17rem]:font-medium
                  @min-[17rem]:leading-4 ${WORKTREE_STATUS_BADGE_CLASSES[worktreeStatus]}`}
      >
        {tWorktree(worktreeStatusLabelKey(worktreeStatus))}
      </span>
    </span>
  );
}
