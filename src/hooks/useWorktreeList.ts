/**
 * useWorktreeList - Common hook for worktree list sorting, filtering, and grouping.
 *
 * Issue #600: UX refresh - shared list processing logic [DR1-005]
 * Responsibility: execute sort/filter/group logic only (stateless).
 * Uses sidebar-utils.ts sortBranches() and groupBranches().
 */

import { useMemo } from 'react';
import {
  sortBranches,
  groupBranches,
  type SortKey,
  type SortDirection,
  type ViewMode,
  type BranchGroup,
} from '@/lib/sidebar-utils';
import type { SidebarBranchItem } from '@/types/sidebar';

/**
 * Options for the useWorktreeList hook.
 */
export interface UseWorktreeListOptions {
  /** Array of branch items to process */
  items: SidebarBranchItem[];
  /** Sort key */
  sortKey: SortKey;
  /** Sort direction */
  sortDirection: SortDirection;
  /** View mode (grouped or flat) */
  viewMode: ViewMode;
  /** Optional text filter (case-insensitive substring match on name/repositoryName) */
  filterText?: string;
}

/**
 * Return value of useWorktreeList hook.
 */
export interface UseWorktreeListReturn {
  /** Sorted flat list (used when viewMode is 'flat') */
  sortedItems: SidebarBranchItem[];
  /** Grouped and sorted list (used when viewMode is 'grouped') */
  groupedItems: BranchGroup[];
}

/**
 * Hook that applies sorting, filtering, and grouping to a worktree list.
 *
 * This hook is stateless - it only computes derived data from the inputs.
 * State management (sort key, direction, view mode, filter text) is
 * the caller's responsibility.
 *
 * @param options - List processing options
 * @returns Sorted and grouped results
 */
export function useWorktreeList(options: UseWorktreeListOptions): UseWorktreeListReturn {
  const { items, sortKey, sortDirection, viewMode, filterText } = options;

  const filteredItems = useMemo(() => {
    if (!filterText) return items;
    const lower = filterText.toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(lower) ||
        item.repositoryName.toLowerCase().includes(lower)
    );
  }, [items, filterText]);

  const sortedItems = useMemo(
    () => sortBranches(filteredItems, sortKey, sortDirection),
    [filteredItems, sortKey, sortDirection]
  );

  const groupedItems = useMemo(
    () => (viewMode === 'grouped' ? groupBranches(filteredItems, sortKey, sortDirection) : []),
    [filteredItems, sortKey, sortDirection, viewMode]
  );

  return { sortedItems, groupedItems };
}
