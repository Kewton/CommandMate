/**
 * Cron Parser and Schedule DB Operations
 * Issue #479: Extracted from schedule-manager.ts for single responsibility
 *
 * Handles CMATE.md file change detection (mtime caching),
 * batch upsert of schedule entries to DB, and stale schedule cleanup.
 *
 * Note: "cron-parser" is a legacy name from the design document.
 * This module handles schedule DB operations and CMATE.md change detection,
 * not cron expression parsing (which is handled by the 'croner' library).
 *
 * Sanitization chain (SEC4-004): batchUpsertSchedules() is called exclusively from
 * syncSchedules(), which passes entries produced by parseSchedulesSection().
 * parseSchedulesSection() calls sanitizeMessageContent() (S4-002) on all
 * message fields, so entries arriving here are already sanitized.
 */

import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import path from 'path';
import { CMATE_FILENAME } from '@/config/cmate-constants';
import type { ScheduleEntry } from '@/types/cmate';
import { createLogger } from '@/lib/logger';

const logger = createLogger('cron-parser');

// =============================================================================
// Types
// =============================================================================

/** DB row shape for worktree queries */
export interface WorktreeRow {
  id: string;
  path: string;
}

/** DB row shape for schedule ID and name lookup */
interface ScheduleIdNameRow {
  id: string;
  name: string;
}

/** DB row shape for schedule ID lookup */
interface ScheduleIdRow {
  id: string;
}

// =============================================================================
// Lazy DB Accessor
// =============================================================================

/**
 * Lazy-load the DB instance to avoid circular import issues.
 * Duplicated to avoid circular dependency with schedule-manager.
 *
 * @returns The SQLite database instance
 */
function getLazyDbInstance(): ReturnType<typeof import('./db-instance').getDbInstance> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
  return getDbInstance();
}

// =============================================================================
// CMATE.md mtime Helper
// =============================================================================

/**
 * Get the modification time (mtimeMs) of the CMATE.md file in a worktree directory.
 *
 * Trust boundary (SEC4-003): worktreePath is DB-derived from getAllWorktrees()
 * and was validated by validateWorktreePath() at worktree registration time.
 * Therefore, path traversal re-validation is not needed here.
 * readCmateFile() has validateCmatePath() because it can be called externally,
 * whereas getCmateMtime() is an internal function called only from syncSchedules().
 *
 * @param worktreePath - Path to the worktree directory (DB-derived, trusted)
 * @returns mtimeMs value, or null if the file does not exist or cannot be read
 */
export function getCmateMtime(worktreePath: string): number | null {
  // Uses CMATE_FILENAME from @/config/cmate-constants directly (DR1-001, CR2-001)
  const filePath = path.join(worktreePath, CMATE_FILENAME);
  try {
    return statSync(filePath).mtimeMs;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    // Permission errors etc. - log and treat as no file (SEC4-004-note)
    logger.warn('file:stat-failed', { filePath });
    return null;
  }
}

// =============================================================================
// DB Operations
// =============================================================================

/**
 * Get all worktrees from the database.
 *
 * @returns Array of worktree rows with id and path
 */
export function getAllWorktrees(): WorktreeRow[] {
  try {
    const db = getLazyDbInstance();
    return db.prepare('SELECT id, path FROM worktrees').all() as WorktreeRow[];
  } catch (error) {
    logger.error('worktree:fetch-failed', { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * Batch upsert schedule entries into the database.
 * Replaces the previous per-entry upsertSchedule() function (DR1-002).
 *
 * Uses a single SELECT to build an existing schedules map, then performs
 * all UPDATE/INSERT operations within a single transaction.
 *
 * Note on next_execute_at (CR2-002): The scheduled_executions table has a
 * next_execute_at column (INTEGER, nullable) that is intentionally not
 * operated on by this function, consistent with the prior upsertSchedule().
 *
 * @param worktreeId - The worktree ID to associate schedules with
 * @param entries - Schedule entries from CMATE.md (sanitized by parseSchedulesSection)
 * @returns Array of schedule IDs (existing or newly created), in the same order as entries
 */
export function batchUpsertSchedules(
  worktreeId: string,
  entries: ScheduleEntry[]
): string[] {
  if (entries.length === 0) return [];

  const db = getLazyDbInstance();
  const now = Date.now();

  // Bulk fetch existing schedules for this worktree.
  // better-sqlite3's prepare() is cached at the DB instance level (DR1-007),
  // so calling it each invocation does not incur additional compilation cost.
  const existingRows = db.prepare(
    'SELECT id, name FROM scheduled_executions WHERE worktree_id = ?'
  ).all(worktreeId) as ScheduleIdNameRow[];

  const existingByName = new Map<string, string>();
  for (const row of existingRows) {
    existingByName.set(row.name, row.id);
  }

  const resultIds: string[] = [];

  const updateStmt = db.prepare(`
    UPDATE scheduled_executions
    SET message = ?, cron_expression = ?, cli_tool_id = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `);

  const insertStmt = db.prepare(`
    INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const runTransaction = db.transaction(() => {
    for (const entry of entries) {
      const existingId = existingByName.get(entry.name);

      if (existingId) {
        updateStmt.run(
          entry.message, entry.cronExpression, entry.cliToolId,
          entry.enabled ? 1 : 0, now, existingId
        );
        resultIds.push(existingId);
      } else {
        const id = randomUUID();
        insertStmt.run(
          id, worktreeId, entry.name, entry.message, entry.cronExpression,
          entry.cliToolId, entry.enabled ? 1 : 0, now, now
        );
        resultIds.push(id);
      }
    }
  });

  runTransaction();

  return resultIds;
}

/**
 * Disable DB schedules that are no longer present in CMATE.md.
 * Sets enabled = 0 for schedules belonging to the given worktrees
 * that are not in the activeScheduleIds set.
 * Skips records already disabled to avoid unnecessary DB writes.
 *
 * @param activeScheduleIds - Set of schedule IDs currently active from CMATE.md
 * @param worktreeIds - Array of worktree IDs that were scanned
 */
export function disableStaleSchedules(
  activeScheduleIds: Set<string>,
  worktreeIds: string[]
): void {
  if (worktreeIds.length === 0) return;

  try {
    const db = getLazyDbInstance();
    const now = Date.now();
    // SEC4-002: Dynamic placeholder generation is SQL injection-safe because only
    // '?' placeholders are interpolated into SQL; actual values are passed via
    // prepared statement parameter binding. worktreeIds originates from
    // getAllWorktrees() (bounded by MAX_CONCURRENT_SCHEDULES ~100), well within
    // SQLite's SQLITE_MAX_VARIABLE_NUMBER (default 999).
    const placeholders = worktreeIds.map(() => '?').join(',');

    // Get enabled schedules for the scanned worktrees
    const rows = db.prepare(
      `SELECT id FROM scheduled_executions WHERE worktree_id IN (${placeholders}) AND enabled = 1`
    ).all(...worktreeIds) as ScheduleIdRow[];

    let disabledCount = 0;
    const updateStmt = db.prepare(
      'UPDATE scheduled_executions SET enabled = 0, updated_at = ? WHERE id = ?'
    );

    for (const row of rows) {
      if (!activeScheduleIds.has(row.id)) {
        updateStmt.run(now, row.id);
        disabledCount++;
      }
    }

    if (disabledCount > 0) {
      logger.info('schedule:disabled-stale', { count: disabledCount });
    }
  } catch (error) {
    logger.error('schedule:disable-stale-failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
