/**
 * History Display Configuration (Issue #701)
 *
 * Single Source of Truth for the history display limit options used by:
 * - GET /api/worktrees/:id/messages (upper-bound validation)
 * - HistoryPane selector UI (selectable options)
 * - WorktreeDetailRefactored state (persisted to localStorage)
 *
 * Design decisions:
 * - MAX_MESSAGES_LIMIT is derived from HISTORY_DISPLAY_LIMIT_OPTIONS (no duplication).
 * - DEFAULT_MESSAGES_LIMIT (50) matches the historical default before this issue.
 * - Storage key uses the `commandmate:` namespace, matching other keys
 *   (e.g. `commandmate:showArchived`).
 */

/**
 * Selectable history display limit options (ascending).
 * The first entry is the historical default; the last entry is the maximum.
 *
 * Issue #1123: the 250 ceiling was a performance mitigation for the previously
 * flat-rendered HistoryPane. Now that the list is virtualized (render cost is
 * O(visible rows), not O(total)), the ceiling is relaxed to 1000. The API still
 * bounds the *fetch* by the maximum option (data volume); server-side paging is
 * tracked separately.
 */
export const HISTORY_DISPLAY_LIMIT_OPTIONS = [50, 100, 150, 200, 250, 500, 1000] as const;

/**
 * Union type representing any selectable history display limit.
 */
export type HistoryDisplayLimit = (typeof HISTORY_DISPLAY_LIMIT_OPTIONS)[number];

/**
 * Upper bound enforced by the API, derived from the maximum option.
 *
 * Typed as `HistoryDisplayLimit` (not a brittle `as 250` literal) so that
 * extending `HISTORY_DISPLAY_LIMIT_OPTIONS` does not require touching this line.
 */
export const MAX_MESSAGES_LIMIT: HistoryDisplayLimit = Math.max(
  ...HISTORY_DISPLAY_LIMIT_OPTIONS,
) as HistoryDisplayLimit;

/**
 * Default history display limit (used when no localStorage value is present).
 */
export const DEFAULT_MESSAGES_LIMIT: HistoryDisplayLimit = 50;

/**
 * localStorage key used to persist the user-selected history display limit.
 */
export const HISTORY_DISPLAY_LIMIT_STORAGE_KEY = 'commandmate:historyDisplayLimit';

/**
 * Type guard: returns true if `value` is one of the allowed limit options.
 *
 * Used when reading from localStorage (which may contain stale/corrupted data)
 * to safely narrow `number` to `HistoryDisplayLimit`.
 */
export function isHistoryDisplayLimit(value: number): value is HistoryDisplayLimit {
  return (HISTORY_DISPLAY_LIMIT_OPTIONS as readonly number[]).includes(value);
}

/**
 * localStorage key used to persist the HistoryPane "User only" filter toggle
 * (Issue #725).
 *
 * Value representation: `'true'` / `'false'` (string), matching the existing
 * `commandmate:showArchived` convention. Any other value (including legacy
 * `'1'`/`'0'` or missing) is treated as `false` (safe-off fallback).
 */
export const HISTORY_USER_ONLY_STORAGE_KEY = 'commandmate:historyUserOnly';
