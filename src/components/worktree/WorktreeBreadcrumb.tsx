/**
 * WorktreeBreadcrumb — the worktree header's "repository / branch ▾" (Issue #3513).
 *
 * ## What it is for
 *
 * The repository tab strip (#2374) is only on screen while the sidebar is
 * collapsed (or always / never, by setting), so on the worktree screen the
 * header is the one place that always says where you are. Two repositories can
 * both have a `develop`, so the branch alone is not enough: the repository is
 * kept, small, beside the branch the header is about.
 *
 * ## What it reuses
 *
 * The ▾ opens the strip's own branch list (`RepositoryBranchPopover`) over the
 * strip's own grouping (`useRepositoryBranchGroups`), so a row here is the same
 * `BranchListItem` the sidebar and the tab draw. Picking a row goes through the
 * strip's own `useOpenWorktreeFromBranchList` (select, viewed mark, navigate),
 * and only one of the two lists is ever open (`useExclusiveBranchList`).
 *
 * ## One line (Issue #3590)
 *
 * The header is one 44px row: the name ▾ first, then the repository, which
 * links to the Repositories screen. The worktree's memo is no longer drawn in
 * the header; its full text is part of the name's tooltip (and Info).
 *
 * ## When there is no ▾
 *
 * The list needs the worktree cache (read through its non-throwing hook) and
 * the sidebar's sort and order settings. Without the cache (isolated renders),
 * for a worktree the cache does not list yet, or under a sidebar context that
 * carries no sort settings, the branch renders as plain text — exactly what
 * the header drew before. The sidebar and selection contexts are only read
 * once the cache is there: the app mounts `WorktreesCacheProvider` inside
 * `SidebarProvider` (which the worktree screen's controller already requires),
 * and the cache provider itself wraps its children in
 * `WorktreeSelectionProvider`.
 *
 * @module components/worktree/WorktreeBreadcrumb
 */

'use client';

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { usePcDisplaySizeContext } from '@/contexts/PcDisplaySizeContext';
import {
  RepositoryBranchPopover,
  isBranchListOwnTarget,
  useExclusiveBranchList,
  useOpenWorktreeFromBranchList,
  useRepositoryBranchGroups,
  type AnchorRect,
} from '@/components/layout/RepositoryTabBar';
import { GroupIcon } from '@/components/ui/GroupIcon';
import { generateRepositoryColor } from '@/lib/sidebar-utils';
import { isUnhandledEscape } from '@/lib/escape-key';
import type { SortDirection, SortKey } from '@/lib/sidebar-utils';
import type { RepositorySummary } from '@/lib/api-client';
import type { Worktree } from '@/types/models';

// ============================================================================
// Repository
// ============================================================================

/**
 * The repository the worktree belongs to, small, with the folder icon in the
 * same colour as its tab. Rendered whatever the tab strip is doing.
 *
 * Issue #3590: a link to the Repositories screen (there is no per-repository
 * page), on the header's one line right of the name.
 */
export const WorktreeBreadcrumbRepository = memo(function WorktreeBreadcrumbRepository({
  repositoryName,
}: {
  repositoryName: string;
}) {
  const t = useTranslations('worktree');
  return (
    <Link
      href="/repositories"
      data-testid="desktop-repository-name"
      className="flex min-w-0 max-w-[200px] items-center gap-1 rounded text-xs text-muted-foreground
        hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={t('detail.openRepositories', { repository: repositoryName })}
    >
      <GroupIcon
        className="h-3 w-3 flex-shrink-0"
        color={generateRepositoryColor(repositoryName)}
      />
      <span className="truncate">{repositoryName}</span>
    </Link>
  );
});

// ============================================================================
// Branch
// ============================================================================

interface WorktreeBreadcrumbBranchProps {
  /** The worktree on screen; without it there is nothing to mark in the list. */
  worktreeId?: string;
  /** What the header calls the worktree (its branch at creation). */
  worktreeName: string;
  /** For the ▾ button's tooltip. */
  repositoryName: string;
  /**
   * Issue #3590: the worktree's memo. Not drawn; its full text is appended to
   * the name's tooltip, the header's only place for it besides Info.
   */
  description?: string;
}

/** The name's tooltip: `base` (if any), then the memo in full (Issue #3590). */
function nameTooltip(base: string | undefined, description: string | undefined): string | undefined {
  const memo = description?.trim() ? description : undefined;
  if (!memo) return base;
  return base ? `${base}\n\n${memo}` : memo;
}

/** The name as plain text, carrying the memo tooltip when there is one. */
function PlainName({ worktreeName, description }: { worktreeName: string; description?: string }) {
  const title = nameTooltip(undefined, description);
  return title ? (
    <span title={title} data-testid="worktree-breadcrumb-name">
      {worktreeName}
    </span>
  ) : (
    <>{worktreeName}</>
  );
}

