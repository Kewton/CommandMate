/**
 * Job Executor
 * Issue #479: Extracted from schedule-manager.ts for single responsibility
 *
 * Handles execution of scheduled tasks and execution log management.
 * This module manages the DB logging lifecycle (create/update execution logs)
 * and delegates actual command execution to claude-executor.
 *
 * Scheduled tools: claude, codex, gemini, vibe-local, opencode, copilot,
 * antigravity, command-code (Issue #2253). Which flags each one is launched
 * with, and how its stdout is decoded back into an answer, is claude-executor's
 * business — this module only records the verdict.
 *
 * Trust boundary: All inputs are DB-derived from schedule-manager.ts (trusted).
 */

import { randomUUID } from 'crypto';
import { executeClaudeCommand, type ExecuteCommandOptions } from './session/claude-executor';
import { resolveScheduleCommandOptions } from '@/lib/cmate-cli-tool-parser';
import type { ScheduleEntry } from '@/types/cmate';
import { createLogger } from '@/lib/logger';

/** Worktree row shape used by {@link resolveScheduleExecuteOptions} */
interface WorktreeRow {
  path: string;
  vibe_local_model: string | null;
}

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
function getLazyDbInstance(): ReturnType<typeof import('./db/db-instance').getDbInstance> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db/db-instance') as typeof import('./db/db-instance');
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
// Execution Option Resolution
// =============================================================================

/**
 * Resolve the CLI options for a scheduled execution (DR1-004, Issue #2044).
 *
 * Two sources, because what a schedule asks for reaches it two different ways:
 *
 * - **the CMATE.md CLI Tool column**, read by
 *   {@link resolveScheduleCommandOptions} — `--model` for every tool in
 *   `TOOLS_WITH_MODEL_SUPPORT`, plus opencode's `--agent` / `--variant` /
 *   `--continue` / `--title` for the ids in `TOOLS_WITH_RUN_OPTIONS`;
 * - **the DB** (`worktree.vibe_local_model`), for vibe-local, whose model is
 *   chosen in the worktree's Agent settings rather than written in the file.
 *
 * ## Why the CMATE.md side is not implemented here (Issue #2044)
 *
 * This function was `resolveModelOption()` — the name it still has in older
 * docs — and it inlined the CMATE.md rule as `if (entry.model &&
 * TOOLS_WITH_MODEL_SUPPORT.has(...)) return { model: entry.model }`. That shape
 * can express exactly one option, so when #2044 taught the column to say
 * `opencode --agent plan --variant high`, the parser accepted it, the validator
 * accepted it, the writer round-tripped it, `buildCliArgs()` knew what to do
 * with it — and this line silently dropped all four flags. It is the same
 * failure #1914 fixed one field earlier (a second hard-coded copy of the
 * parser's Set), which is the argument for delegating rather than adding four
 * more `if`s: the column's grammar is the parser's business, and a call site
 * that re-states any part of it is a copy that will drift.
 *
 * The renaming is not cosmetic. "Model option" was true when `{ model }` was
 * the only thing that could come back; a function that also carries an agent and
 * a session title needs a name a reader can trust.
 *
 * ## Order
 *
 * CMATE.md first, DB second. The two are disjoint in practice — vibe-local is in
 * neither Set, so `resolveScheduleCommandOptions()` always answers `undefined`
 * for it — and the order is the one the previous implementation had, kept so
 * that a tool later added to `TOOLS_WITH_MODEL_SUPPORT` *and* given a DB model
 * resolves the file over the database, which is what "the schedule says so"
 * should mean.
 *
 * @param entry - Schedule entry from CMATE.md
 * @param worktree - Worktree row from DB
 * @returns Options to hand `executeClaudeCommand`, or undefined when the row
 *   asks for nothing beyond the tool's defaults
 */
export function resolveScheduleExecuteOptions(
  entry: ScheduleEntry,
  worktree: WorktreeRow
): ExecuteCommandOptions | undefined {
  const fromCmate = resolveScheduleCommandOptions(entry);
  if (fromCmate) return fromCmate;

  if (entry.cliToolId === 'vibe-local' && worktree.vibe_local_model) {
    return { model: worktree.vibe_local_model };
  }
  return undefined;
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
  // Issue #1343: createExecutionLog() must stay inside the try so that a DB
  // failure still reaches the finally that resets isExecuting. Otherwise the
  // schedule is skipped by the guard above until the server restarts.
  let logId: string | undefined;

  try {
    logId = createExecutionLog(state.scheduleId, state.worktreeId, state.entry.message);

    const db = getLazyDbInstance();
    const worktree = db.prepare('SELECT path, vibe_local_model FROM worktrees WHERE id = ?').get(state.worktreeId) as WorktreeRow | undefined;

    if (!worktree) {
      updateExecutionLog(logId, 'failed', 'Worktree not found', null);
      return;
    }

    // Resolve the CLI options via the centralized helper (DR1-004, #2044)
    const options = resolveScheduleExecuteOptions(state.entry, worktree);

    const result = await executeClaudeCommand(
      state.entry.message,
      worktree.path,
      state.entry.cliToolId,
      state.entry.permission,
      options
    );

    // Issue #2253: `result.status` is not always "did the process exit 0".
    // command-code writes a `{"type":"result","subtype":…}` line even on a
    // non-zero exit and can pair `subtype: "success"` with exit 9, so
    // claude-executor reads both halves and folds the verdict into `status` and
    // into the head of `output` (a `Reason: command-code exit N (…)` line).
    // This row is therefore the failure reason as well as the transcript, and
    // must keep writing `result.output` verbatim rather than a summary of it.
    updateExecutionLog(logId, result.status, result.output, result.exitCode);
    updateScheduleLastExecuted(state.scheduleId);

    logger.info('execution:completed', { name: state.entry.name, status: result.status });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (logId !== undefined) {
      updateExecutionLog(logId, 'failed', errorMessage, null);
    }
    logger.error('execution:failed', { name: state.entry.name, error: errorMessage });
  } finally {
    state.isExecuting = false;
  }
}
