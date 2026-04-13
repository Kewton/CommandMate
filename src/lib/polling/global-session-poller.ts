/**
 * Global session polling for assistant chat
 * Issue #649: Simplified polling for global (non-worktree) sessions
 *
 * Unlike the main response-poller-core.ts, this poller:
 * - Does NOT interact with the database (no message creation/update)
 * - Does NOT use TUI accumulator or prompt dedup
 * - Only captures tmux pane output for display
 *
 * Follows the setTimeout chain pattern from response-poller-core.ts
 * to prevent overlapping polls.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  GLOBAL_POLL_INTERVAL_MS,
  GLOBAL_POLL_MAX_RETRIES,
  GLOBAL_SESSION_WORKTREE_ID,
} from '@/lib/session/global-session-constants';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { hasSession } from '@/lib/tmux/tmux';

const logger = createLogger('global-session-poller');

// ============================================================================
// State Management
// ============================================================================

/**
 * Active global pollers map: cliToolId -> NodeJS.Timeout
 * Module-scope variable (Node.js module cache ensures singleton behavior).
 */
const activeGlobalPollers = new Map<string, NodeJS.Timeout>();

/**
 * Polling iteration counts: cliToolId -> iteration count
 */
const pollerIterations = new Map<string, number>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Start polling for a global session.
 * If a poller is already active for this tool, it is stopped first.
 *
 * @param cliToolId - CLI tool ID to poll
 */
export function pollGlobalSession(cliToolId: CLIToolType): void {
  // Stop existing poller if any
  stopGlobalSessionPolling(cliToolId);

  pollerIterations.set(cliToolId, 0);
  scheduleNextPoll(cliToolId);

  logger.info('poll:started', { cliToolId });
}

/**
 * Stop polling for a specific global session.
 *
 * @param cliToolId - CLI tool ID to stop polling
 */
export function stopGlobalSessionPolling(cliToolId: CLIToolType): void {
  const timerId = activeGlobalPollers.get(cliToolId);
  if (timerId) {
    clearTimeout(timerId);
    activeGlobalPollers.delete(cliToolId);
    pollerIterations.delete(cliToolId);
    logger.info('poll:stopped', { cliToolId });
  }
}

/**
 * Stop all active global session pollers.
 * Used during server shutdown / cleanup.
 */
export function stopAllGlobalSessionPolling(): void {
  for (const cliToolId of activeGlobalPollers.keys()) {
    const timerId = activeGlobalPollers.get(cliToolId);
    if (timerId) {
      clearTimeout(timerId);
    }
  }
  activeGlobalPollers.clear();
  pollerIterations.clear();
  logger.info('poll:all-stopped');
}

/**
 * Check if a global session poller is active for a given tool.
 *
 * @param cliToolId - CLI tool ID to check
 * @returns true if polling is active
 */
export function isGlobalPollerActive(cliToolId: CLIToolType): boolean {
  return activeGlobalPollers.has(cliToolId);
}

/**
 * Get list of active global poller keys.
 *
 * @returns Array of CLI tool IDs with active pollers
 */
export function getActiveGlobalPollers(): string[] {
  return Array.from(activeGlobalPollers.keys());
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Schedule the next poll iteration using setTimeout chain pattern.
 * This prevents overlapping polls (unlike setInterval).
 */
function scheduleNextPoll(cliToolId: CLIToolType): void {
  const timerId = setTimeout(async () => {
    // Check iteration count against max retries
    const iteration = pollerIterations.get(cliToolId) ?? 0;
    if (iteration >= GLOBAL_POLL_MAX_RETRIES) {
      stopGlobalSessionPolling(cliToolId);
      logger.info('poll:max-retries-reached', { cliToolId, iteration });
      return;
    }

    pollerIterations.set(cliToolId, iteration + 1);

    // Check if session is still alive
    try {
      const manager = CLIToolManager.getInstance();
      const tool = manager.getTool(cliToolId);
      const sessionName = tool.getSessionName(GLOBAL_SESSION_WORKTREE_ID);
      const sessionExists = await hasSession(sessionName);

      if (!sessionExists) {
        stopGlobalSessionPolling(cliToolId);
        logger.info('poll:session-gone', { cliToolId });
        return;
      }
    } catch (error) {
      logger.error('poll:check-error', {
        cliToolId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Schedule next poll only if still active
    if (activeGlobalPollers.has(cliToolId)) {
      scheduleNextPoll(cliToolId);
    }
  }, GLOBAL_POLL_INTERVAL_MS);

  activeGlobalPollers.set(cliToolId, timerId);
}
