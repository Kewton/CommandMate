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
import { executeClaudeCommand, getActiveProcesses } from './claude-executor';
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
// DB Operations
// =============================================================================

/**
 * Get all worktrees from the database.
 * Lazy-loads db-instance to avoid circular imports.
 */
function getAllWorktrees(): Array<{ id: string; path: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
    const db = getDbInstance();
    return db.prepare('SELECT id, path FROM worktrees').all() as Array<{ id: string; path: string }>;
  } catch (error) {
    console.error('[schedule-manager] Failed to get worktrees:', error);
    return [];
  }
}

/**
 * Upsert a schedule entry into the database.
 */
function upsertSchedule(
  worktreeId: string,
  entry: ScheduleEntry
): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
  const db = getDbInstance();
  const now = Date.now();

  // Check if schedule already exists
  const existing = db.prepare(
    'SELECT id FROM scheduled_executions WHERE worktree_id = ? AND name = ?'
  ).get(worktreeId, entry.name) as { id: string } | undefined;

  if (existing) {
    // Update existing
    db.prepare(`
      UPDATE scheduled_executions
      SET message = ?, cron_expression = ?, cli_tool_id = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(entry.message, entry.cronExpression, entry.cliToolId, entry.enabled ? 1 : 0, now, existing.id);
    return existing.id;
  }

  // Insert new
  const id = randomUUID();
  db.prepare(`
    INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, worktreeId, entry.name, entry.message, entry.cronExpression, entry.cliToolId, entry.enabled ? 1 : 0, now, now);
  return id;
}

/**
 * Create an execution log entry.
 */
function createExecutionLog(
  scheduleId: string,
  worktreeId: string,
  message: string
): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
  const db = getDbInstance();
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
 */
function updateExecutionLog(
  logId: string,
  status: string,
  result: string | null,
  exitCode: number | null
): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
  const db = getDbInstance();
  const now = Date.now();

  db.prepare(`
    UPDATE execution_logs SET status = ?, result = ?, exit_code = ?, completed_at = ? WHERE id = ?
  `).run(status, result, exitCode, now, logId);
}

/**
 * Update the last_executed_at timestamp for a schedule.
 */
function updateScheduleLastExecuted(scheduleId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
  const db = getDbInstance();
  const now = Date.now();

  db.prepare('UPDATE scheduled_executions SET last_executed_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, scheduleId);
}

/**
 * Recovery: mark all 'running' execution logs as 'failed' on startup.
 */
function recoverRunningLogs(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
    const db = getDbInstance();
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

// =============================================================================
// Schedule Execution
// =============================================================================

/**
 * Execute a scheduled task.
 */
async function executeSchedule(state: ScheduleState): Promise<void> {
  if (state.isExecuting) {
    console.warn(`[schedule-manager] Skipping concurrent execution for schedule ${state.entry.name}`);
    return;
  }

  state.isExecuting = true;
  const logId = createExecutionLog(state.scheduleId, state.worktreeId, state.entry.message);

  try {
    // Get worktree path from DB
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
    const db = getDbInstance();
    const worktree = db.prepare('SELECT path FROM worktrees WHERE id = ?').get(state.worktreeId) as { path: string } | undefined;

    if (!worktree) {
      updateExecutionLog(logId, 'failed', 'Worktree not found', null);
      return;
    }

    const result = await executeClaudeCommand(
      state.entry.message,
      worktree.path,
      state.entry.cliToolId
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
