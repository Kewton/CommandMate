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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the sidebar repository group order.
 *
 * @returns Array of repository names in display order, or null if not set.
 */
export function getSidebarGroupOrder(db: Database.Database): string[] | null {
  try {
    const row = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(KEY_SIDEBAR_GROUP_ORDER) as { value: string } | undefined;

    if (!row) return null;

    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((v) => typeof v === 'string')) return null;

    return parsed as string[];
  } catch {
    return null;
  }
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
  const value = JSON.stringify(order);
  const now = Date.now();

  db.prepare(`
    INSERT INTO app_settings (key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(KEY_SIDEBAR_GROUP_ORDER, value, now, now);
}
