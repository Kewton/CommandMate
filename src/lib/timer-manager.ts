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
  cleanupOldTimers,
  recoverStuckSendingTimers,
} from './db/timer-db';
import { CLIToolManager } from './cli-tools/manager';
import { getDbInstance } from '@/lib/db/db-instance';
import { createLogger } from '@/lib/logger';
import { TIMER_CLEANUP_RETENTION_DAYS, TIMER_STATUS } from '@/config/timer-constants';
import { sendUserMessage } from '@/lib/session/send-user-message';
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

    // [Issue #942] Target the specific agent instance session. Legacy timers
    // (and primary instances) have instanceId === cliToolId, preserving the
    // original single-session behavior.
    const instanceId = timer.instanceId;

    // [Issue #539] Check if session is running before sending
    const isRunning = await cliTool.isRunning(timer.worktreeId, instanceId);
    if (!isRunning) {
      logger.warn('timer:no-session', { timerId, worktreeId: timer.worktreeId, instanceId });
      updateTimerStatus(db, timerId, TIMER_STATUS.NO_SESSION);
      return;
    }

    updateTimerStatus(db, timerId, 'sending');
    // [Issue #947] Delegate sending so timer sends take the exact same path as
    // manual sends: per-tool text/Enter separation and waits. The previous direct
    // sendKeys(sessionName, message, true) batched text+Enter in a single send-keys;
    // codex's TUI never confirmed the input, leaving the message typed but unsent.
    // [Issue #1028] Delegate to sendUserMessage (the same service the send API uses)
    // rather than the low-level cliTool.sendMessage, so timer-fired messages also
    // record the user message in chat_messages and start response polling —
    // otherwise they never appear in Message History.
    const result = await sendUserMessage(db, {
      worktreeId: timer.worktreeId,
      content: timer.message,
      cliToolId: timer.cliToolId as CLIToolType,
      instanceId,
    });

    if (!result.ok) {
      // [Issue #1107] Persist the failure reason so the detail modal can show
      // it (previously logged server-side only).
      const reason = `[${result.stage}] ${result.error}`;
      updateTimerStatus(db, timerId, 'failed', undefined, reason);
      logger.error('timer:send-failed', { timerId, stage: result.stage, error: result.error });
      return;
    }

    updateTimerStatus(db, timerId, 'sent', Date.now());

    logger.info('timer:sent', { timerId, worktreeId: timer.worktreeId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    try {
      // [Issue #1107] Persist the thrown error message as the failure reason.
      updateTimerStatus(db, timerId, 'failed', undefined, msg);
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

  // Issue #540: Cleanup old timers and recover stuck sending timers on startup
  const cleanedUp = cleanupOldTimers(db, TIMER_CLEANUP_RETENTION_DAYS);
  const recovered = recoverStuckSendingTimers(db);
  if (cleanedUp > 0) {
    logger.info('timer-manager:cleanup', { deletedCount: cleanedUp });
  }
  if (recovered > 0) {
    logger.info('timer-manager:recovery', { recoveredCount: recovered });
  }

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
