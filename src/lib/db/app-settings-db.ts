/**
 * app-settings-db: Key-value store for application settings.
 *
 * Provides typed helpers for reading/writing the app_settings table
 * created in migration v27.
 */

import type Database from 'better-sqlite3';

// ============================================================================
// Key constants
// ============================================================================

/** Storage key for sidebar repository group display order */
const KEY_SIDEBAR_GROUP_ORDER = 'sidebar_group_order';

/** Storage key for directories recently chosen in the repository picker */
const KEY_RECENT_BROWSE_PATHS = 'recent_browse_paths';

/** How many recently used directories to remember (Issue #1517) */
export const RECENT_BROWSE_PATHS_LIMIT = 5;

// ============================================================================
// Helpers
// ============================================================================

function readStringArray(db: Database.Database, key: string): string[] | null {
  try {
    const row = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;

    if (!row) return null;

    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((v) => typeof v === 'string')) return null;

    return parsed as string[];
  } catch {
    return null;
  }
}

function writeStringArray(
  db: Database.Database,
  key: string,
  values: string[]
): void {
  const now = Date.now();

  db.prepare(`
    INSERT INTO app_settings (key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(values), now, now);
}

/**
 * Get the sidebar repository group order.
 *
 * @returns Array of repository names in display order, or null if not set.
 */
export function getSidebarGroupOrder(db: Database.Database): string[] | null {
  return readStringArray(db, KEY_SIDEBAR_GROUP_ORDER);
}

/**
 * Save the sidebar repository group order.
 *
 * @param order - Array of repository names in desired display order.
 */
export function setSidebarGroupOrder(
  db: Database.Database,
  order: string[]
): void {
  writeStringArray(db, KEY_SIDEBAR_GROUP_ORDER, order);
}

/**
 * Get directories recently chosen in the repository picker, newest first.
 *
 * Issue #1517: these are display hints only. Callers must still validate each
 * path against the allowed roots, because the roots can shrink after a path
 * was stored.
 */
export function getRecentBrowsePaths(db: Database.Database): string[] {
  return readStringArray(db, KEY_RECENT_BROWSE_PATHS) ?? [];
}

/**
 * Record a directory as most recently used, keeping the list de-duplicated and
 * capped at RECENT_BROWSE_PATHS_LIMIT.
 */
export function addRecentBrowsePath(
  db: Database.Database,
  browsePath: string
): void {
  const existing = getRecentBrowsePaths(db).filter((p) => p !== browsePath);
  const next = [browsePath, ...existing].slice(0, RECENT_BROWSE_PATHS_LIMIT);
  writeStringArray(db, KEY_RECENT_BROWSE_PATHS, next);
}
