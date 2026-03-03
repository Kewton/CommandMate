/**
 * Schedule Manager
 * Issue #294: Manages scheduled execution of claude -p commands
 * Issue #409: Performance optimization with mtime caching and batch upsert
 *
 * Uses a single timer to periodically scan all worktrees for CMATE.md changes
 * and execute scheduled tasks via croner cron expressions.
 *
 * Patterns:
 * - globalThis for hot reload persistence (same as auto-yes-manager.ts)
 * - Single timer for all worktrees (60 second polling interval)
 * - SIGKILL fire-and-forget for stopAllSchedules (< 1ms, within 3s graceful shutdown)
 * - mtime caching to skip unchanged CMATE.md files (Issue #409)
 *
 * [S3-001] stopAllSchedules() uses synchronous process.kill for immediate cleanup
 * [S3-010] initScheduleManager() is called after initializeWorktrees()
 */

import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import path from 'path';
import { Cron } from 'croner';
import { readCmateFile, parseSchedulesSection } from './cmate-parser';
import { executeClaudeCommand, getActiveProcesses, type ExecuteCommandOptions } from './claude-executor';
import { CMATE_FILENAME } from '@/config/cmate-constants';
import type { ScheduleEntry } from '@/types/cmate';

// =============================================================================
// Constants
// =============================================================================

/** Polling interval for CMATE.md changes (60 seconds) */
export const POLL_INTERVAL_MS = 60 * 1000;

/** Maximum number of concurrent schedules across all worktrees */
export const MAX_CONCURRENT_SCHEDULES = 100;

// =============================================================================
// Types
// =============================================================================

/** Internal schedule state for a running cron job */
interface ScheduleState {
  /** Schedule ID from DB */
  scheduleId: string;
  /** Worktree ID */
  worktreeId: string;
  /** Cron job instance */
  cronJob: Cron;
  /** Whether currently executing */
  isExecuting: boolean;
  /** Schedule entry from CMATE.md */
  entry: ScheduleEntry;
}

/** Timer state for the manager */
interface ManagerState {
  /** Global polling timer ID */
  timerId: ReturnType<typeof setTimeout> | null;
  /** Active schedule states keyed by scheduleId */
  schedules: Map<string, ScheduleState>;
  /** Whether the manager is initialized */
  initialized: boolean;
  /**
   * CMATE.md file mtime cache: worktree path -> mtimeMs
   *
   * Size upper bound (SEC4-001):
   * This Map's entry count corresponds 1:1 with getAllWorktrees() results.
   * syncSchedules() iterates the worktree list from getAllWorktrees() and
   * calls cache.set() per worktree, so entry count is always <= the
   * worktrees table row count. Worktree count is bounded by
   * MAX_CONCURRENT_SCHEDULES=100 (schedule-config.ts) in practice.
   * Each entry is approximately 100-200 bytes (path string + number),
   * so memory exhaustion risk is negligible.
   * When a worktree is deleted from DB, it is no longer returned by
   * getAllWorktrees(), so its cache entry is removed in the next
   * syncSchedules() cycle (CMATE.md deletion path in Step 3b).
   */
  cmateFileCache: Map<string, number>;
}

/** DB row shape for worktree queries */
interface WorktreeRow {
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

/** Execution log status values */
type ExecutionLogStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

// =============================================================================
// Global State (hot reload persistence)
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __scheduleManagerStates: ManagerState | undefined;
}

/**
 * Get or initialize the global manager state.
 */
function getManagerState(): ManagerState {
  if (!globalThis.__scheduleManagerStates) {
    globalThis.__scheduleManagerStates = {
      timerId: null,
      schedules: new Map(),
      initialized: false,
      cmateFileCache: new Map(),
    };
  }
  return globalThis.__scheduleManagerStates;
}

// =============================================================================
// Lazy DB Accessor
// =============================================================================

/**
 * Lazy-load the DB instance to avoid circular import issues.
 * The db-instance module is loaded at runtime via require() because
 * schedule-manager.ts is imported early in the server lifecycle.
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
function getCmateMtime(worktreePath: string): number | null {
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
    console.warn(`[schedule-manager] Failed to stat ${filePath}:`, error);
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
function getAllWorktrees(): WorktreeRow[] {
  try {
    const db = getLazyDbInstance();
    return db.prepare('SELECT id, path FROM worktrees').all() as WorktreeRow[];
  } catch (error) {
    console.error('[schedule-manager] Failed to get worktrees:', error);
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
 * Sanitization chain (SEC4-004): This function is called exclusively from
 * syncSchedules(), which passes entries produced by parseSchedulesSection().
 * parseSchedulesSection() calls sanitizeMessageContent() (S4-002) on all
 * message fields, so entries arriving here are already sanitized.
 * If batchUpsertSchedules() is called from a different code path in the
 * future, an input validation layer must be added at the call site.
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
 * Create an execution log entry in 'running' status.
 *
 * @param scheduleId - The parent schedule ID
 * @param worktreeId - The worktree ID
 * @param message - The execution message/prompt
 * @returns The new execution log ID
 */
