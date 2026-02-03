/**
 * Session Cleanup Utility (Facade Pattern)
 * Issue #69: Repository delete feature
 * Issue #138: Added auto-yes-poller cleanup
 *
 * Provides a unified interface for cleaning up CLI tool sessions and pollers.
 * Abstracts the differences between response-poller and claude-poller.
 */

import { stopPolling as stopResponsePolling } from './response-poller';
import { stopPolling as stopClaudePolling } from './claude-poller';
import { stopAutoYesPolling } from './auto-yes-manager';
import type { CLIToolType } from './cli-tools/types';

/**
 * All supported CLI tool IDs
 */
const CLI_TOOL_IDS: CLIToolType[] = ['claude', 'codex', 'gemini'];

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

const LOG_PREFIX = '[Session Cleanup]';

/**
 * Clean up all CLI tool sessions and pollers for a single worktree
 *
 * This function:
 * 1. Kills all CLI tool sessions (claude, codex, gemini) using the provided killSessionFn
 * 2. Stops response-poller for each CLI tool
 * 3. Stops claude-poller for the worktree
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

  // 1. Kill sessions and stop response-pollers for each CLI tool
  for (const cliToolId of CLI_TOOL_IDS) {
    // Kill session
    try {
      const killed = await killSessionFn(worktreeId, cliToolId);
      if (killed) {
        result.sessionsKilled.push(cliToolId);
        console.info(`${LOG_PREFIX} Killed session: ${worktreeId}/${cliToolId}`);
      }
    } catch (error) {
      const errorMsg = `${cliToolId}: ${error instanceof Error ? error.message : String(error)}`;
      result.sessionErrors.push(errorMsg);
      console.warn(`${LOG_PREFIX} Failed to kill session ${worktreeId}/${cliToolId}:`, error);
    }

    // Stop response-poller
    try {
      stopResponsePolling(worktreeId, cliToolId);
      result.pollersStopped.push(`response-poller:${cliToolId}`);
    } catch (error) {
      const errorMsg = `response-poller:${cliToolId}: ${error instanceof Error ? error.message : String(error)}`;
      result.pollerErrors.push(errorMsg);
      console.warn(`${LOG_PREFIX} Failed to stop response-poller ${worktreeId}/${cliToolId}:`, error);
    }
  }

  // 2. Stop claude-poller (once per worktree, not per CLI tool)
  try {
    stopClaudePolling(worktreeId);
    result.pollersStopped.push('claude-poller');
  } catch (error) {
    const errorMsg = `claude-poller: ${error instanceof Error ? error.message : String(error)}`;
    result.pollerErrors.push(errorMsg);
    console.warn(`${LOG_PREFIX} Failed to stop claude-poller ${worktreeId}:`, error);
  }

  // 3. Stop auto-yes-poller (Issue #138)
  try {
    stopAutoYesPolling(worktreeId);
    result.pollersStopped.push('auto-yes-poller');
  } catch (error) {
    const errorMsg = `auto-yes-poller: ${error instanceof Error ? error.message : String(error)}`;
    result.pollerErrors.push(errorMsg);
    console.warn(`${LOG_PREFIX} Failed to stop auto-yes-poller ${worktreeId}:`, error);
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
  const results: WorktreeCleanupResult[] = [];
  const warnings: string[] = [];

  for (const worktreeId of worktreeIds) {
    const result = await cleanupWorktreeSessions(worktreeId, killSessionFn);
    results.push(result);

    // Collect warnings from errors
    for (const error of result.sessionErrors) {
      warnings.push(`Session kill error (${worktreeId}): ${error}`);
    }
    for (const error of result.pollerErrors) {
      warnings.push(`Poller stop error (${worktreeId}): ${error}`);
    }
  }

  return { results, warnings };
}
