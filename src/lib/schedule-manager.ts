/**
 * Schedule Manager
 * Issue #294: Manages scheduled execution of claude -p commands
 *
 * Uses a single timer to periodically scan all worktrees for CMATE.md changes
 * and execute scheduled tasks via croner cron expressions.
 *
 * Patterns:
 * - globalThis for hot reload persistence (same as auto-yes-manager.ts)
 * - Single timer for all worktrees (60 second polling interval)
 * - SIGKILL fire-and-forget for stopAllSchedules (< 1ms, within 3s graceful shutdown)
 *
 * [S3-001] stopAllSchedules() uses synchronous process.kill for immediate cleanup
 * [S3-010] initScheduleManager() is called after initializeWorktrees()
 */

import { randomUUID } from 'crypto';
import { Cron } from 'croner';
import { readCmateFile, parseSchedulesSection } from './cmate-parser';
import { executeClaudeCommand, getActiveProcesses, type ExecuteCommandOptions } from './claude-executor';
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
}

/** DB row shape for worktree queries */
interface WorktreeRow {
  id: string;
  path: string;
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
 * Upsert a schedule entry into the database.
 * If a schedule with the same worktree_id and name exists, it is updated.
 * Otherwise, a new schedule is created.
 *
 * @param worktreeId - The worktree ID to associate the schedule with
 * @param entry - The schedule entry from CMATE.md
 * @returns The schedule ID (existing or newly created)
 */
function upsertSchedule(
  worktreeId: string,
  entry: ScheduleEntry
): string {
  const db = getLazyDbInstance();
  const now = Date.now();

  // Check if schedule already exists
  const existing = db.prepare(
    'SELECT id FROM scheduled_executions WHERE worktree_id = ? AND name = ?'
  ).get(worktreeId, entry.name) as ScheduleIdRow | undefined;

  if (existing) {
    db.prepare(`
      UPDATE scheduled_executions
      SET message = ?, cron_expression = ?, cli_tool_id = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(entry.message, entry.cronExpression, entry.cliToolId, entry.enabled ? 1 : 0, now, existing.id);
    return existing.id;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, worktreeId, entry.name, entry.message, entry.cronExpression, entry.cliToolId, entry.enabled ? 1 : 0, now, now);
  return id;
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
 */
function syncSchedules(): void {
  const manager = getManagerState();
  const worktrees = getAllWorktrees();

  // Track which scheduleIds are still valid
  const activeScheduleIds = new Set<string>();

  for (const worktree of worktrees) {
    try {
      const config = readCmateFile(worktree.path);
      if (!config) continue;

      const scheduleRows = config.get('Schedules');
      if (!scheduleRows) continue;

      const entries = parseSchedulesSection(scheduleRows);

      for (const entry of entries) {
        if (manager.schedules.size >= MAX_CONCURRENT_SCHEDULES) {
          console.warn(`[schedule-manager] MAX_CONCURRENT_SCHEDULES (${MAX_CONCURRENT_SCHEDULES}) reached`);
          return;
        }

        const scheduleId = upsertSchedule(worktree.id, entry);
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