function createExecutionLog(
  scheduleId: string,
  worktreeId: string,
  message: string
): string {
  const db = getLazyDbInstance();
  const now = Date.now();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO execution_logs (id, schedule_id, worktree_id, message, status, started_at, created_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?)
  `).run(id, scheduleId, worktreeId, message, now, now);

  return id;
}

/**
 * Update an execution log entry with results.
 *
 * @param logId - The execution log ID to update
 * @param status - The final execution status
 * @param result - The execution output or error message
 * @param exitCode - The process exit code, or null if unknown
 */
function updateExecutionLog(
  logId: string,
  status: ExecutionLogStatus,
  result: string | null,
  exitCode: number | null
): void {
  const db = getLazyDbInstance();
  const now = Date.now();

  db.prepare(`
    UPDATE execution_logs SET status = ?, result = ?, exit_code = ?, completed_at = ? WHERE id = ?
  `).run(status, result, exitCode, now, logId);
}

/**
 * Update the last_executed_at timestamp for a schedule.
 *
 * @param scheduleId - The schedule ID to update
 */
function updateScheduleLastExecuted(scheduleId: string): void {
  const db = getLazyDbInstance();
  const now = Date.now();

  db.prepare('UPDATE scheduled_executions SET last_executed_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, scheduleId);
}

/**
 * Recovery: mark all 'running' execution logs as 'failed' on startup.
 * This handles the case where the server was killed while executions
 * were still in progress.
 */
function recoverRunningLogs(): void {
  try {
    const db = getLazyDbInstance();
    const now = Date.now();

    const result = db.prepare(
      "UPDATE execution_logs SET status = 'failed', completed_at = ? WHERE status = 'running'"
    ).run(now);

    if (result.changes > 0) {
      console.warn(`[schedule-manager] Recovered ${result.changes} stale running execution(s) to failed status`);
    }
  } catch (error) {
    console.error('[schedule-manager] Failed to recover running logs:', error);
  }
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
function disableStaleSchedules(
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
      console.log(`[schedule-manager] Disabled ${disabledCount} stale DB schedule(s)`);
    }
  } catch (error) {
    console.error('[schedule-manager] Failed to disable stale schedules:', error);
  }
}

// =============================================================================
// Schedule Execution
// =============================================================================

/**
 * Execute a scheduled task.
 * Guards against concurrent execution of the same schedule.
 *
 * @param state - The schedule state to execute
 */
async function executeSchedule(state: ScheduleState): Promise<void> {
  if (state.isExecuting) {
    console.warn(`[schedule-manager] Skipping concurrent execution for schedule ${state.entry.name}`);
    return;
  }

  state.isExecuting = true;
  const logId = createExecutionLog(state.scheduleId, state.worktreeId, state.entry.message);

  try {
    const db = getLazyDbInstance();
    const worktree = db.prepare('SELECT path, vibe_local_model FROM worktrees WHERE id = ?').get(state.worktreeId) as { path: string; vibe_local_model: string | null } | undefined;

    if (!worktree) {
      updateExecutionLog(logId, 'failed', 'Worktree not found', null);
      return;
    }

    // Build options for vibe-local model
    const options: ExecuteCommandOptions | undefined =
      state.entry.cliToolId === 'vibe-local' && worktree.vibe_local_model
        ? { model: worktree.vibe_local_model }
        : undefined;

    const result = await executeClaudeCommand(
      state.entry.message,
      worktree.path,
      state.entry.cliToolId,
      state.entry.permission,
      options
    );

    updateExecutionLog(logId, result.status, result.output, result.exitCode);
    updateScheduleLastExecuted(state.scheduleId);

    console.log(`[schedule-manager] Executed ${state.entry.name}: ${result.status}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateExecutionLog(logId, 'failed', errorMessage, null);
    console.error(`[schedule-manager] Execution error for ${state.entry.name}:`, errorMessage);
  } finally {
    state.isExecuting = false;
  }
}

// =============================================================================
// CMATE.md Sync
// =============================================================================

/**
 * Sync schedules from CMATE.md files for all worktrees.
 * Reads CMATE.md from each worktree, upserts schedules to DB,
 * creates/updates cron jobs, and removes stale schedules.
 *
 * Issue #409: Uses mtime caching to skip unchanged CMATE.md files
 * and batchUpsertSchedules() for efficient DB operations.
 */
