/**
 * Session Cleanup Utility (Facade Pattern)
 * Issue #69: Repository delete feature
 * Issue #138: Added auto-yes-poller cleanup
 * Issue #404: Added deleteAutoYesState and stopScheduleForWorktree
 *
 * Provides a unified interface for cleaning up CLI tool sessions and pollers.
 * Uses response-poller for CLI tool sessions.
 */

import { stopPolling as stopResponsePolling, clearPromptHashCache } from './polling/response-poller';
import { stopAutoYesPollingByWorktree, deleteAutoYesStateByWorktree } from './polling/auto-yes-manager';
import { stopScheduleForWorktree } from './schedule-manager';
import { stopTimersForWorktree } from './timer-manager';
import { stopAllGlobalSessionPolling } from './polling/global-session-poller';
import { clearAllCache } from './tmux/tmux-capture-cache';
import { CLI_TOOL_IDS, type CLIToolType } from './cli-tools/types';
import { GLOBAL_SESSION_WORKTREE_ID } from './session/global-session-constants';
import { getErrorMessage } from './errors';
import { createLogger } from '@/lib/logger';
import { CLIToolManager } from './cli-tools/manager';
import { killSession, hasSession } from './tmux/tmux';
import { syncWorktreesToDB, type SyncResult } from './git/worktrees';
import type { Worktree } from '@/types/models';
import type Database from 'better-sqlite3';

const logger = createLogger('session-cleanup');

/**
 * Result of cleaning up a single worktree's sessions
 */
export interface WorktreeCleanupResult {
  /** Worktree ID that was cleaned up */
  worktreeId: string;
  /** CLI tool session names that were successfully killed */
  sessionsKilled: string[];
  /** Errors encountered while killing sessions */
  sessionErrors: string[];
  /** Pollers that were successfully stopped */
  pollersStopped: string[];
  /** Errors encountered while stopping pollers */
  pollerErrors: string[];
}

/**
 * Result of cleaning up multiple worktrees
 */
export interface CleanupResult {
  /** Individual results for each worktree */
  results: WorktreeCleanupResult[];
  /** Aggregated warning messages */
  warnings: string[];
}

/**
 * Type for the kill session function
 */
type KillSessionFn = (worktreeId: string, cliToolId: CLIToolType) => Promise<boolean>;

/**
 * Clean up all CLI tool sessions and pollers for a single worktree
 *
 * This function:
 * 1. Kills all CLI tool sessions using the provided killSessionFn
 * 2. Stops response-poller for each CLI tool
 * 3. Stops auto-yes polling and deletes auto-yes state (Issue #404)
 * 4. Stops schedules for this worktree (Issue #404)
 *
 * Call order (Issue #404): stopAutoYesPolling -> deleteAutoYesState -> stopScheduleForWorktree
 *
 * Errors are collected but do not stop the cleanup process (partial success is allowed).
 *
 * @param worktreeId - ID of the worktree to clean up
 * @param killSessionFn - Function to kill a session for a specific CLI tool
 * @returns Cleanup result with killed sessions and any errors
 */
