/**
 * Sidebar Utility Functions
 *
 * Provides sorting functionality for sidebar branch list
 */

import type { SidebarBranchItem, BranchStatus } from '@/types/sidebar';

/**
 * Minimal repository shape used by sidebar visibility filtering (Issue #690).
 * Kept structurally compatible with `RepositorySummary` (api-client) and the
 * worktree DB `getRepositories()` rows so callers can pass either directly.
 */
export interface RepositoryVisibilityInfo {
  /** Repository path used to match against `Worktree.repositoryPath`. */
  path: string;
  /** Sidebar visibility flag. `false` hides this repository's worktrees. */
  visible: boolean;
}

/**
 * Minimal worktree shape used by sidebar visibility filtering (Issue #690).
 */
interface WorktreeVisibilityInfo {
  /** Repository path or empty string for legacy rows. */
  repositoryPath: string;
}

// ============================================================================
// Types
// ============================================================================

/**
 * All available sort keys as a const array (single source of truth)
 */
export const SORT_KEYS = ['updatedAt', 'repositoryName', 'branchName', 'status', 'lastSent'] as const;

/**
 * Available sort keys for sidebar branch list
 * Derived from SORT_KEYS const array for single source of truth [DP-005]
 */
export type SortKey = typeof SORT_KEYS[number];

/**
 * Type guard to validate if a string is a valid SortKey.
 * Uses SORT_KEYS array as single source of truth.
 *
 * @param key - String to validate
 * @returns true if key is a valid SortKey
 */
export const isValidSortKey = (key: string): key is SortKey =>
  (SORT_KEYS as ReadonlyArray<string>).includes(key);

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

/** Saturation value for repository color dots (%) */
export const REPO_DOT_SATURATION = 65;

/** Lightness value for repository color dots (%) */
export const REPO_DOT_LIGHTNESS = 60;

// ============================================================================
// Functions
// ============================================================================

/**
 * Build the set of repository paths that should be hidden from the sidebar
 * (Issue #690).
 *
 * A repository is "hidden" when its row in the API payload has
 * `visible === false`. Repositories with `visible === true` (or rows that
 * pre-date migration v31 and are normalized to `true` upstream) are NOT
 * placed in the set.
 *
 * @param repositories - Repository summaries returned by the worktrees API
 * @returns A `Set<string>` of repository paths that must be hidden
 */
export function buildHiddenRepositoryPathSet(
  repositories: ReadonlyArray<RepositoryVisibilityInfo>
): Set<string> {
  const hidden = new Set<string>();
  for (const repo of repositories) {
    if (repo.visible === false) {
      hidden.add(repo.path);
    }
  }
  return hidden;
}

/**
 * Filter out worktrees whose repository is hidden (Issue #690).
 *
 * Used by the Sidebar to enforce the user's per-repository visibility choice.
 * `useWorktreeList` is intentionally NOT filtered so the Sessions/Review
 * screens continue to show every worktree for management purposes.
 *
 * Match strategy:
 *   - Worktrees with no `repositoryPath` (legacy rows) are kept.
 *   - Worktrees whose `repositoryPath` matches a hidden repository are
 *     excluded.
 *
 * @param worktrees - Worktrees to filter
 * @param hiddenRepositoryPaths - Set built via `buildHiddenRepositoryPathSet`
 * @returns A new array containing only the worktrees that should be shown
 */
export function filterWorktreesByVisibility<T extends WorktreeVisibilityInfo>(
  worktrees: ReadonlyArray<T>,
  hiddenRepositoryPaths: ReadonlySet<string>
): T[] {
  if (hiddenRepositoryPaths.size === 0) {
    return worktrees.slice();
  }
  return worktrees.filter((wt) => {
    const repoPath = wt.repositoryPath;
    if (!repoPath) return true;
    return !hiddenRepositoryPaths.has(repoPath);
  });
}

/**
 * Simple hash function (djb2-like algorithm).
 * Produces a numeric hash from a string input.
 */
function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Generate a deterministic HSL color string from a repository name.
 * The same name always produces the same color.
 *
 * @param repositoryName - Repository name to generate color for
 * @returns HSL color string, e.g. "hsl(210, 65%, 60%)"
 */
export function generateRepositoryColor(repositoryName: string): string {
  const hue = simpleHash(repositoryName) % 360;
  return `hsl(${hue}, ${REPO_DOT_SATURATION}%, ${REPO_DOT_LIGHTNESS}%)`;
}

/**
 * Compare two timestamp values for sorting.
 * Returns raw comparison value (positive if a is newer, negative if b is newer).
 * Null/undefined values are sent to the end of sort regardless of direction.
 *
 * @param a - First timestamp (ISO string, numeric ms, null, or undefined)
 * @param b - Second timestamp (ISO string, numeric ms, null, or undefined)
 * @returns Comparison value: positive if a > b, negative if a < b, 0 if equal.
 *   Returns 1 if only a is null (a goes after b), -1 if only b is null.
 */
export function compareByTimestamp(
  a: string | number | Date | null | undefined,
  b: string | number | Date | null | undefined,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;  // null goes to end
  if (!b) return -1; // null goes to end
  const aTime = a instanceof Date ? a.getTime() : new Date(a as string | number).getTime();
  const bTime = b instanceof Date ? b.getTime() : new Date(b as string | number).getTime();
  return bTime - aTime; // Default: newest first (desc)
}

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

      case 'lastSent': {
        // NOTE: SidebarBranchItem has no lastUserMessageAt field.
        // Falls back to lastActivity (updatedAt-derived) for sidebar usage.
        // Sessions page uses Worktree.lastUserMessageAt directly.
        const cmp = compareByTimestamp(a.lastActivity, b.lastActivity);
        // Null values go to end regardless of direction - handle specially
        if (!a.lastActivity && !b.lastActivity) { comparison = 0; break; }
        if (!a.lastActivity) return 1;  // a has no date, goes to end
        if (!b.lastActivity) return -1; // b has no date, goes to end
        comparison = cmp;
        break;
      }

      default:
        // [CON-001] Explicit defense: unknown SortKey produces no sort
        comparison = 0;
        break;
    }

    // Apply direction multiplier
    // For updatedAt: desc = newest first (default), asc = oldest first
    // For others: asc = A-Z/priority order (default), desc = Z-A/reverse priority
    const isDescDefault = sortKey === 'updatedAt' || sortKey === 'lastSent';
    const isDefaultDirection = isDescDefault ? direction === 'desc' : direction === 'asc';
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
