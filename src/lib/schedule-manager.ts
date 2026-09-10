/**
 * Schedule Manager
 * Issue #294: Manages scheduled execution of claude -p commands
 * Issue #409: Performance optimization with mtime caching and batch upsert
 * Issue #479: Split into schedule-manager.ts + cron-parser.ts + job-executor.ts
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

import { Cron } from 'croner';
import { readCmateFile, parseSchedulesSection } from './cmate-parser';
import { getActiveProcesses } from './session/claude-executor';
import {
  getCmateMtime,
  getAllWorktrees,
  batchUpsertSchedules,
  disableStaleSchedules,
} from './cron-parser';
import {
  executeSchedule,
  recoverRunningLogs,
  type ScheduleState,
} from './job-executor';
import { createLogger } from '@/lib/logger';

const logger = createLogger('schedule-manager');

// Re-export for backward compatibility (public API preservation)
export { batchUpsertSchedules } from './cron-parser';

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

/** Timer state for the manager */
interface ManagerState {
  /** Global polling timer ID */
  timerId: ReturnType<typeof setTimeout> | null;
  /** Active schedule states keyed by scheduleId */
  schedules: Map<string, ScheduleState>;
  /** Whether the manager is initialized */
  initialized: boolean;
  /** Whether syncSchedules() is currently running (DJ-007: concurrent execution guard) */
  isSyncing: boolean;
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

export interface ActiveScheduleInfo {
  scheduleId: string;
  worktreeId: string;
  name: string;
  cronExpression: string;
  cliToolId: string;
  enabled: boolean;
  isExecuting: boolean;
  isCronActive: boolean;
  nextRunAt: number | null;
  /** AI model name (copilot only, from CMATE.md CLI Tool column) */
  model?: string;
}

function isCronJobActive(cronJob: import('croner').Cron): boolean {
  try {
    if (typeof cronJob.isStopped === 'function') {
      return !cronJob.isStopped();
    }
    if (typeof cronJob.isRunning === 'function') {
      return cronJob.isRunning();
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * Attach the execution callback to a cron job.
 *
 * The callback closes over the {@link ScheduleState}, never over the entry the
 * timer was built from (Issue #2456). Two things follow, and both are load
 * bearing when a timer is replaced while its schedule keeps running:
 *
 * - the tick executes `state.entry`, so a Message/CLI Tool/Permission edit
 *   picked up by a later sync is the one the next run uses;
 * - the tick reads `state.isExecuting`, the single guard every timer this
 *   schedule ever owns shares. `protect: true` cannot stand in for it: the
 *   callback returns `undefined` rather than the execution's Promise, so croner
 *   never sees itself as blocking, and a fresh timer with its own state would
 *   start a second run on top of a live one.
 *
 * @param state - The schedule state the callback executes
 * @param cronJob - The cron job to attach the callback to
 */
function scheduleExecution(state: ScheduleState, cronJob: import('croner').Cron): void {
  cronJob.schedule(() => {
    // Issue #1343: executeSchedule() rejects if its own error handling fails
    // (e.g. the DB is still down when writing the 'failed' log). Without this
    // catch the rejection is silently unhandled.
    void executeSchedule(state).catch((error: unknown) => {
      logger.error('execution:unhandled', {
        name: state.entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function createScheduleState(
  worktreeId: string,
  scheduleId: string,
  entry: ScheduleState['entry']
): ScheduleState {
  const cronJob = new Cron(entry.cronExpression, {
    paused: false,
    protect: true,
  });

  const state: ScheduleState = {
    scheduleId,
    worktreeId,
    cronJob,
    isExecuting: false,
    entry,
  };

  scheduleExecution(state, cronJob);

  return state;
}

/**
 * Move a live schedule onto a new cron expression (Issue #2456).
 *
 * The bug this exists for: the sync loop used to answer a changed CMATE.md row
 * with `existingState.entry = entry`, which updates every field the executor
 * reads at run time but not the pattern `croner` compiled into the timer at
 * construction. A Cron edit was therefore accepted by the parser, written to the
 * DB, shown by the API — and ignored by the thing that actually fires, for as
 * long as the server stayed up.
 *
 * ## Order of operations
 *
 * The replacement is built **paused** first, so the only step that can reject a
 * pattern happens while the old timer is still the one and only live timer, and
 * a rejected pattern leaves the schedule exactly as it was. Only then is the old
 * timer stopped and the replacement resumed — in that order, so the two are
 * never runnable at the same instant. `state.cronJob` and `state.entry` are
 * published last, together, so a caller that reads the state never sees a timer
 * and an entry that disagree.
 *
 * A pause costs nothing here: `resume()` follows synchronously, so no tick can
 * pass while the replacement is paused and there is nothing to "catch up" on.
 * The new expression's first run is its first occurrence after now, which is
 * what a schedule edit should mean.
 *
 * ## Failure
 *
 * Failure keeps the old timer and the old entry, and says so — no
 * `schedule:updated`. What it must never do is leave two live timers, so the
 * candidate (which has never run) is the one discarded. If the failure was
 * `stop()` on the old timer, that timer is left in whatever state it reached:
 * either it stopped, and the next sync's inactive-state recovery rebuilds it
 * from the newest entry, or it survived on its old expression. Both are
 * recoverable, and the caller invalidates this worktree's mtime cache so the
 * next sync retries even though CMATE.md has not been touched again.
 *
 * @param state - The live schedule state (kept, so its execution guard survives)
 * @param entry - The entry carrying the new cron expression
 * @returns true when the schedule now runs on `entry.cronExpression`
 */
function replaceCronExpression(
  state: ScheduleState,
  entry: ScheduleState['entry']
): boolean {
  const previousCron = state.entry.cronExpression;
  const failed = (phase: 'prepare' | 'swap', error: unknown): false => {
    logger.error('schedule:update-failed', {
      scheduleId: state.scheduleId,
      worktreeId: state.worktreeId,
      previousCron,
      cron: entry.cronExpression,
      phase,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  };

  let candidate: import('croner').Cron | null = null;
  try {
    candidate = new Cron(entry.cronExpression, { paused: true, protect: true });
    scheduleExecution(state, candidate);
  } catch (error) {
    if (candidate) {
      try {
        candidate.stop();
      } catch {
        // The candidate never ran; nothing else to reclaim
      }
    }
    return failed('prepare', error);
  }

  try {
    state.cronJob.stop();
    candidate.resume();
  } catch (error) {
    try {
      candidate.stop();
    } catch {
      // The candidate never ran; nothing else to reclaim
    }
    return failed('swap', error);
  }

  state.cronJob = candidate;
  state.entry = entry;

  // Deliberately without the message: the prompt body is not an operational
  // fact and execution_logs already holds it.
  logger.info('schedule:updated', {
    scheduleId: state.scheduleId,
    worktreeId: state.worktreeId,
    previousCron,
    cron: entry.cronExpression,
  });
  return true;
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
      isSyncing: false,
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
function getLazyDbInstance(): ReturnType<typeof import('./db/db-instance').getDbInstance> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db/db-instance') as typeof import('./db/db-instance');
  return getDbInstance();
}

// =============================================================================
// CMATE.md Sync
// =============================================================================

/**
 * Sync schedules from CMATE.md files for all worktrees.
 * Reads CMATE.md from each worktree, upserts schedules to DB,
 * creates/updates cron jobs, and removes stale schedules.
 *
 * Issue #406: Async I/O for readCmateFile() to avoid event loop blocking.
 * Issue #409: Uses mtime caching to skip unchanged CMATE.md files
 * and batchUpsertSchedules() for efficient DB operations.
 * Issue #2456: A changed Cron column swaps the timer (replaceCronExpression);
 * everything else about an existing schedule is an entry update that leaves the
 * timer alone.
 *
 * DJ-007: isSyncing guard prevents concurrent execution when async
 * operations exceed the 60-second polling interval.
 */
async function syncSchedules(): Promise<void> {
  const manager = getManagerState();

  // DJ-007: Prevent concurrent execution (SEC4-004)
  if (manager.isSyncing) return;
  manager.isSyncing = true;

  try {
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

        const worktreeScheduleIds: string[] = [];
        let hasInactiveState = false;
        for (const [scheduleId, state] of manager.schedules) {
          if (state.worktreeId !== worktree.id) continue;
          worktreeScheduleIds.push(scheduleId);
          if (!isCronJobActive(state.cronJob)) {
            hasInactiveState = true;
          }
        }

        // If mtime matches cached value, skip DB operations for this worktree
        if (cachedMtime !== undefined && cachedMtime === mtime) {
          if (!hasInactiveState) {
            // File unchanged - re-add existing schedule IDs to keep them active
            for (const scheduleId of worktreeScheduleIds) {
              activeScheduleIds.add(scheduleId);
            }
            continue;
          }

          logger.warn('schedule:inactive-state-detected', { worktreeId: worktree.id });
        }

        // Update mtime cache
        manager.cmateFileCache.set(worktree.path, mtime);

        const config = await readCmateFile(worktree.path);
        if (!config) continue;

        const scheduleRows = config.get('Schedules');
        if (!scheduleRows) continue;

        const entries = parseSchedulesSection(scheduleRows);

        // Issue #409: Batch upsert all entries for this worktree
        const scheduleIds = batchUpsertSchedules(worktree.id, entries);

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const scheduleId = scheduleIds[i];

          activeScheduleIds.add(scheduleId);

          // Skip disabled or incomplete entries
          if (!entry.enabled || !entry.cronExpression) {
            // If a running cron job exists for this entry, stop it
            const disabledState = manager.schedules.get(scheduleId);
            if (disabledState) {
              disabledState.cronJob.stop();
              manager.schedules.delete(scheduleId);
              logger.info('schedule:disabled', { name: entry.name });
            }
            continue;
          }

          // Check if this schedule already has a running cron job
          const existingState = manager.schedules.get(scheduleId);
          if (existingState) {
            if (!isCronJobActive(existingState.cronJob)) {
              try {
                existingState.cronJob.stop();
              } catch {
                // Ignore cleanup errors for inactive cron jobs
              }

              // Issue #2456: recover onto the newest entry, and keep the same
              // ScheduleState so a still-running execution's guard survives the
              // exchange rather than being reset by a fresh object.
              try {
                const recovered = new Cron(entry.cronExpression, { paused: false, protect: true });
                scheduleExecution(existingState, recovered);
                existingState.cronJob = recovered;
                existingState.entry = entry;
                logger.warn('schedule:recreated-inactive', { name: entry.name, cron: entry.cronExpression });
              } catch (recoverError) {
                manager.cmateFileCache.delete(worktree.path);
                logger.error('schedule:update-failed', {
                  scheduleId,
                  worktreeId: worktree.id,
                  previousCron: existingState.entry.cronExpression,
                  cron: entry.cronExpression,
                  phase: 'recover',
                  error: recoverError instanceof Error ? recoverError.message : String(recoverError),
                });
              }
              continue;
            }

            // Issue #2456: a changed Cron column has to reach the timer, not
            // just the entry the executor reads. String comparison on purpose —
            // the parser has already trimmed the cell, and two spellings of the
            // same schedule are a rewrite the operator asked for.
            if (existingState.entry.cronExpression !== entry.cronExpression) {
              if (!replaceCronExpression(existingState, entry)) {
                // The old timer and the old entry are still in force. Drop this
                // worktree's mtime cache so the next sync retries even though
                // CMATE.md itself has not changed again — without this the file
                // would have to be touched to get another attempt.
                manager.cmateFileCache.delete(worktree.path);
              }
              continue;
            }

            // Metadata-only change (Message / CLI Tool / Permission / model):
            // the timer stays, and the next tick reads this entry through the
            // shared state.
            existingState.entry = entry;
            continue;
          }

          // Create new cron job. The cap belongs here and only here (Issue
          // #2456): it bounds how many timers exist, so refusing a new one must
          // not also refuse to update, disable or clean up the ones already
          // running — nor abandon the rest of the sync, which is what the
          // previous `return` did.
          if (manager.schedules.size >= MAX_CONCURRENT_SCHEDULES) {
            logger.warn('schedule:max-concurrent-reached', {
              limit: MAX_CONCURRENT_SCHEDULES,
              name: entry.name,
            });
            continue;
          }

          try {
            const state = createScheduleState(worktree.id, scheduleId, entry);
            manager.schedules.set(scheduleId, state);
            logger.info('schedule:created', { name: entry.name, cron: entry.cronExpression });
          } catch (cronError) {
            logger.warn('schedule:invalid-cron', { name: entry.name, error: cronError instanceof Error ? cronError.message : String(cronError) });
          }
        }
      } catch (error) {
        logger.error('schedule:sync-failed', { worktreeId: worktree.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Clean up schedules that no longer exist in CMATE.md
    for (const [scheduleId, state] of manager.schedules) {
      if (!activeScheduleIds.has(scheduleId)) {
        state.cronJob.stop();
        manager.schedules.delete(scheduleId);
        logger.info('schedule:removed-stale', { name: state.entry.name });
      }
    }

    // Disable DB records for schedules no longer in CMATE.md
    const worktreeIds = worktrees.map(w => w.id);
    disableStaleSchedules(activeScheduleIds, worktreeIds);
  } finally {
    manager.isSyncing = false;
  }
}

/**
 * Run a one-shot CMATE.md -> DB sync immediately (Issue #824).
 *
 * Invoked after a UI-driven CMATE.md write so the DB-backed schedule list and
 * in-memory cron jobs reflect the change without waiting for the next 60s poll.
 * Reuses the same syncSchedules() routine (with its isSyncing guard), so it does
 * not change the existing watcher behavior.
 */
export async function syncSchedulesNow(): Promise<void> {
  await syncSchedules();
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
    logger.debug('init:skip', { reason: 'already initialized' });
    return;
  }

  logger.info('init:start');

  // Recovery: mark stale running logs as failed
  recoverRunningLogs();

  // Initial sync (DJ-002: fire-and-forget, no .catch - fail-fast for fatal errors)
  void syncSchedules();

  // Start periodic sync timer (DJ-003: .catch for repeated execution safety)
  manager.timerId = setInterval(() => {
    void syncSchedules().catch(err =>
      logger.error('sync:unexpected-error', { error: err instanceof Error ? err.message : String(err) })
    );
  }, POLL_INTERVAL_MS);

  manager.initialized = true;
  logger.info('init:completed', { scheduleCount: manager.schedules.size });
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
  logger.info('stop:all-completed');
}

/**
 * Stop schedules for a specific worktree.
 * Issue #404: Used during worktree deletion to prevent resource leaks.
 *
 * Iterates the schedules map (O(N), N<=MAX_CONCURRENT_SCHEDULES=100),
 * stops cron jobs for the target worktree, and removes their entries.
 * Also removes the cmateFileCache entry for the worktree path (via DB lookup).
 *
 * activeProcesses are NOT killed (method (c): natural reclamation).
 * cronJob.stop() prevents new executions; running processes finish naturally.
 *
 * @param worktreeId - The worktree ID whose schedules should be stopped
 */
export function stopScheduleForWorktree(worktreeId: string): void {
  const manager = getManagerState();

  // Stop and remove cron jobs for the target worktree
  for (const [scheduleId, state] of manager.schedules) {
    if (state.worktreeId === worktreeId) {
      try {
        state.cronJob.stop();
      } catch {
        // Ignore errors during cleanup
      }
      manager.schedules.delete(scheduleId);
    }
  }

  // Remove cmateFileCache entry via DB lookup (worktreeId -> path)
  try {
    const db = getLazyDbInstance();
    const row = db.prepare('SELECT path FROM worktrees WHERE id = ?').get(worktreeId) as { path: string } | undefined;
    if (row?.path) {
      manager.cmateFileCache.delete(row.path);
    }
  } catch {
    // DB lookup failed - schedule stop already completed above (fallback)
    logger.warn('cache:cleanup-failed', { worktreeId });
  }

  logger.info('stop:worktree', { worktreeId });
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

/**
 * Get all unique worktree IDs that have active schedule entries.
 * Used by periodic resource cleanup to detect orphaned entries.
 *
 * @internal Exported for resource-cleanup and testing purposes.
 * @returns Array of unique worktree IDs present in the schedules Map
 */
export function getScheduleWorktreeIds(): string[] {
  const manager = getManagerState();
  const worktreeIds = new Set<string>();
  for (const [, state] of manager.schedules) {
    worktreeIds.add(state.worktreeId);
  }
  return Array.from(worktreeIds);
}

export function getActiveSchedulesForWorktree(worktreeId: string): ActiveScheduleInfo[] {
  const manager = getManagerState();
  const schedules: ActiveScheduleInfo[] = [];

  for (const [scheduleId, state] of manager.schedules) {
    if (state.worktreeId !== worktreeId) continue;

    let nextRunAt: number | null = null;
    try {
      const nextRun = typeof state.cronJob.nextRun === 'function'
        ? state.cronJob.nextRun()
        : null;
      if (nextRun instanceof Date) {
        nextRunAt = nextRun.getTime();
      }
    } catch {
      nextRunAt = null;
    }

    schedules.push({
      scheduleId,
      worktreeId,
      name: state.entry.name,
      cronExpression: state.entry.cronExpression,
      cliToolId: state.entry.cliToolId,
      enabled: state.entry.enabled,
      isExecuting: state.isExecuting,
      isCronActive: isCronJobActive(state.cronJob),
      nextRunAt,
      model: state.entry.model,
    });
  }

  schedules.sort((a, b) => a.name.localeCompare(b.name));
  return schedules;
}
