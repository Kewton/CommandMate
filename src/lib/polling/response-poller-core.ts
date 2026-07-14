/** Polling lifecycle management: start, stop, schedule, and state tracking for response polling. */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  initTuiAccumulator,
  clearTuiAccumulator,
} from '../tui-accumulator';
import { clearPromptHashCache } from './prompt-dedup';
import { checkForResponse } from './response-checker';
import { broadcastTerminalSnapshot } from '@/lib/realtime/terminal-broadcast';

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
 * Active pollers map: "worktreeId:instanceId" -> NodeJS.Timeout
 *
 * Module-scope variable (not globalThis). Node.js module cache ensures
 * singleton behavior. See D3-004 in design policy for details.
 *
 * Issue #868: The key is scoped by instanceId so multiple instances of the
 * same CLI tool on one worktree get independent pollers. For the primary
 * instance (instanceId omitted or equal to cliToolId), the key is identical
 * to the legacy "worktreeId:cliToolId" form for backward compatibility.
 */
export const activePollers = new Map<string, NodeJS.Timeout>();

/**
 * Polling start times map: "worktreeId:instanceId" -> timestamp
 */
export const pollingStartTimes = new Map<string, number>();

/**
 * Generate poller key from worktree ID and agent instance.
 *
 * Issue #868: When instanceId is omitted it defaults to cliToolId (the primary
 * instance), preserving the legacy "worktreeId:cliToolId" key.
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini, ...)
 * @param instanceId - Optional agent instance ID (defaults to cliToolId)
 */
export function getPollerKey(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): string {
  return `${worktreeId}:${instanceId ?? cliToolId}`;
}

// ============================================================================
// Polling lifecycle (public API)
// ============================================================================

/**
 * Start polling for CLI tool response
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param instanceId - Optional agent instance ID (defaults to primary)
 *
 * @example
 * ```typescript
 * startPolling('feature-foo', 'claude');
 * ```
 */
export function startPolling(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);

  // Stop existing poller if any
  stopPolling(worktreeId, cliToolId, instanceId);

  // Record start time
  pollingStartTimes.set(pollerKey, Date.now());

  // Initialize TUI accumulator for full-screen TUI tools (Layer 2 safety net)
  if (cliToolId === 'opencode' || cliToolId === 'copilot') {
    initTuiAccumulator(pollerKey);
  }

  // Start polling with setTimeout chain to prevent race conditions
  scheduleNextResponsePoll(worktreeId, cliToolId, instanceId);
}

/** Schedule next checkForResponse() after current one completes (setTimeout chain) */
export function scheduleNextResponsePoll(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): void {
  const pollerKey = getPollerKey(worktreeId, cliToolId, instanceId);

  const timerId = setTimeout(async () => {
    // Check if max duration exceeded
    const startTime = pollingStartTimes.get(pollerKey);
    if (startTime && Date.now() - startTime > MAX_POLLING_DURATION) {
      stopPolling(worktreeId, cliToolId, instanceId);
      return;
    }

    // Check for response
    try {
      await checkForResponse(worktreeId, cliToolId, instanceId);
    } catch (error: unknown) {
      logger.error('error:', { error: error instanceof Error ? error.message : String(error) });
    }

    // Issue #1120: push the current terminal snapshot to WS subscribers so the
    // output streams during generation. No-op (and no tmux capture) when nobody
    // is subscribed to the worktree room. Best-effort; polling is the fallback.
    void broadcastTerminalSnapshot(worktreeId, cliToolId, instanceId);

    // Schedule next poll ONLY after current one completes
    // Guard: only if poller is still active (not stopped during checkForResponse)
    if (activePollers.has(pollerKey)) {
      scheduleNextResponsePoll(worktreeId, cliToolId, instanceId);
    }
  }, POLLING_INTERVAL);

  activePollers.set(pollerKey, timerId);
}

/**
 * Stop the poller identified by an already-computed poller key.
 * Shared by stopPolling() and stopAllPolling() so cleanup logic stays in one place.
 */
function stopPollingByKey(pollerKey: string): void {
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
 * Stop polling for a worktree and CLI tool / instance combination
 *
 * @param worktreeId - Worktree ID
 * @param cliToolId - CLI tool ID (claude, codex, gemini)
 * @param instanceId - Optional agent instance ID (defaults to primary)
 *
 * @example
 * ```typescript
 * stopPolling('feature-foo', 'claude');
 * ```
 */
export function stopPolling(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): void {
  stopPollingByKey(getPollerKey(worktreeId, cliToolId, instanceId));
}

/**
 * Stop all active pollers
 * Used for cleanup on server shutdown
 */
export function stopAllPolling(): void {
  for (const pollerKey of Array.from(activePollers.keys())) {
    stopPollingByKey(pollerKey);
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
