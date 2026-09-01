/**
 * app-settings-db: Key-value store for application settings.
 *
 * Provides typed helpers for reading/writing the app_settings table
 * created in migration v27.
 */

import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { validateAgentsPair } from '@/lib/selected-agents-validator';
import { isSurfaceMode, type SurfaceMode } from '@/types/ui-state';

// ============================================================================
// Key constants
// ============================================================================

/** Storage key for sidebar repository group display order */
const KEY_SIDEBAR_GROUP_ORDER = 'sidebar_group_order';

/** Storage key for directories recently chosen in the repository picker */
const KEY_RECENT_BROWSE_PATHS = 'recent_browse_paths';

/**
 * Storage key for the agent list new worktrees start with (Issue #2065).
 *
 * Server-wide, ordered, and `[0]` is the primary. Absent means "no preference";
 * it is NOT written with the compiled-in default at install time, because a
 * stored copy of the constant would silently pin every install to whatever the
 * constant was on the day it was written.
 */
const KEY_DEFAULT_SELECTED_AGENTS = 'default_selected_agents';

/**
 * Storage key for the output surface new sessions open in (Issue #2201).
 *
 * Server-wide, and stored as the bare mode string rather than JSON: it is a
 * single enum value, and `readStringArray` exists for the two list-shaped
 * settings above. Absent means "no preference" — exactly as for
 * {@link KEY_DEFAULT_SELECTED_AGENTS}, the constant is never written into the
 * row at install time, so a later change to `DEFAULT_SURFACE_MODE` still
 * reaches an install that never chose.
 */
const KEY_DEFAULT_SURFACE_MODE = 'default_surface_mode';

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

function readScalar(db: Database.Database, key: string): string | null {
  try {
    const row = db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;

    return row ? row.value : null;
  } catch {
    return null;
  }
}

function writeScalar(db: Database.Database, key: string, value: string): void {
  const now = Date.now();

  db.prepare(`
    INSERT INTO app_settings (key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, now, now);
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

// ============================================================================
// Default selected agents (Issue #2065)
// ============================================================================

/**
 * Get the server-wide default agent list for new worktrees.
 *
 * Validated on read with the same `validateAgentsPair()` the API writes through,
 * so a row hand-edited to `["claude"]` or `["bogus","claude"]` reads as "unset"
 * rather than propagating an invalid roster into every worktree. The caller then
 * falls through to the next layer (see `resolveSelectedAgents()`).
 *
 * Cheap enough to call per request: one prepared point-query on a table with a
 * handful of rows. It is deliberately NOT called per worktree row — `getWorktrees()`
 * resolves it once and passes it down — and it never probes the filesystem, so
 * this stays clear of the `isInstalled()` hot-path rule (Issue #1913).
 *
 * @returns Ordered agents (`[0]` is the primary), or null when unset/invalid.
 */
export function getDefaultSelectedAgents(
  db: Database.Database
): CLIToolType[] | null {
  const raw = readStringArray(db, KEY_DEFAULT_SELECTED_AGENTS);
  if (!raw) return null;
  const result = validateAgentsPair(raw);
  return result.valid ? result.value! : null;
}

/**
 * Save the server-wide default agent list for new worktrees.
 *
 * @param agents - Ordered, already-validated agents; `agents[0]` becomes the primary.
 */
export function setDefaultSelectedAgents(
  db: Database.Database,
  agents: CLIToolType[]
): void {
  writeStringArray(db, KEY_DEFAULT_SELECTED_AGENTS, agents);
}

/**
 * Forget the server-wide default, returning the install to the compiled-in
 * constant. Deletes the row rather than writing the constant into it, so a later
 * change to `DEFAULT_SELECTED_AGENTS` still reaches an install that reset.
 */
export function clearDefaultSelectedAgents(db: Database.Database): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(KEY_DEFAULT_SELECTED_AGENTS);
}

// ============================================================================
// Default surface mode (Issue #2201)
// ============================================================================

/**
 * Get the server-wide output surface new sessions open in.
 *
 * Validated on read with `isSurfaceMode()` — the same guard the route writes
 * through and the same guard the browser applies to localStorage — so a row
 * hand-edited to `xterm` (Epic #2192 keeps that value reserved but unshipped)
 * reads as "unset" rather than reaching a component that would switch on it.
 *
 * @returns The stored mode, or null when unset or unparseable.
 */
export function getDefaultSurfaceMode(db: Database.Database): SurfaceMode | null {
  const raw = readScalar(db, KEY_DEFAULT_SURFACE_MODE);
  return isSurfaceMode(raw) ? raw : null;
}

/**
 * Save the server-wide output surface new sessions open in.
 *
 * @param mode - Already-validated mode; callers must narrow with `isSurfaceMode()`.
 */
export function setDefaultSurfaceMode(
  db: Database.Database,
  mode: SurfaceMode
): void {
  writeScalar(db, KEY_DEFAULT_SURFACE_MODE, mode);
}
