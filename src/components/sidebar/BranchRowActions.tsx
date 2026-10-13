/**
 * BranchRowActions Component
 *
 * The "…" on a branch row (Issue #3576): open the worktree in a new tab, copy
 * the branch name, copy the worktree path — and, since Issue #3594, set how far
 * along the branch is (Status → five choices), for any row, not only the one on
 * screen. The row itself is a <button>, so this sits beside it (never inside
 * it) and is mounted only while the row shows it — see BranchListItem for when
 * that is.
 */

'use client';

import React, { memo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { SidebarBranchItem } from '@/types/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { useToast } from '@/components/common/Toast';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { Z_INDEX } from '@/config/z-index';
import {
  WORKTREE_STATUS_OPTIONS,
  worktreeStatusLabelKey,
  type WorktreeLifecycleStatus,
} from '@/lib/worktree-status';

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
  /**
   * The lifecycle status the row shows right now (Issue #3594) — the row's
   * pending choice while a save is in flight, else `branch.worktreeStatus`.
   */
  worktreeStatus?: WorktreeLifecycleStatus | null;
  /** Called with the picked status. Omitted → no Status entry. */
  onWorktreeStatusChange?: (status: WorktreeLifecycleStatus | null) => void;
}

/** Radio values cannot be null; "Not set" travels as the empty string. */
const NOT_SET_VALUE = '';

export const BranchRowActions = memo(function BranchRowActions({
  branch,
  isSelected,
  onOpenChange,
  worktreeStatus = null,
  onWorktreeStatusChange,
}: BranchRowActionsProps) {
  const t = useTranslations('common');
  const tWorktree = useTranslations('worktree');
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
        {onWorktreeStatusChange && (
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger
              data-testid="branch-row-status"
              className="relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none
                focus:bg-muted data-[state=open]:bg-muted"
            >
              <span className="flex-1">{t('branchItem.status')}</span>
              <span data-testid="branch-row-status-current" className="text-xs text-muted-foreground">
                {tWorktree(worktreeStatusLabelKey(worktreeStatus))}
              </span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent
                {...{ [BRANCH_ROW_ACTIONS_ATTR]: '' }}
                sideOffset={4}
                collisionPadding={8}
                style={{ zIndex: Z_INDEX.POPOVER }}
                className="min-w-[9rem] overflow-hidden rounded-md border border-border bg-surface p-1 text-surface-foreground shadow-lg"
                onEscapeKeyDown={(event) => event.stopPropagation()}
              >
                <DropdownMenuRadioGroup
                  value={worktreeStatus ?? NOT_SET_VALUE}
                  onValueChange={(value) => {
                    const next = value === NOT_SET_VALUE ? null : (value as WorktreeLifecycleStatus);
                    if (next !== worktreeStatus) onWorktreeStatusChange(next);
                  }}
                >
                  {WORKTREE_STATUS_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem key={option.labelKey} value={option.value ?? NOT_SET_VALUE}>
                      {tWorktree(option.labelKey)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
