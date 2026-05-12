/**
 * History Display Configuration (Issue #701)
 *
 * Single Source of Truth for the history display limit options used by:
 * - GET /api/worktrees/:id/messages (upper-bound validation)
 * - HistoryPane selector UI (selectable options)
 * - WorktreeDetailRefactored state (persisted to localStorage)
 * - useInfiniteMessages default page size
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
 */
export const HISTORY_DISPLAY_LIMIT_OPTIONS = [50, 100, 150, 200, 250] as const;

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
 * Default history display limit (used when no localStorage value is present
 * and as the default `pageSize` for `useInfiniteMessages`).
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