/**
 * The worktree's name, with a ▾ that opens its repository's branch list when
 * the list's data is in reach. Meant to sit inside the header's `<h1>`, so the
 * heading's name stays the worktree name (the chevron is `aria-hidden`).
 */
export const WorktreeBreadcrumbBranch = memo(function WorktreeBreadcrumbBranch({
  worktreeId,
  worktreeName,
  repositoryName,
  description,
}: WorktreeBreadcrumbBranchProps) {
  const cache = useOptionalWorktreesCacheContext();
  if (!cache || !worktreeId) return <PlainName worktreeName={worktreeName} description={description} />;
  return (
    <SidebarSettingsGate
      worktreeId={worktreeId}
      worktreeName={worktreeName}
      repositoryName={repositoryName}
      description={description}
      worktrees={cache.worktrees}
      repositories={cache.repositories}
    />
  );
});

/** Reads the sidebar's sort and order; plain text when they are not there. */
function SidebarSettingsGate({
  worktrees,
  repositories,
  ...props
}: {
  worktreeId: string;
  worktreeName: string;
  repositoryName: string;
  description?: string;
  worktrees: Worktree[];
  repositories: RepositorySummary[];
}) {
  const { sortKey, sortDirection, repositoryOrder } = useSidebarContext();
  if (!sortKey || !sortDirection || !repositoryOrder) {
    return <PlainName worktreeName={props.worktreeName} description={props.description} />;
  }
  return (
    <BranchSwitcher
      {...props}
      worktrees={worktrees}
      repositories={repositories}
      sortKey={sortKey}
      sortDirection={sortDirection}
      repositoryOrder={repositoryOrder}
    />
  );
}

function BranchSwitcher({
  worktreeId,
  worktreeName,
  repositoryName,
  description,
  worktrees,
  repositories,
  sortKey,
  sortDirection,
  repositoryOrder,
}: {
  worktreeId: string;
  worktreeName: string;
  repositoryName: string;
  description?: string;
  worktrees: Worktree[];
  repositories: RepositorySummary[];
  sortKey: SortKey;
  sortDirection: SortDirection;
  repositoryOrder: string[];
}) {
  const t = useTranslations('common');
  // Issue #3513: the strip's own pick (select → viewed mark → navigate).
  const openWorktree = useOpenWorktreeFromBranchList();
  const { factor } = usePcDisplaySizeContext();
  const groups = useRepositoryBranchGroups({
    worktrees,
    repositories,
    sortKey,
    sortDirection,
    repositoryOrder,
  });
  // Found by the worktree's id, not by name: two repositories may share a
  // display name, never a worktree id.
  const group = groups.find((g) => g.branches.some((b) => b.id === worktreeId)) ?? null;

  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const open = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ left: rect.left, right: rect.right, bottom: rect.bottom });
  }, []);

  // Issue #3513: opening this closes the strip's list, and the other way round.
  useExclusiveBranchList(anchor !== null, close);

  // Same dismissal rules as the tab strip: a click outside, or Escape (which
  // hands focus back to the ▾). Clicks inside a strip panel (or a row's "…" menu) are the list's own.
  useEffect(() => {
    if (!anchor) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (buttonRef.current?.contains(target)) return;
      // Issue #3576: the strip's own check, so a row's "…" menu counts as inside.
      if (isBranchListOwnTarget(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Issue #3611: an Escape a layer above already handled (the header
      // tools' "…" list closing itself) is not ours, nor is the focus.
      if (!isUnhandledEscape(event)) return;
      close();
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchor, close]);

  // A new worktree on screen means the pick happened; close what was open.
  useEffect(() => {
    close();
  }, [worktreeId, close]);

  const handleBranchClick = useCallback(
    (branchId: string) => {
      close();
      openWorktree(branchId);
    },
    [close, openWorktree]
  );

  if (!group) return <PlainName worktreeName={worktreeName} description={description} />;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="worktree-breadcrumb-branch"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title={nameTooltip(t('repoTabBar.switchBranch', { repository: repositoryName }), description)}
        onClick={() => (anchor ? close() : open())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!anchor) open();
          }
        }}
        className="inline-flex max-w-full items-center gap-1 rounded-md align-bottom
          hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 truncate">{worktreeName}</span>
        <ChevronDown
          size={16}
          strokeWidth={2}
          aria-hidden="true"
          className="flex-shrink-0 text-muted-foreground"
        />
      </button>
      {anchor && (
        <RepositoryBranchPopover
          group={group}
          anchor={anchor}
          factor={factor}
          activeWorktreeId={worktreeId}
          onBranchClick={handleBranchClick}
        />
      )}
    </>
  );
}
