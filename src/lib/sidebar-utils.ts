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

// ============================================================================
// Constants
// ============================================================================

/**
 * Priority order for branch statuses (lower number = higher priority)
 * - waiting: Highest priority (needs user attention)
 * - running: Active processing
 * - generating: AI is working
 * - idle: No activity (lowest priority)
 */
export const STATUS_PRIORITY: Record<BranchStatus, number> = {
  waiting: 0,
  running: 1,
  generating: 2,
  idle: 3,
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
        const dateA = a.lastActivity?.getTime() ?? 0;
        const dateB = b.lastActivity?.getTime() ?? 0;
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

    // Handle direction
    if (direction === 'asc') {
      // For updatedAt, asc means oldest first (reverse the default)
      if (sortKey === 'updatedAt') {
        return -comparison;
      }
      return comparison;
    } else {
      // For updatedAt, desc means newest first (keep the default)
      if (sortKey === 'updatedAt') {
        return comparison;
      }
      return -comparison;
    }
  });

  return sorted;
}
