/**
 * Sidebar Utility Functions
 *
 * Provides sorting functionality for sidebar branch list
 */

import { aggregateCliStatus } from '@/types/sidebar';
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
 * When the header's repository tab bar is shown (Issue #2374).
 *
 * Declared as a const array so the localStorage validator and the settings
 * selector read the same list — a second hand-written union is exactly how a
 * mode ends up persistable but unselectable.
 */
export const REPO_TAB_BAR_MODES = ['always', 'collapsed', 'hidden'] as const;

/**
 * Visibility rule for the repository tab bar (Issue #2374).
 * - `always`: the bar is up whether the sidebar is open or collapsed
 * - `collapsed`: only while the sidebar is collapsed (the default; the bar is
 *   the collapsed sidebar's replacement, not a second copy of it)
 * - `hidden`: never
 */
export type RepoTabBarMode = typeof REPO_TAB_BAR_MODES[number];

/**
 * Type guard for a stored {@link RepoTabBarMode}.
 *
 * @param value - Candidate string (typically straight out of localStorage)
 * @returns true when `value` is one of {@link REPO_TAB_BAR_MODES}
 */
export const isValidRepoTabBarMode = (value: string): value is RepoTabBarMode =>
  (REPO_TAB_BAR_MODES as ReadonlyArray<string>).includes(value);

/**
 * Default visibility rule for the repository tab bar (Issue #2374).
 *
 * `collapsed` rather than `always`: the bar replaces the collapsed sidebar's
 * navigation, so showing both at once is redundant chrome on the laptop screen
 * this Issue is about.
 *
 * Declared here rather than in `SidebarContext` so `AppShell` can read it
 * without importing from a module that component tests routinely `vi.mock`
 * wholesale — a default that only exists behind a mock is a default that
 * disappears in exactly the tests that need it.
 */
export const DEFAULT_REPO_TAB_BAR_MODE: RepoTabBarMode = 'collapsed';

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

/**
 * Sort key whose whole purpose is to let the user order by status themselves
 * (Issue #1787). The waiting-first prefix is suppressed for it: `STATUS_PRIORITY`
 * already puts `waiting` at the top ascending, and forcing the prefix would make
 * descending — "show me the idle ones first" — silently impossible.
 */
const USER_CONTROLLED_STATUS_SORT_KEY: SortKey = 'status';

/**
 * Fold-down order for a repository's aggregated dot (Issue #2374), most
 * significant first. Mirrors `aggregateCliStatus`'s ladder exactly.
 */
