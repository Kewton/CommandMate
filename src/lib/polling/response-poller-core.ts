/** Polling lifecycle management: start, stop, schedule, and state tracking for response polling. */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  initTuiAccumulator,
  clearTuiAccumulator,
} from '../tui-accumulator';
import { clearPromptHashCache, renamePromptHashCacheKey } from './prompt-dedup';
import { clearResponseHashCache, renameResponseHashCacheKey } from './response-dedup';
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

  // Issue #1268: Clear response hash cache too, so the next turn can save a
  // response even when its content is identical to the previous turn's.
  clearResponseHashCache(pollerKey);
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

// ============================================================================
// Worktree ID migration (Issue #1621 Phase 3)
// ============================================================================

/** One response poller that moved from one worktree ID to another. */
export interface MigratedPollerKey {
  /** Poller key the poller used to run under */
  oldKey: string;
  /** Poller key it runs under now */
  newKey: string;
  /** Worktree ID after the move */
  newWorktreeId: string;
  /** CLI tool being polled */
  cliToolId: CLIToolType;
  /** Agent instance being polled (equals cliToolId for the primary) */
  instanceId: string;
}

/** Split a poller key into its worktree and instance halves. */
function splitPollerKey(pollerKey: string): { worktreeId: string; instanceId: string } | null {
  const separatorIndex = pollerKey.indexOf(':');
  // A worktree ID never contains ':' (isValidWorktreeId), so the first one is
  // always the boundary.
  if (separatorIndex <= 0 || separatorIndex === pollerKey.length - 1) return null;
  return {
    worktreeId: pollerKey.slice(0, separatorIndex),
    instanceId: pollerKey.slice(separatorIndex + 1),
  };
}

/**
 * Move every running response poller from a renamed worktree ID to the new one
 * (Issue #1621 Phase 3).
 *
 * Re-keying the maps alone is **not** enough, and this is the subtle part: the
 * `setTimeout` chain in {@link scheduleNextResponsePoll} closes over
 * `worktreeId` and recomputes its key on every tick. A poller left running
 * would go on capturing `mcbd-<cli>-<OLD id>` (a session that no longer exists
 * after the rename), writing its messages against an ID no row carries, and
 * re-registering the old key the moment it fired. So each poller is torn down
 * and restarted under the new ID, with everything that represents *progress*
 * carried across:
 *
 * - `pollingStartTimes`, so MAX_POLLING_DURATION still measures from when the
 *   turn actually began rather than restarting the 30-minute budget;
 * - the prompt and response dedup hashes, so the screen currently on display is
 *   not saved a second time as a new message.
 *
 * The TUI accumulator (opencode / copilot only) is re-initialised empty at the
 * new key instead of carried over: `tui-accumulator.ts` exposes no way to write
 * a buffer back, and it is outside this Issue's allowed scope. The cost is that
 * one in-flight TUI response may be truncated at the rename boundary; the next
 * turn accumulates normally.
 *
 * Takes the whole batch because IDs can swap (A→B, B→A): every source key is
 * removed before any destination key is written.
 *
 * @param renames - Worktree ID pairs being applied
 * @param resolveCliToolId - Maps a poller's (worktree, instance) back to its CLI
 *   tool, which the poller key does not encode for alias instances. Callers pass
 *   a roster-backed lookup; returning null skips that poller (it is stopped
 *   rather than left pointing at a dead ID).
 * @returns One entry per poller that was moved
 */
export function migrateResponsePollerWorktreeIds(
  renames: ReadonlyArray<{ oldId: string; newId: string }>,
  resolveCliToolId: (worktreeId: string, instanceId: string) => CLIToolType | null
): MigratedPollerKey[] {
  const targets = new Map<string, string>();
  for (const { oldId, newId } of renames) {
    if (!oldId || !newId || oldId === newId) continue;
    targets.set(oldId, newId);
  }
  if (targets.size === 0) return [];

  const moves: MigratedPollerKey[] = [];
  const abandoned: string[] = [];

  for (const pollerKey of Array.from(activePollers.keys())) {
    const parts = splitPollerKey(pollerKey);
    if (!parts) continue;
    const newWorktreeId = targets.get(parts.worktreeId);
    if (!newWorktreeId) continue;

    const cliToolId = resolveCliToolId(parts.worktreeId, parts.instanceId);
    if (!cliToolId) {
      abandoned.push(pollerKey);
      continue;
    }

    moves.push({
      oldKey: pollerKey,
      newKey: getPollerKey(newWorktreeId, cliToolId, parts.instanceId),
      newWorktreeId,
      cliToolId,
      instanceId: parts.instanceId,
    });
  }

  // Phase 1: stop every affected timer and lift the state off the old keys.
  // Done for the whole batch before any write so a swap cannot self-collide.
  const carried = new Map<string, { startedAt: number | undefined }>();
  for (const move of moves) {
    const timerId = activePollers.get(move.oldKey);
    if (timerId) clearTimeout(timerId);
    activePollers.delete(move.oldKey);

    carried.set(move.newKey, { startedAt: pollingStartTimes.get(move.oldKey) });
    pollingStartTimes.delete(move.oldKey);

    renamePromptHashCacheKey(move.oldKey, move.newKey);
    renameResponseHashCacheKey(move.oldKey, move.newKey);
    clearTuiAccumulator(move.oldKey);
  }
  for (const pollerKey of abandoned) {
    stopPollingByKey(pollerKey);
    logger.warn('poller:migrate-abandoned', { pollerKey });
  }

  // Phase 2: restart each poller under its new identity.
  for (const move of moves) {
    const startedAt = carried.get(move.newKey)?.startedAt;
    pollingStartTimes.set(move.newKey, startedAt ?? Date.now());
    if (move.cliToolId === 'opencode' || move.cliToolId === 'copilot') {
      initTuiAccumulator(move.newKey);
    }
    scheduleNextResponsePoll(move.newWorktreeId, move.cliToolId, move.instanceId);
  }

  return moves;
}
