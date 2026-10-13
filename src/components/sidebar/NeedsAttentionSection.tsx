/**
 * NeedsAttentionSection Component (Issue #3509)
 *
 * A short preview of the worktrees waiting for the user, above the branch list,
 * with a link to the full list in Review (`/review?filter=approval`).
 *
 * ## What it counts, and why it ignores the sidebar's filters
 *
 * The caller passes `selectAttentionWorktrees(...)` of the UNFILTERED list — one
 * worktree is one entry, however many of its agents wait — so the number here
 * is the number Review's approval tab shows. That has two consequences, both
 * deliberate:
 *
 * - A worktree of a hidden repository is counted and previewed (the branch list
 *   below drops it; Review does not). Its row says "hidden repository", so a
 *   count larger than the amber rows in the list has a visible reason.
 * - A waiting worktree appears twice: here, and in its place in the list. The
 *   list keeps it so the list does not reshuffle when a prompt comes and goes.
 *
 * It is the same in all three views (Grouped / Flat / Sessions) and is not
 * narrowed by the filter field, which belongs to the list.
 */

'use client';

import React, { memo } from 'react';
import { useTranslations } from 'next-intl';
import { EyeOff } from 'lucide-react';
import { TransitionLink } from '@/components/view-transitions/TransitionLink';
import { BranchStatusIndicator } from '@/components/sidebar/BranchStatusIndicator';
import { ATTENTION_REVIEW_HREF } from '@/config/review-config';
import { toBranchItem } from '@/types/sidebar';
import type { Worktree } from '@/types/models';

/** How many waiting worktrees the preview names before pointing to Review. */
export const ATTENTION_PREVIEW_LIMIT = 3;

/** Props for NeedsAttentionSection */
export interface NeedsAttentionSectionProps {
  /** `selectAttentionWorktrees` of the unfiltered worktree list */
  worktrees: readonly Worktree[];
  /** Ids of the worktrees the branch list shows (hidden repositories excluded) */
  visibleWorktreeIds: ReadonlySet<string>;
  /** The open worktree, or null */
  selectedWorktreeId: string | null;
  /** Open a worktree */
  onSelect: (worktreeId: string) => void;
  /** Called when the Review link is followed (closes the mobile drawer) */
  onNavigate: () => void;
}

export const NeedsAttentionSection = memo(function NeedsAttentionSection({
  worktrees,
  visibleWorktreeIds,
  selectedWorktreeId,
  onSelect,
  onNavigate,
}: NeedsAttentionSectionProps) {
  const t = useTranslations('common');
  const count = worktrees.length;
  if (count === 0) return null;

  const preview = worktrees.slice(0, ATTENTION_PREVIEW_LIMIT);
  const rest = count - preview.length;

  return (
    <section
      data-testid="sidebar-needs-attention"
      aria-label={t('sidebar.needsAttention')}
      className="flex-shrink-0 px-2 pt-3"
    >
      <div className="flex items-center gap-2 px-2 pb-1 text-xs text-sidebar-muted">
        <span className="min-w-0 flex-1 truncate">{t('sidebar.needsAttention')}</span>
        <span
          data-testid="sidebar-needs-attention-count"
          aria-label={t('attention.badgeLabel', { count })}
          className="flex-shrink-0 rounded-full bg-warning-subtle px-1.5 font-semibold leading-5 tabular-nums text-warning-foreground"
        >
          {count > 99 ? '99+' : count}
        </span>
      </div>
      <ul className="space-y-0.5">
        {preview.map((wt) => {
          const item = toBranchItem(wt);
          const hidden = !visibleWorktreeIds.has(wt.id);
          const isSelected = wt.id === selectedWorktreeId;
          return (
            <li key={wt.id}>
              <button
                type="button"
                data-testid="sidebar-attention-item"
                data-hidden-repository={hidden ? 'true' : undefined}
                onClick={() => onSelect(wt.id)}
                aria-current={isSelected ? 'true' : undefined}
                title={`${item.name} · ${item.repositoryName}`}
                className={`flex h-[34px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-sidebar-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isSelected ? 'bg-sidebar-hover' : ''
                }`}
              >
                <span className="flex w-4 flex-shrink-0 items-center justify-center">
                  {/* Every entry is here because `isWaitingForResponse` is true, so
                      the dot is the amber one whatever the per-instance map says. */}
                  <BranchStatusIndicator status="waiting" waitingKind={item.waitingKind} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">{item.name}</span>
                <span className="min-w-0 max-w-[40%] flex-shrink truncate text-xs text-sidebar-muted">
                  {item.repositoryName}
                </span>
                {hidden && (
                  <EyeOff
                    data-testid="sidebar-attention-hidden-repository"
                    className="h-3.5 w-3.5 flex-shrink-0 text-sidebar-muted"
                    aria-label={t('sidebar.hiddenRepository')}
                    role="img"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <TransitionLink
        href={ATTENTION_REVIEW_HREF}
        data-testid="sidebar-needs-attention-review-link"
        onClick={onNavigate}
        className="mt-0.5 flex min-w-0 items-center rounded-md px-2 py-1 text-xs text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate">
          {rest > 0 ? t('sidebar.attentionMoreInReview', { count: rest }) : t('sidebar.openInReview')}
        </span>
      </TransitionLink>
    </section>
  );
});
