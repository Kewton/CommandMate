/**
 * OtherBranchesGroup Component (Issue #3509)
 *
 * The "Other (n)" fold at the end of a repository group: detached-HEAD
 * worktrees (`detached-<commit>`), which otherwise fill the list with rows
 * nobody reads. Which rows land here is `partitionOtherBranches` in
 * sidebar-utils — the selected, waiting and running ones never do.
 *
 * Collapsed by default and not persisted. `forceExpanded` (the filter field is
 * in use) opens it, so a search never matches a row it then hides.
 */

'use client';

import React, { memo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BranchListItem, SIDEBAR_ROW_INSET_CLASS } from '@/components/sidebar/BranchListItem';
import type { SidebarBranchItem } from '@/types/sidebar';

/** Props for OtherBranchesGroup */
export interface OtherBranchesGroupProps {
  /** Rows folded into "Other" (non-empty) */
  branches: readonly SidebarBranchItem[];
  /** The open worktree, or null */
  selectedWorktreeId: string | null;
  /** Open a worktree */
  onBranchClick: (branchId: string) => void;
  /** Open regardless of the toggle (the list is being filtered) */
  forceExpanded: boolean;
}

export const OtherBranchesGroup = memo(function OtherBranchesGroup({
  branches,
  selectedWorktreeId,
  onBranchClick,
  forceExpanded,
}: OtherBranchesGroupProps) {
  const t = useTranslations('common');
  const [isOpen, setIsOpen] = useState(false);
  const isExpanded = forceExpanded || isOpen;

  return (
    <div data-testid="branch-group-other">
      {/* Issue #3576: inset like the branch rows, so its hover fill is a card too. */}
      <div className={SIDEBAR_ROW_INSET_CLASS}>
        <button
          type="button"
          data-testid="branch-group-other-toggle"
          aria-expanded={isExpanded}
          disabled={forceExpanded}
          onClick={() => setIsOpen((open) => !open)}
          className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[10px] px-3 text-left text-xs text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
        >
          <svg
            className={`h-3 w-3 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="min-w-0 truncate">{t('sidebar.otherBranches', { count: branches.length })}</span>
        </button>
      </div>
      {isExpanded &&
        branches.map((branch) => (
          <BranchListItem
            key={branch.id}
            branch={branch}
            isSelected={branch.id === selectedWorktreeId}
            onClick={() => onBranchClick(branch.id)}
            showRepositoryName={false}
          />
        ))}
    </div>
  );
});
