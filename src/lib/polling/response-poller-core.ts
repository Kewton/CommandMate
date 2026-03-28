/** Polling lifecycle management: start, stop, schedule, and state tracking for response polling. */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  initTuiAccumulator,
  clearTuiAccumulator,
} from '../tui-accumulator';
import { clearPromptHashCache } from './prompt-dedup';
import { checkForResponse } from './response-checker';

const logger = createLogger('response-poller');

// ============================================================================
// Constants
// ============================================================================

/**
 * Polling interval in milliseconds (default: 2 seconds)
 */
export const POLLING_INTERVAL = 2000;

/**
 * Maximum polling duration in milliseconds (default: 30 minutes)
 * Previously 5 minutes, which caused silent polling stops for long-running tasks.
 */
export const MAX_POLLING_DURATION = 30 * 60 * 1000;

/**
 * Gemini auth/loading state indicators that should not be treated as complete responses.
 * Braille spinner characters are shared with CLAUDE_SPINNER_CHARS in cli-patterns.ts.
 * Extracted to module level for clarity and to avoid re-creation on each call.
 */
export const GEMINI_LOADING_INDICATORS: readonly string[] = [
  'Waiting for auth',
  '\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f',
];

// ============================================================================
// Poller State Management
// ============================================================================

/**
 * Active pollers map: "worktreeId:cliToolId" -> NodeJS.Timeout
 *
 * Module-scope variable (not globalThis). Node.js module cache ensures
 * singleton behavior. See D3-004 in design policy for details.
 */
export const activePollers = new Map<string, NodeJS.Timeout>();

/**
 * Polling start times map: "worktreeId:cliToolId" -> timestamp
 */
export const pollingStartTimes = new Map<string, number>();

/**
 * Generate poller key from worktree ID and CLI tool ID
 */
export function getPollerKey(worktreeId: string, cliToolId: CLIToolType): string {
  return `${worktreeId}:${cliToolId}`;
}

// ============================================================================
// Polling lifecycle (public API)
// ============================================================================

/**
 * Start polling for CLI tool response
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 *
 * @example
 * ```typescript
 * startPolling('feature-foo', 'claude');
 * ```
 */
export function startPolling(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId);

  // Stop existing poller if any
  stopPolling(worktreeId, cliToolId);

  // Record start time
  pollingStartTimes.set(pollerKey, Date.now());

  // Initialize TUI accumulator for full-screen TUI tools (Layer 2 safety net)
  if (cliToolId === 'opencode' || cliToolId === 'copilot') {
    initTuiAccumulator(pollerKey);
  }

  // Start polling with setTimeout chain to prevent race conditions
  scheduleNextResponsePoll(worktreeId, cliToolId);
}

/** Schedule next checkForResponse() after current one completes (setTimeout chain) */
export function scheduleNextResponsePoll(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId);

  const timerId = setTimeout(async () => {
    // Check if max duration exceeded
    const startTime = pollingStartTimes.get(pollerKey);
    if (startTime && Date.now() - startTime > MAX_POLLING_DURATION) {
      stopPolling(worktreeId, cliToolId);
      return;
    }

    // Check for response
    try {
      await checkForResponse(worktreeId, cliToolId);
    } catch (error: unknown) {
      logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    }

    // Schedule next poll ONLY after current one completes
    // Guard: only if poller is still active (not stopped during checkForResponse)
    if (activePollers.has(pollerKey)) {
      scheduleNextResponsePoll(worktreeId, cliToolId);
    }
  }, POLLING_INTERVAL);

  activePollers.set(pollerKey, timerId);
}

/**
 * Stop polling for a worktree and CLI tool combination
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 *
 * @example
 * ```typescript
 * stopPolling('feature-foo', 'claude');
 * ```
 */
export function stopPolling(worktreeId: string, cliToolId: CLIToolType): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId);
  const timerId = activePollers.get(pollerKey);

  if (timerId) {
    clearTimeout(timerId);
    activePollers.delete(pollerKey);
    pollingStartTimes.delete(pollerKey);
  }

  // Clean up TUI accumulator if present
  clearTuiAccumulator(pollerKey);

  // Issue #565: Clear prompt hash cache to prevent stale dedup state
  clearPromptHashCache(pollerKey);
}

/**
 * Stop all active pollers
 * Used for cleanup on server shutdown
 */
export function stopAllPolling(): void {
  for (const pollerKey of activePollers.keys()) {
    const [worktreeId, cliToolId] = pollerKey.split(':') as [string, CLIToolType];
    stopPolling(worktreeId, cliToolId);
  }
}

/**
 * Get list of active pollers
 *
 * @returns Array of worktree IDs currently being polled
 */
export function getActivePollers(): string[] {
  return Array.from(activePollers.keys());
}