const GROUP_STATUS_LADDER: ReadonlyArray<BranchStatus> = [
  'waiting',
  'running',
  'generating',
  'ready',
  'idle',
];

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
 * The status a branch row actually SHOWS (Issue #1787, extracted in #2374).
 *
 * Reads the AGGREGATED per-instance status, which is what the row's single dot
 * renders — a branch whose `claude-2` is waiting shows an amber dot. Falls back
 * to the branch-level `status` when the item carries no per-instance map
 * (legacy payloads, and most unit fixtures).
 *
 * Extracted so the repository tab bar's per-repository dot is computed from the
 * same number the sidebar row paints. A second "read cliStatus, else status"
 * expression is precisely how a tab ends up gray above an amber row.
 *
 * @param branch - Branch item to read
 * @returns The displayed (aggregated) status for this branch
 */
export function resolveBranchStatus(branch: SidebarBranchItem): BranchStatus {
  return branch.cliStatus && Object.keys(branch.cliStatus).length > 0
    ? aggregateCliStatus(branch.cliStatus)
    : branch.status;
}

/**
 * Whether a branch belongs in the sidebar's pinned "needs you" group
 * (Issue #1787).
 *
 * @param branch - Branch item to classify
 * @returns true when the branch is waiting for the user
 */
export function isWaitingBranch(branch: SidebarBranchItem): boolean {
  return resolveBranchStatus(branch) === 'waiting';
}

/**
 * Fold a repository's branches into the single status its tab shows
 * (Issue #2374).
 *
 * Same precedence as {@link aggregateCliStatus} — waiting > running >
 * generating > ready > idle — applied one level up, over branches instead of
 * over agent instances. Deliberately the same ladder rather than a parallel
 * one: a tab that ranked `running` above `waiting` would hide the only state
 * that needs a human behind the state they can ignore.
 *
 * NOT {@link STATUS_PRIORITY}, which ranks `ready` ABOVE `running`. That is the
 * sidebar's SORT order, where "done, waiting for your next message" deserves to
 * float above "still working" — the opposite of what a single fold-down dot
 * should say, which is that the repository is busy.
 *
 * @param branches - Branches belonging to one repository
 * @returns The most significant status among them (`idle` when empty)
 */
export function aggregateGroupStatus(
  branches: ReadonlyArray<SidebarBranchItem>
): BranchStatus {
  const statuses = new Set(branches.map(resolveBranchStatus));
  for (const candidate of GROUP_STATUS_LADDER) {
    if (statuses.has(candidate)) return candidate;
  }
  return 'idle';
}

/**
 * How many of a repository's branches are waiting for the user (Issue #2374).
 *
 * Counts BRANCHES, not agent instances, matching `useAttentionCount`'s rule:
 * one waiting worktree counts once however many of its agents are blocked, so
 * the per-tab badges sum to the global "N need your attention" pill.
 *
 * @param branches - Branches belonging to one repository
 * @returns Number of waiting branches
 */
export function countWaitingBranches(
  branches: ReadonlyArray<SidebarBranchItem>
): number {
  let count = 0;
  for (const branch of branches) {
    if (isWaitingBranch(branch)) count++;
  }
  return count;
}

/**
 * Sort branch items by the specified key and direction
 *
 * Issue #1787: two-stage. Waiting branches are pinned to a leading group, and
 * the selected sort orders each group internally — so the default `updatedAt`
 * ordering still applies, it just applies within "needs you" and then within
 * "everything else". Without this the branch that is blocked on a y/n prompt
 * sinks below anything touched more recently, which is exactly the case the
 * user must not miss.
 *
 * The prefix runs BEFORE the direction multiplier on purpose: flipping to `asc`
 * must not bury the waiting group at the bottom.
 *
 * @param branches - Array of branch items to sort
 * @param sortKey - Key to sort by
 * @param direction - Sort direction (asc or desc)
 * @returns New sorted array (does not mutate original)
 *
 * @example
 * ```ts
 * const sorted = sortBranches(branches, 'updatedAt', 'desc');
 * // Waiting branches first (newest first among them), then the rest by update time
 * ```
 */
export function sortBranches(
  branches: SidebarBranchItem[],
  sortKey: SortKey,
  direction: SortDirection
): SidebarBranchItem[] {
  // Create a copy to avoid mutating the original array
  const sorted = [...branches];

  // Issue #1787: the explicit 'status' sort stays byte-identical to its previous
  // behaviour — the user asked for that exact order.
  const pinWaitingFirst = sortKey !== USER_CONTROLLED_STATUS_SORT_KEY;

  sorted.sort((a, b) => {
    if (pinWaitingFirst) {
      const waitingDelta = Number(isWaitingBranch(b)) - Number(isWaitingBranch(a));
      if (waitingDelta !== 0) return waitingDelta;
    }

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
 * Issue #1787: grouped view keeps its repository grouping — the groups are the
 * user's mental model and reordering them by status would scramble it — so the
 * waiting-first prefix applies WITHIN each repository (via `sortBranches`).
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

// ============================================================================
// Repository group order (Issue #651 sidebar DnD, shared since Issue #2374)
// ============================================================================

/** LocalStorage key for the repository group order cache */
export const SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY = 'mcbd-sidebar-group-order-cache';

/** Maximum entries accepted from a stored order (matches the API's PUT limit) */
const MAX_REPOSITORY_ORDER_ENTRIES = 500;

/**
 * In-memory copy of the last order read/written, so a client-side remount that
 * happens before localStorage is readable still gets the order back.
 */
let lastRepositoryOrder: string[] | null = null;

/**
 * Parse a stored repository order, discarding anything that is not a plain
 * array of strings.
 *
 * @param raw - JSON string from localStorage (or the API cache)
 * @returns The order, capped at {@link MAX_REPOSITORY_ORDER_ENTRIES}; `[]` on
 *   any parse or shape error
 */
export function parseRepositoryOrder(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .slice(0, MAX_REPOSITORY_ORDER_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Read the cached repository order.
 *
 * The cache exists so the sidebar and the repository tab bar can paint the
 * user's order on the FIRST frame, before `/api/sidebar/group-order` answers —
 * without it the tabs visibly re-sort a moment after load.
 *
 * @returns The cached order, or `[]` when there is none
 */
export function readRepositoryOrderCache(): string[] {
  if (typeof window === 'undefined') return lastRepositoryOrder ?? [];

  try {
    const stored = localStorage.getItem(SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY);
    if (!stored) return [];
    const parsed = parseRepositoryOrder(stored);
    lastRepositoryOrder = parsed.length > 0 ? parsed : null;
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Write the repository order to the cache.
 *
 * @param order - Repository display names, in the order the user arranged them
 */
export function persistRepositoryOrderCache(order: string[]): void {
  lastRepositoryOrder = order;
  if (typeof window === 'undefined') return;

  try {
    localStorage.setItem(SIDEBAR_GROUP_ORDER_CACHE_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ignore localStorage errors
  }
}

/**
 * Apply the user's saved repository order to grouped branches (Issue #2374).
 *
 * Shared by the sidebar's grouped list and the header's repository tab bar so
 * "the tabs are in the sidebar's order" is one function rather than two
 * implementations that agree until one of them is edited.
 *
 * Repositories present in `repositoryOrder` come first in that order; anything
 * the user has never dragged (a repository registered after the last reorder)
 * follows, alphabetically — which is the order `groupBranches` already
 * produced, so an empty `repositoryOrder` is returned untouched.
 *
 * @param groups - Groups from `groupBranches` (already alphabetical)
 * @param repositoryOrder - Saved order, from `/api/sidebar/group-order`
 * @returns A new array in display order (the input is never mutated)
 */
export function orderBranchGroups(
  groups: ReadonlyArray<BranchGroup>,
  repositoryOrder: ReadonlyArray<string>
): BranchGroup[] {
  if (repositoryOrder.length === 0) return groups.slice();

  const orderMap = new Map(repositoryOrder.map((name, index) => [name, index]));
  return groups.slice().sort((a, b) => {
    const ia = orderMap.has(a.repositoryName) ? orderMap.get(a.repositoryName)! : Infinity;
    const ib = orderMap.has(b.repositoryName) ? orderMap.get(b.repositoryName)! : Infinity;
    if (ia === ib) return a.repositoryName.localeCompare(b.repositoryName);
    return ia - ib;
  });
}

/**
 * Whether the repository tab bar should be on screen (Issue #2374).
 *
 * A pure rule rather than an inline ternary in `AppShell` so the three modes
 * are unit-testable without mounting the shell, and so the setting's meaning is
 * stated once.
 *
 * @param mode - The user's visibility rule
 * @param isSidebarOpen - Desktop sidebar open state
 * @returns true when the bar should render
 */
export function shouldShowRepositoryTabBar(
  mode: RepoTabBarMode,
  isSidebarOpen: boolean
): boolean {
  if (mode === 'hidden') return false;
  if (mode === 'always') return true;
  return !isSidebarOpen;
}