export async function cleanupWorktreeSessions(
  worktreeId: string,
  killSessionFn: KillSessionFn
): Promise<WorktreeCleanupResult> {
  const result: WorktreeCleanupResult = {
    worktreeId,
    sessionsKilled: [],
    sessionErrors: [],
    pollersStopped: [],
    pollerErrors: [],
  };

  // Issue #405: Clear all capture cache at shutdown start
  clearAllCache();

  // 1. Kill sessions and stop response-pollers for each CLI tool
  for (const cliToolId of CLI_TOOL_IDS) {
    // Kill session
    try {
      const killed = await killSessionFn(worktreeId, cliToolId);
      if (killed) {
        result.sessionsKilled.push(cliToolId);
        logger.info('session:killed', { worktreeId, cliToolId });
      }
    } catch (error) {
      const errorMsg = `${cliToolId}: ${getErrorMessage(error)}`;
      result.sessionErrors.push(errorMsg);
      logger.warn('session:kill-failed', { worktreeId, cliToolId, error: error instanceof Error ? error.message : String(error) });
    }

    // Stop response-poller
    try {
      stopResponsePolling(worktreeId, cliToolId);
      result.pollersStopped.push(`response-poller:${cliToolId}`);
    } catch (error) {
      const errorMsg = `response-poller:${cliToolId}: ${getErrorMessage(error)}`;
      result.pollerErrors.push(errorMsg);
      logger.warn('response-poller:stop-failed', { worktreeId, cliToolId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // 2. Stop auto-yes-poller for all agents (Issue #138, #525: byWorktree helper)
  // Order: stopAutoYesPollingByWorktree -> deleteAutoYesStateByWorktree -> stopScheduleForWorktree (Issue #404)
  try {
    stopAutoYesPollingByWorktree(worktreeId);
    result.pollersStopped.push('auto-yes-poller');
  } catch (error) {
    const errorMsg = `auto-yes-poller: ${getErrorMessage(error)}`;
    result.pollerErrors.push(errorMsg);
    logger.warn('auto-yes-poller:stop-failed', { worktreeId, error: error instanceof Error ? error.message : String(error) });
  }

  // 3. Delete auto-yes state for all agents (Issue #404, #525: byWorktree helper)
  try {
    deleteAutoYesStateByWorktree(worktreeId);
    result.pollersStopped.push('auto-yes-state');
  } catch (error) {
    const errorMsg = `auto-yes-state: ${getErrorMessage(error)}`;
    result.pollerErrors.push(errorMsg);
    logger.warn('auto-yes-state:delete-failed', { worktreeId, error: error instanceof Error ? error.message : String(error) });
  }

  // 4. Stop schedules for this worktree (Issue #404: replaces stopAllSchedules)
  try {
    stopScheduleForWorktree(worktreeId);
    result.pollersStopped.push('schedule-manager');
  } catch (error) {
    const errorMsg = `schedule-manager: ${getErrorMessage(error)}`;
    result.pollerErrors.push(errorMsg);
    logger.warn('schedule-manager:stop-failed', { worktreeId, error: error instanceof Error ? error.message : String(error) });
  }

  // 5. Stop timers for this worktree (Issue #534)
  try {
    stopTimersForWorktree(worktreeId);
    result.pollersStopped.push('timer-manager');
  } catch (error) {
    const errorMsg = `timer-manager: ${getErrorMessage(error)}`;
    result.pollerErrors.push(errorMsg);
    logger.warn('timer-manager:stop-failed', { worktreeId, error: error instanceof Error ? error.message : String(error) });
  }

  return result;
}

/**
 * Clean up sessions and pollers for multiple worktrees
 *
 * @param worktreeIds - Array of worktree IDs to clean up
 * @param killSessionFn - Function to kill a session for a specific CLI tool
 * @returns Aggregated cleanup results and warnings
 */
export async function cleanupMultipleWorktrees(
  worktreeIds: string[],
  killSessionFn: KillSessionFn
): Promise<CleanupResult> {
  // Issue #526 / SF-003: Parallel execution with Promise.allSettled
  const settled = await Promise.allSettled(
    worktreeIds.map(worktreeId => cleanupWorktreeSessions(worktreeId, killSessionFn))
  );

  const results: WorktreeCleanupResult[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const worktreeId = worktreeIds[i];

    if (outcome.status === 'fulfilled') {
      const result = outcome.value;
      results.push(result);

      // Collect warnings from errors
      for (const error of result.sessionErrors) {
        warnings.push(`Session kill error (${worktreeId}): ${error}`);
      }
      for (const error of result.pollerErrors) {
        warnings.push(`Poller stop error (${worktreeId}): ${error}`);
      }
    } else {
      // Unexpected rejection from cleanupWorktreeSessions
      warnings.push(`Cleanup failed (${worktreeId}): ${getErrorMessage(outcome.reason)}`);
    }
  }

  return { results, warnings };
}

/**
 * Kill a CLI tool session for a worktree
 * Issue #526: Common function extracted from repositories/route.ts
 *
 * MF-C01: getTool() throws Error if tool not found, wrapped in try-catch
 * SF-004: isRunning() correctly awaited
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool type
 * @returns true if session was killed, false otherwise
 */
export async function killWorktreeSession(
  worktreeId: string,
  cliToolId: CLIToolType
): Promise<boolean> {
  try {
    const manager = CLIToolManager.getInstance();
    const tool = manager.getTool(cliToolId); // throws Error if not found
    if (!await tool.isRunning(worktreeId)) return false; // SF-004: await

    // Issue #565: Clear prompt dedup cache on session kill
    const pollerKey = `${worktreeId}:${cliToolId}`;
    clearPromptHashCache(pollerKey);

    const sessionName = tool.getSessionName(worktreeId);
    return killSession(sessionName);
  } catch {
    return false;
  }
}

/**
 * Clean up all global assistant sessions.
 * Issue #649: Kill any orphaned mcbd-{cli_tool_id}-__global__ tmux sessions
 * and stop all global session pollers.
 *
 * Called during server shutdown and syncWorktreesAndCleanup.
 * Errors are logged but do not propagate (cleanup is best-effort).
 *
 * @returns Number of sessions killed
 */
export async function cleanupGlobalSessions(): Promise<number> {
  // Stop all global pollers first
  stopAllGlobalSessionPolling();

  let sessionsKilled = 0;
  const manager = CLIToolManager.getInstance();

  for (const cliToolId of CLI_TOOL_IDS) {
    try {
      const tool = manager.getTool(cliToolId);
      const sessionName = tool.getSessionName(GLOBAL_SESSION_WORKTREE_ID);
      const exists = await hasSession(sessionName);
      if (exists) {
        const killed = await killSession(sessionName);
        if (killed) {
          sessionsKilled++;
          logger.info('global-session:killed', { cliToolId, sessionName });
        }
      }
    } catch (error) {
      logger.warn('global-session:kill-failed', {
        cliToolId,
        error: getErrorMessage(error),
      });
    }
  }

  return sessionsKilled;
}

/**
 * Result of syncWorktreesAndCleanup
 */
export interface SyncAndCleanupResult {
  /** Result from syncWorktreesToDB */
  syncResult: SyncResult;
  /** Sanitized cleanup warnings (SEC-MF-001: generic messages only) */
  cleanupWarnings: string[];
}

/**
 * Sync worktrees to DB and clean up sessions for deleted worktrees
 * Issue #526 / MF-001: DRY helper combining sync + cleanup
 *
 * SEC-MF-001: cleanupWarnings are sanitized - detailed errors logged server-side only,
 * client-facing warnings contain only generic messages.
 *
 * @param db - Database instance
 * @param worktrees - Array of worktrees to sync
 * @returns SyncResult and sanitized cleanupWarnings
 */
export async function syncWorktreesAndCleanup(
  db: Database.Database,
  worktrees: Worktree[]
): Promise<SyncAndCleanupResult> {
  const syncResult = syncWorktreesToDB(db, worktrees);

  // Issue #649: Clean up orphaned global assistant sessions
  try {
    await cleanupGlobalSessions();
  } catch (error) {
    logger.warn('sync:global-cleanup-failed', { error: getErrorMessage(error) });
  }

  let cleanupWarnings: string[] = [];

  if (syncResult.deletedIds.length > 0) {
    try {
      const cleanupResult = await cleanupMultipleWorktrees(
        syncResult.deletedIds,
        killWorktreeSession
      );

      if (cleanupResult.warnings.length > 0) {
        // SEC-MF-001: Log detailed warnings server-side only
        logger.warn('sync:cleanup-warnings', { warnings: cleanupResult.warnings });
        // Return sanitized generic message to client
        cleanupWarnings = [`${cleanupResult.warnings.length} session cleanup warning(s) occurred`];
      }
    } catch (error) {
      // Cleanup failure should not break sync
      logger.error('sync:cleanup-failed', { error: getErrorMessage(error) });
      cleanupWarnings = ['Session cleanup encountered an error'];
    }
  }

  return { syncResult, cleanupWarnings };
}
