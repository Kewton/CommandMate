/**
 * BranchRowActions Component
 *
 * The "…" on a branch row (Issue #3576): open the worktree in a new tab, copy
 * the branch name, copy the worktree path. The row itself is a <button>, so
 * this sits beside it (never inside it) and is mounted only while the row
 * shows it — see BranchListItem for when that is.
 */

'use client';

import React, { memo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { MoreHorizontal } from 'lucide-react';
import type { SidebarBranchItem } from '@/types/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { useToast } from '@/components/common/Toast';
import { copyToClipboard } from '@/lib/clipboard-utils';

/**
 * Marks the portalled menu so a list that closes on an outside mousedown (the
 * tab strip's branch popover) can tell a click in this menu from one outside.
 */
export const BRANCH_ROW_ACTIONS_ATTR = 'data-branch-row-actions';

/** Props for BranchRowActions */
export interface BranchRowActionsProps {
  branch: SidebarBranchItem;
  /**
   * The selected row keeps "…" on touch screens too; an unselected row only
   * shows it on hover, which a touch screen never has.
   */
  isSelected: boolean;
  /** Keeps the row's "…" mounted while the menu is open. */
  onOpenChange: (open: boolean) => void;
}

export const BranchRowActions = memo(function BranchRowActions({
  branch,
  isSelected,
  onOpenChange,
}: BranchRowActionsProps) {
  const t = useTranslations('common');
  const { showToast } = useToast();

  const copy = useCallback(
    async (text: string) => {
      try {
        await copyToClipboard(text);
        showToast(t('branchItem.copied'), 'success');
      } catch {
        showToast(t('branchItem.copyFailed'), 'error');
      }
    },
    [showToast, t]
  );

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="branch-row-actions"
          aria-label={t('branchItem.actions', { name: branch.name })}
          title={t('branchItem.actions', { name: branch.name })}
          className={`absolute right-3 top-[5px] flex h-6 w-6 items-center justify-center rounded-md
            text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground
            focus:outline-none focus-visible:ring-2 focus-visible:ring-ring
            data-[state=open]:text-sidebar-foreground ${isSelected ? '' : '[@media(hover:none)]:hidden'}`}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        {...{ [BRANCH_ROW_ACTIONS_ATTR]: '' }}
        // Escape closes this menu only, not the list the row sits in.
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <DropdownMenuItem asChild>
          <a href={`/worktrees/${branch.id}`} target="_blank" rel="noopener noreferrer">
            {t('branchItem.openInNewTab')}
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copy(branch.name)}>
          {t('branchItem.copyBranchName')}
        </DropdownMenuItem>
        {branch.worktreePath && (
          <DropdownMenuItem onSelect={() => void copy(branch.worktreePath ?? '')}>
            {t('branchItem.copyPath')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
