/**
 * Sidebar Utility Functions
 *
 * Provides sorting functionality for sidebar branch list
 */

import type { SidebarBranchItem, BranchStatus } from '@/types/sidebar';

// ============================================================================
// Types
// ============================================================================

/**
 * Available sort keys for sidebar branch list
 */
export type SortKey = 'updatedAt' | 'repositoryName' | 'branchName' | 'status';

/**
 * Sort direction
 */
export type SortDirection = 'asc' | 'desc';

/**
 * View mode for sidebar display
 * - grouped: Branches grouped by repository name
 * - flat: Traditional flat list
 */
export type ViewMode = 'grouped' | 'flat';

/**
 * A group of branches belonging to the same repository
 */
export interface BranchGroup {
  /** Repository name used as group header */
  repositoryName: string;
  /** Sorted branches within this group */
  branches: SidebarBranchItem[];
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Priority order for branch statuses (lower number = higher priority)
 * - waiting: Highest priority (needs user attention for yes/no prompt)
 * - ready: Session active, waiting for user's new message
 * - running: Active processing
 * - generating: AI is working
 * - idle: No activity (lowest priority)
 */
export const STATUS_PRIORITY: Record<BranchStatus, number> = {
  waiting: 0,
  ready: 1,
  running: 2,
  generating: 3,
  idle: 4,
};

// ============================================================================
// Functions
// ============================================================================

/**
 * Sort branch items by the specified key and direction
 *
 * @param branches - Array of branch items to sort
 * @param sortKey - Key to sort by
 * @param direction - Sort direction (asc or desc)
 * @returns New sorted array (does not mutate original)
 *
 * @example
 * ```ts
 * const sorted = sortBranches(branches, 'updatedAt', 'desc');
 * // Returns branches sorted by update time, newest first
 * ```
 */
export function sortBranches(
  branches: SidebarBranchItem[],
  sortKey: SortKey,
  direction: SortDirection
): SidebarBranchItem[] {
  // Create a copy to avoid mutating the original array
  const sorted = [...branches];

  sorted.sort((a, b) => {
    let comparison = 0;

    switch (sortKey) {
      case 'updatedAt': {
        // Handle both Date objects and ISO date strings from API
        const getTimestamp = (date: Date | string | undefined): number => {
          if (!date) return 0;
          if (date instanceof Date) return date.getTime();
          return new Date(date).getTime();
        };
        const dateA = getTimestamp(a.lastActivity);
        const dateB = getTimestamp(b.lastActivity);
        comparison = dateB - dateA; // Default: newest first
        break;
      }

      case 'repositoryName': {
        const nameA = a.repositoryName.toLowerCase();
        const nameB = b.repositoryName.toLowerCase();
        comparison = nameA.localeCompare(nameB);
        break;
      }

      case 'branchName': {
        const nameA = a.name.toLowerCase();
        const nameB = b.name.toLowerCase();
        comparison = nameA.localeCompare(nameB);
        break;
      }

      case 'status': {
        const priorityA = STATUS_PRIORITY[a.status];
        const priorityB = STATUS_PRIORITY[b.status];
        comparison = priorityA - priorityB;
        break;
      }
    }

    // Apply direction multiplier
    // For updatedAt: desc = newest first (default), asc = oldest first
    // For others: asc = A-Z/priority order (default), desc = Z-A/reverse priority
    const isDefaultDirection = sortKey === 'updatedAt' ? direction === 'desc' : direction === 'asc';
    return isDefaultDirection ? comparison : -comparison;
  });

  return sorted;
}

/**
 * Group branches by repository name, sort groups alphabetically,
 * and sort branches within each group using the specified sort key.
 *
 * @param branches - Array of branch items to group
 * @param sortKey - Key to sort branches within each group
 * @param direction - Sort direction for branches within each group
 * @returns Array of BranchGroup sorted by repositoryName (case-insensitive)
 *
 * @example
 * ```ts
 * const groups = groupBranches(branches, 'updatedAt', 'desc');
 * // Returns groups sorted by repo name, branches sorted by update time
 * ```
 */
export function groupBranches(
  branches: SidebarBranchItem[],
  sortKey: SortKey,
  direction: SortDirection
): BranchGroup[] {
  // 1. Group by repositoryName
  const groupMap = new Map<string, SidebarBranchItem[]>();
  for (const branch of branches) {
    const key = branch.repositoryName;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(branch);
  }

  // 2. Sort groups alphabetically by repositoryName (case-insensitive)
  const sortedKeys = [...groupMap.keys()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );

  // 3. Sort branches within each group using existing sortBranches()
  return sortedKeys.map((repositoryName) => ({
    repositoryName,
    branches: sortBranches(groupMap.get(repositoryName)!, sortKey, direction),
  }));
}
