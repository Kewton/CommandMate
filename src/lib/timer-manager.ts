/**
 * Timer Manager
 * Issue #534: Manages delayed message sending via setTimeout
 *
 * [DP-003] Located in src/lib/ alongside schedule-manager.ts
 * Uses globalThis singleton pattern for Hot Reload persistence.
 * Uses CLIToolManager.getInstance().getTool() for session name resolution [CON-MF-001/DP-004].
 */

import {
  getTimerById,
  getPendingTimers,
  updateTimerStatus,
  cancelTimer,
  cancelTimersByWorktree,
} from './db/timer-db';
import { sendKeys } from './tmux/tmux';
import { CLIToolManager } from './cli-tools/manager';
import { getDbInstance } from '@/lib/db-instance';
import { createLogger } from '@/lib/logger';
import { TIMER_STATUS } from '@/config/timer-constants';
import type { CLIToolType } from './cli-tools/types';

const logger = createLogger('timer-manager');

// =============================================================================
// Types
// =============================================================================

/** Timer state stored in globalThis */
interface TimerManagerState {
  /** timerId -> setTimeout handle */
  timers: Map<string, NodeJS.Timeout>;
  /** timerId -> worktreeId mapping (for worktree-level operations) */
  timerWorktrees: Map<string, string>;
  /** Whether the manager is initialized */
  initialized: boolean;
}

// =============================================================================
// globalThis Singleton [DP-003]
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __timerManagerState: TimerManagerState | undefined;
}

function getState(): TimerManagerState {
  if (!globalThis.__timerManagerState) {
    globalThis.__timerManagerState = {
      timers: new Map(),
      timerWorktrees: new Map(),
      initialized: false,
    };
  }
  return globalThis.__timerManagerState;
}

// =============================================================================
// Timer Execution [DP-004/CON-MF-001]
// =============================================================================

/**
 * Execute a timer: resolve session name via CLIToolManager, send keys via tmux.
 * try-catch-finally pattern following job-executor.ts.
 * [SEC-MF-001] Error details logged server-side only.
 */
async function executeTimer(timerId: string): Promise<void> {
  const state = getState();
  const db = getDbInstance();

  try {
    const timer = getTimerById(db, timerId);
    if (!timer || timer.status !== 'pending') return;

    // [DP-004/CON-MF-001] Resolve session name via CLIToolManager singleton
    const cliTool = CLIToolManager.getInstance().getTool(timer.cliToolId as CLIToolType);

    // [Issue #539] Check if session is running before sending
    const isRunning = await cliTool.isRunning(timer.worktreeId);
    if (!isRunning) {
      logger.warn('timer:no-session', { timerId, worktreeId: timer.worktreeId });
      updateTimerStatus(db, timerId, TIMER_STATUS.NO_SESSION);
      return;
    }

    const sessionName = cliTool.getSessionName(timer.worktreeId);

    updateTimerStatus(db, timerId, 'sending');
    await sendKeys(sessionName, timer.message, true);
    updateTimerStatus(db, timerId, 'sent', Date.now());

    logger.info('timer:sent', { timerId, worktreeId: timer.worktreeId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      updateTimerStatus(db, timerId, 'failed');
    } catch {
      // DB update failure is non-fatal
    }
    logger.error('timer:send-failed', { timerId, error: msg });
  } finally {
    // Clean up from active timers map
    state.timers.delete(timerId);
    state.timerWorktrees.delete(timerId);
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Initialize timer manager: restore pending timers from DB.
 * [IMP-C-003] No MAX_TIMERS_PER_WORKTREE check during restore.
 * Past-due timers are executed immediately.
 */
export function initTimerManager(): void {
  const state = getState();
  if (state.initialized) return;

  const db = getDbInstance();
  const pendingTimers = getPendingTimers(db);

  for (const timer of pendingTimers) {
    const remaining = timer.scheduledSendTime - Date.now();
    const delay = Math.max(0, remaining); // Past-due timers fire immediately
    scheduleTimer(timer.id, timer.worktreeId, delay);
  }

  state.initialized = true;
  logger.info('timer-manager:initialized', { restoredCount: pendingTimers.length });
}

/**
 * Stop all timers. [IMP-MF-001] Map.clear() synchronously first.
 */
export function stopAllTimers(): void {
  const state = getState();

  // Capture handles before clearing
  const handles = Array.from(state.timers.values());

  // [IMP-MF-001] Synchronous clear first
  state.timers.clear();
  state.timerWorktrees.clear();
  state.initialized = false;

  // Then clear timeouts
  for (const handle of handles) {
    clearTimeout(handle);
  }
}

/**
 * Schedule a timer with setTimeout.
 */
export function scheduleTimer(
  timerId: string,
  worktreeId: string,
  delayMs: number
): void {
  const state = getState();

  const handle = setTimeout(() => {
    void executeTimer(timerId);
  }, delayMs);

  state.timers.set(timerId, handle);
  state.timerWorktrees.set(timerId, worktreeId);
}

/**
 * Cancel a scheduled timer (clearTimeout + DB update).
 */
export function cancelScheduledTimer(timerId: string): void {
  const state = getState();
  const handle = state.timers.get(timerId);

  if (handle) {
    clearTimeout(handle);
    state.timers.delete(timerId);
    state.timerWorktrees.delete(timerId);
  }

  const db = getDbInstance();
  cancelTimer(db, timerId);
}

/**
 * Stop all timers for a worktree (session-cleanup integration).
 * Uses in-memory timerWorktrees map to find timers (avoids redundant DB query).
 */
export function stopTimersForWorktree(worktreeId: string): void {
  const state = getState();
  const db = getDbInstance();

  // Find timers for this worktree from in-memory map (no DB query needed)
  for (const [timerId, wtId] of state.timerWorktrees) {
    if (wtId === worktreeId) {
      const handle = state.timers.get(timerId);
      if (handle) {
        clearTimeout(handle);
      }
      state.timers.delete(timerId);
      state.timerWorktrees.delete(timerId);
    }
  }

  // Batch cancel in DB
  cancelTimersByWorktree(db, worktreeId);
}

/**
 * Get count of active (in-memory) timers.
 */
export function getActiveTimerCount(): number {
  return getState().timers.size;
}

/**
 * Get set of worktree IDs that have active timers.
 * [CON-SF-003] Used by resource-cleanup for orphan detection.
 */
export function getTimerWorktreeIds(): Set<string> {
  return new Set(getState().timerWorktrees.values());
}
