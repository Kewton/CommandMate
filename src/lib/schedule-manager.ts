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
function getLazyDbInstance(): ReturnType<typeof import('./db-instance').getDbInstance> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDbInstance } = require('./db-instance') as typeof import('./db-instance');
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

          if (manager.schedules.size >= MAX_CONCURRENT_SCHEDULES) {
            logger.warn('schedule:max-concurrent-reached', { limit: MAX_CONCURRENT_SCHEDULES });
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