function syncSchedules(): void {
  const manager = getManagerState();
  const worktrees = getAllWorktrees();

  // Track which scheduleIds are still valid
  const activeScheduleIds = new Set<string>();

  for (const worktree of worktrees) {
    try {
      // Issue #409: Check CMATE.md mtime for change detection
      const mtime = getCmateMtime(worktree.path);
      const cachedMtime = manager.cmateFileCache.get(worktree.path);

      if (mtime === null) {
        // CMATE.md does not exist (or was deleted).
        // DR1-009: By not adding to activeScheduleIds, this worktree's
        // schedules will be cleaned up in Step 4 (stale cron job removal)
        // and disableStaleSchedules() (DB enabled=0 update).
        if (cachedMtime !== undefined) {
          manager.cmateFileCache.delete(worktree.path);
        }
        continue;
      }

      // If mtime matches cached value, skip DB operations for this worktree
      if (cachedMtime !== undefined && cachedMtime === mtime) {
        // File unchanged - re-add existing schedule IDs to keep them active
        for (const [scheduleId, state] of manager.schedules) {
          if (state.worktreeId === worktree.id) {
            activeScheduleIds.add(scheduleId);
          }
        }
        continue;
      }

      // Update mtime cache
      manager.cmateFileCache.set(worktree.path, mtime);

      const config = readCmateFile(worktree.path);
      if (!config) continue;

      const scheduleRows = config.get('Schedules');
      if (!scheduleRows) continue;

      const entries = parseSchedulesSection(scheduleRows);

      // Issue #409: Batch upsert all entries for this worktree
      const scheduleIds = batchUpsertSchedules(worktree.id, entries);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const scheduleId = scheduleIds[i];

        if (manager.schedules.size >= MAX_CONCURRENT_SCHEDULES) {
          console.warn(`[schedule-manager] MAX_CONCURRENT_SCHEDULES (${MAX_CONCURRENT_SCHEDULES}) reached`);
          return;
        }

        activeScheduleIds.add(scheduleId);

        // Check if this schedule already has a running cron job
        const existingState = manager.schedules.get(scheduleId);
        if (existingState) {
          // Update entry if changed
          existingState.entry = entry;
          continue;
        }

        if (!entry.enabled || !entry.cronExpression) continue;

        // Create new cron job
        try {
          const cronJob = new Cron(entry.cronExpression, {
            paused: false,
            protect: true, // Prevent overlapping
          });

          const state: ScheduleState = {
            scheduleId,
            worktreeId: worktree.id,
            cronJob,
            isExecuting: false,
            entry,
          };

          // Schedule execution
          cronJob.schedule(() => {
            void executeSchedule(state);
          });

          manager.schedules.set(scheduleId, state);
          console.log(`[schedule-manager] Scheduled ${entry.name} (${entry.cronExpression})`);
        } catch (cronError) {
          console.warn(`[schedule-manager] Invalid cron for ${entry.name}:`, cronError);
        }
      }
    } catch (error) {
      console.error(`[schedule-manager] Error syncing schedules for worktree ${worktree.id}:`, error);
    }
  }

  // Clean up schedules that no longer exist in CMATE.md
  for (const [scheduleId, state] of manager.schedules) {
    if (!activeScheduleIds.has(scheduleId)) {
      state.cronJob.stop();
      manager.schedules.delete(scheduleId);
      console.log(`[schedule-manager] Removed stale schedule ${state.entry.name}`);
    }
  }

  // Disable DB records for schedules no longer in CMATE.md
  const worktreeIds = worktrees.map(w => w.id);
  disableStaleSchedules(activeScheduleIds, worktreeIds);
}

// =============================================================================
// Manager Lifecycle
// =============================================================================

/**
 * Initialize the schedule manager.
 * Must be called after initializeWorktrees() completes.
 *
 * [S3-010] Called after await initializeWorktrees() in server.ts
 */
export function initScheduleManager(): void {
  const manager = getManagerState();

  if (manager.initialized) {
    console.log('[schedule-manager] Already initialized, skipping');
    return;
  }

  console.log('[schedule-manager] Initializing...');

  // Recovery: mark stale running logs as failed
  recoverRunningLogs();

  // Initial sync
  syncSchedules();

  // Start periodic sync timer
  manager.timerId = setInterval(() => {
    syncSchedules();
  }, POLL_INTERVAL_MS);

  manager.initialized = true;
  console.log(`[schedule-manager] Initialized with ${manager.schedules.size} schedule(s)`);
}

/**
 * Stop all schedules and clean up resources.
 * Uses synchronous SIGKILL fire-and-forget for immediate cleanup.
 *
 * [S3-001] Designed to complete within gracefulShutdown's 3-second timeout
 */
export function stopAllSchedules(): void {
  const manager = getManagerState();

  // Stop the polling timer
  if (manager.timerId !== null) {
    clearInterval(manager.timerId);
    manager.timerId = null;
  }

  // Stop all cron jobs
  for (const [, state] of manager.schedules) {
    try {
      state.cronJob.stop();
    } catch {
      // Ignore errors during cleanup
    }
  }
  manager.schedules.clear();
  // DR1-008: Clear mtime cache to prevent stale values from causing
  // incorrect skip decisions on next initScheduleManager() call
  manager.cmateFileCache.clear();

  // Kill all active child processes (fire-and-forget SIGKILL)
  const activeProcesses = getActiveProcesses();
  for (const [pid] of activeProcesses) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process may have already exited - ignore
    }
  }
  activeProcesses.clear();

  manager.initialized = false;
  console.log('[schedule-manager] All schedules stopped');
}

/**
 * Get the current number of active schedules.
 * Useful for monitoring and testing.
 */
export function getActiveScheduleCount(): number {
  return getManagerState().schedules.size;
}

/**
 * Check if the schedule manager is initialized.
 */
export function isScheduleManagerInitialized(): boolean {
  return getManagerState().initialized;
}
