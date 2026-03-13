/**
 * Job Executor
 * Issue #479: Extracted from schedule-manager.ts for single responsibility
 *
 * Handles execution of scheduled tasks and execution log management.
 * This module manages the DB logging lifecycle (create/update execution logs)
 * and delegates actual command execution to claude-executor.
 *
 * Trust boundary: All inputs are DB-derived from schedule-manager.ts (trusted).
 */

import { randomUUID } from 'crypto';
import { executeClaudeCommand, type ExecuteCommandOptions } from './claude-executor';
import type { ScheduleEntry } from '@/types/cmate';
import { createLogger } from '@/lib/logger';

const logger = createLogger('job-executor');

// =============================================================================
// Types
// =============================================================================

/** Execution log status values */
export type ExecutionLogStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

/** Internal schedule state for a running cron job - shared with schedule-manager */
export interface ScheduleState {
  /** Schedule ID from DB */
  scheduleId: string;
  /** Worktree ID */
  worktreeId: string;
  /** Cron job instance */
  cronJob: import('croner').Cron;
  /** Whether currently executing */
  isExecuting: boolean;
  /** Schedule entry from CMATE.md */
  entry: ScheduleEntry;
}

// =============================================================================
// Lazy DB Accessor
// =============================================================================

/**
 * Lazy-load the DB instance to avoid circular import issues.
 * Duplicated from schedule-manager.ts to avoid circular dependency.
 *
 * @returns The SQLite database instance
 */
function getLazyDbInstance(): ReturnType<typeof import('./db-instance').getDbInstance> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
  return getDbInstance();
}

// =============================================================================
// DB Operations - Execution Logs
// =============================================================================

/**
 * Create an execution log entry in 'running' status.
 *
 * @param scheduleId - The parent schedule ID
 * @param worktreeId - The worktree ID
 * @param message - The execution message/prompt
 * @returns The new execution log ID
 */
export function createExecutionLog(
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
export function updateExecutionLog(
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
export function updateScheduleLastExecuted(scheduleId: string): void {
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
export function recoverRunningLogs(): void {
  try {
    const db = getLazyDbInstance();
    const now = Date.now();

    const result = db.prepare(
      "UPDATE execution_logs SET status = 'failed', completed_at = ? WHERE status = 'running'"
    ).run(now);

    if (result.changes > 0) {
      logger.warn('execution:recovered-stale', { count: result.changes });
    }
  } catch (error) {
    logger.error('execution:recover-failed', { error: error instanceof Error ? error.message : String(error) });
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
export async function executeSchedule(state: ScheduleState): Promise<void> {
  if (state.isExecuting) {
    logger.warn('execution:skip-concurrent', { name: state.entry.name });
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

    logger.info('execution:completed', { name: state.entry.name, status: result.status });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateExecutionLog(logId, 'failed', errorMessage, null);
    logger.error('execution:failed', { name: state.entry.name, error: errorMessage });
  } finally {
    state.isExecuting = false;
  }
}
