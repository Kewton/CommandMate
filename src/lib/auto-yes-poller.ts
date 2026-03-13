/**
 * Auto-Yes Poller - Server-side polling for auto-yes prompt responses.
 *
 * Extracted from auto-yes-manager.ts (Issue #479) to separate polling logic
 * from state management.
 *
 * Dependencies: auto-yes-state.ts (one-way dependency).
 * auto-yes-poller.ts -> auto-yes-state.ts
 */

import type { CLIToolType } from './cli-tools/types';
import { captureSessionOutput } from './session/cli-session';
import { detectPrompt } from './detection/prompt-detector';
import { resolveAutoAnswer } from './polling/auto-yes-resolver';
import { sendPromptAnswer } from './prompt-answer-sender';
import { CLIToolManager } from './cli-tools/manager';
import { stripAnsi, stripBoxDrawing, detectThinking, buildDetectPromptOptions } from './detection/cli-patterns';
import { generatePromptKey } from './detection/prompt-key';
import { getErrorMessage } from './errors';
import { invalidateCache } from './tmux/tmux-capture-cache';
import { createLogger } from '@/lib/logger';

const logger = createLogger('auto-yes-poller');
import { isValidWorktreeId } from './security/path-validator';
import {
  getAutoYesState,
  isAutoYesExpired,
  checkStopCondition,
  calculateBackoffInterval,
  POLLING_INTERVAL_MS,
  COOLDOWN_INTERVAL_MS,
  DUPLICATE_RETRY_EXPIRY_MS,
  MAX_CONCURRENT_POLLERS,
  THINKING_CHECK_LINE_COUNT,
} from './auto-yes-state';

// =============================================================================
// Poller Types
// =============================================================================

/** Poller state for a worktree (Issue #138) */
export interface AutoYesPollerState {
  /** setTimeout ID */
  timerId: ReturnType<typeof setTimeout> | null;
  /** CLI tool ID being polled */
  cliToolId: CLIToolType;
  /** Consecutive error count */
  consecutiveErrors: number;
  /** Current polling interval (with backoff applied) */
  currentInterval: number;
  /** Last server-side response timestamp */
  lastServerResponseTimestamp: number | null;
  /** Last answered prompt key for duplicate prevention (Issue #306) */
  lastAnsweredPromptKey: string | null;
  /** Timestamp when lastAnsweredPromptKey was set (for retry expiry) */
  lastAnsweredAt: number | null;
  /** Baseline output length for stop condition delta check (Issue #314 fix) */
  stopCheckBaselineLength: number;
}

/** Result of starting a poller */
export interface StartPollingResult {
  /** Whether the poller was started */
  started: boolean;
  /** Reason if not started */
  reason?: string;
}

// =============================================================================
// In-memory State (globalThis for hot reload persistence - Issue #153)
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}

/** In-memory storage for poller states (globalThis for hot reload persistence) */
const autoYesPollerStates = globalThis.__autoYesPollerStates ??
  (globalThis.__autoYesPollerStates = new Map<string, AutoYesPollerState>());

// =============================================================================
// Poller State Accessors
// =============================================================================

/**
 * Get poller state for a worktree.
 * Returns undefined if no poller state exists.
 *
 * Issue #323: Introduced for consistency with getAutoYesState() accessor pattern (DR003).
 *
 * @param worktreeId - Worktree identifier
 * @returns Poller state or undefined
 */
function getPollerState(worktreeId: string): AutoYesPollerState | undefined {
  return autoYesPollerStates.get(worktreeId);
}

/**
 * Get the number of active pollers.
 *
 * @returns Count of currently active polling instances
 */
export function getActivePollerCount(): number {
  return autoYesPollerStates.size;
}

/**
 * Clear all poller states.
 * Stops all active pollers before clearing state.
 * @internal Exported for testing purposes only.
 */
export function clearAllPollerStates(): void {
  stopAllAutoYesPolling();
  autoYesPollerStates.clear();
}

/**
 * Get the last server response timestamp for a worktree.
 * Used by clients to prevent duplicate responses.
 *
 * @param worktreeId - Worktree identifier
 * @returns Timestamp (Date.now()) of the last server response, or null if none
 */
export function getLastServerResponseTimestamp(worktreeId: string): number | null {
  const pollerState = getPollerState(worktreeId);
  return pollerState?.lastServerResponseTimestamp ?? null;
}

/**
 * Update the last server response timestamp.
 *
 * @param worktreeId - Worktree identifier
 * @param timestamp - Timestamp value (Date.now())
 */
function updateLastServerResponseTimestamp(worktreeId: string, timestamp: number): void {
  const pollerState = getPollerState(worktreeId);
  if (pollerState) {
    pollerState.lastServerResponseTimestamp = timestamp;
  }
}

/**
 * Reset error count for a poller and restore the default polling interval.
 *
 * @param worktreeId - Worktree identifier
 */
function resetErrorCount(worktreeId: string): void {
  const pollerState = getPollerState(worktreeId);
  if (pollerState) {
    pollerState.consecutiveErrors = 0;
    pollerState.currentInterval = POLLING_INTERVAL_MS;
  }
}

/**
 * Increment error count and apply backoff if the threshold is exceeded.
 *
 * @param worktreeId - Worktree identifier
 */
function incrementErrorCount(worktreeId: string): void {
  const pollerState = getPollerState(worktreeId);
  if (pollerState) {
    pollerState.consecutiveErrors++;
    pollerState.currentInterval = calculateBackoffInterval(pollerState.consecutiveErrors);
  }
}

/**
 * Check if the given prompt has already been answered recently.
 * Extracted from pollAutoYes() to reduce responsibility concentration (F005/SRP).
 *
 * Returns true only if the prompt key matches AND the response was sent within
 * DUPLICATE_RETRY_EXPIRY_MS. After the expiry window, the same promptKey is
 * retried to handle consecutive identical prompts or failed keystroke sends.
 *
 * @param pollerState - Current poller state containing the last answered prompt key
 * @param promptKey - Composite key of the current prompt (generated by generatePromptKey)
 * @returns true if the prompt key matches and is within the retry expiry window
 */
function isDuplicatePrompt(
  pollerState: AutoYesPollerState,
  promptKey: string
): boolean {
  if (pollerState.lastAnsweredPromptKey !== promptKey) return false;
  if (pollerState.lastAnsweredAt === null) return false;
  return (Date.now() - pollerState.lastAnsweredAt) < DUPLICATE_RETRY_EXPIRY_MS;
}

// =============================================================================
// Extracted Functions for pollAutoYes (Issue #323: SRP decomposition)
// =============================================================================

/**
 * Validate that polling context is still valid.
 * Checks pollerState existence and auto-yes enabled state.
 *
 * @sideeffect When returning 'expired', calls stopAutoYesPolling() to clean up
 * the poller state. This side-effect is intentional - separating the check from
 * the cleanup would risk callers forgetting to call stopAutoYesPolling() (DR002).
 *
 * @internal Exported for testing purposes only.
 * @precondition worktreeId is validated by isValidWorktreeId() in startAutoYesPolling()
 * gateway before being registered in globalThis Map. This function assumes worktreeId
 * has already passed that validation.
 * @param worktreeId - Worktree identifier
 * @param pollerState - Current poller state (or undefined if not found)
 * @returns 'valid' | 'stopped' | 'expired'
 */
export function validatePollingContext(
  worktreeId: string,
  pollerState: AutoYesPollerState | undefined
): 'valid' | 'stopped' | 'expired' {
  if (!pollerState) return 'stopped';

  const autoYesState = getAutoYesState(worktreeId);
  if (!autoYesState?.enabled || isAutoYesExpired(autoYesState)) {
    stopAutoYesPolling(worktreeId);
    return 'expired';
  }

  return 'valid';
}

/**
 * Capture tmux session output and strip ANSI escape codes.
 *
 * @internal Exported for testing purposes only.
 * @precondition worktreeId is validated by isValidWorktreeId() in startAutoYesPolling()
 * gateway before being registered in globalThis Map. This function assumes worktreeId
 * has already passed that validation.
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @returns Cleaned output string (ANSI stripped)
 */
export async function captureAndCleanOutput(
  worktreeId: string,
  cliToolId: CLIToolType
): Promise<string> {
  // 5000 lines: matches the existing pollAutoYes() line limit (IC002).
  // captureSessionOutput() default is 1000 lines, but tmux buffer capture
  // requires 5000 to avoid truncating long outputs.
  const output = await captureSessionOutput(worktreeId, cliToolId, 5000);
  return stripBoxDrawing(stripAnsi(output));
}

/**
 * Process stop condition check using delta-based approach.
 * Manages baseline length, extracts new content, and delegates
 * pattern matching to existing checkStopCondition().
 *
 * Note: This is a higher-level function that internally calls
 * checkStopCondition() from auto-yes-state.ts for regex pattern matching.
 *
 * @internal Exported for testing purposes only.
 * @precondition worktreeId is validated by isValidWorktreeId() in startAutoYesPolling()
 * gateway before being registered in globalThis Map. This function assumes worktreeId
 * has already passed that validation.
 * @param worktreeId - Worktree identifier
 * @param pollerState - Current poller state (mutated: stopCheckBaselineLength updated)
 * @param cleanOutput - ANSI-stripped terminal output
 * @returns true if stop condition matched and auto-yes was disabled
 */
export function processStopConditionDelta(
  worktreeId: string,
  pollerState: AutoYesPollerState,
  cleanOutput: string
): boolean {
  if (pollerState.stopCheckBaselineLength < 0) {
    // First poll: set baseline, skip stop condition check
    pollerState.stopCheckBaselineLength = cleanOutput.length;
    return false;
  }

  const baseline = pollerState.stopCheckBaselineLength;
  if (cleanOutput.length > baseline) {
    // Output grew: check only new content (delta)
    const newContent = cleanOutput.substring(baseline);
    pollerState.stopCheckBaselineLength = cleanOutput.length;
    return checkStopCondition(worktreeId, newContent, stopAutoYesPolling);
  } else if (cleanOutput.length < baseline) {
    // Buffer shrank (old lines dropped from scrollback): reset baseline
    pollerState.stopCheckBaselineLength = cleanOutput.length;
  }
  // If length unchanged: no new content, skip check

  return false;
}

/**
 * Detect prompt in terminal output, resolve auto-answer, and send response.
 * Handles the complete flow: detection -> duplicate check -> answer resolution ->
 * tmux send -> timestamp/error-count update -> promptKey recording.
 *
 * Note: Cooldown scheduling is NOT this function's responsibility.
 * The caller (pollAutoYes() orchestrator) determines scheduling interval
 * based on the return value ('responded' -> cooldown, others -> normal interval).
 *
 * @internal Exported for testing purposes only.
 * @precondition worktreeId is validated by isValidWorktreeId() in startAutoYesPolling()
 * gateway before being registered in globalThis Map. This function assumes worktreeId
 * has already passed that validation.
 * @param worktreeId - Worktree identifier
 * @param pollerState - Current poller state (mutated: lastAnsweredPromptKey updated)
 * @param cliToolId - CLI tool type
 * @param cleanOutput - ANSI-stripped terminal output
 * @returns 'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'
 */
export async function detectAndRespondToPrompt(
  worktreeId: string,
  pollerState: AutoYesPollerState,
  cliToolId: CLIToolType,
  cleanOutput: string
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  try {
    // 1. Detect prompt
    const promptOptions = buildDetectPromptOptions(cliToolId);
    const promptDetection = detectPrompt(stripBoxDrawing(cleanOutput), promptOptions);

    if (!promptDetection.isPrompt || !promptDetection.promptData) {
      // No prompt detected - reset lastAnsweredPromptKey (Issue #306)
      pollerState.lastAnsweredPromptKey = null;
      pollerState.lastAnsweredAt = null;
      return 'no_prompt';
    }

    // 2. Check for duplicate prompt (Issue #306)
    const promptKey = generatePromptKey(promptDetection.promptData);
    if (isDuplicatePrompt(pollerState, promptKey)) {
      return 'duplicate';
    }

    // 3. Resolve auto answer
    const answer = resolveAutoAnswer(promptDetection.promptData);
    if (answer === null) {
      return 'no_answer';
    }

    // 4. Send answer to tmux
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(worktreeId);

    try {
      await sendPromptAnswer({
        sessionName,
        answer,
        cliToolId,
        promptData: promptDetection.promptData,
      });
    } finally {
      // Issue #405: Ensure cache invalidation even if sendPromptAnswer throws
      invalidateCache(sessionName);
    }

    // 5. Update timestamp and reset error count
    updateLastServerResponseTimestamp(worktreeId, Date.now());
    resetErrorCount(worktreeId);

    // 6. Record answered prompt key and timestamp
    pollerState.lastAnsweredPromptKey = promptKey;
    pollerState.lastAnsweredAt = Date.now();

    // Log success (without sensitive content)
    logger.info('poller:response-sent', { worktreeId });

    return 'responded';
  } catch {
    // IC003: This catch handles errors from prompt detection/sending only.
    // incrementErrorCount is called here, and this function never throws,
    // preventing double incrementErrorCount in the outer pollAutoYes() catch.
    incrementErrorCount(worktreeId);
    logger.warn('poller:detect-respond-error', { worktreeId });
    return 'error';
  }
}

/**
 * Internal polling function that recursively schedules itself via setTimeout.
 * Orchestrates the polling flow by delegating to extracted functions.
 *
 * Issue #323: Refactored from ~139 lines to ~30 lines as an orchestrator.
 * Each responsibility is delegated to a focused function:
 * - validatePollingContext(): Pre-condition checks
 * - captureAndCleanOutput(): tmux output capture + ANSI cleanup
 * - processStopConditionDelta(): Stop condition delta-based check
 * - detectAndRespondToPrompt(): Prompt detection + auto-response
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 */
async function pollAutoYes(worktreeId: string, cliToolId: CLIToolType): Promise<void> {
  // 1. Validate context
  const pollerState = getPollerState(worktreeId);
  const contextResult = validatePollingContext(worktreeId, pollerState);
  if (contextResult !== 'valid') return;
  // pollerState is guaranteed non-null after 'valid' check

  try {
    // 2. Capture and clean output
    const cleanOutput = await captureAndCleanOutput(worktreeId, cliToolId);

    // 3. Thinking check (inline - policy decision about window size)
    // Issue #161 Layer 1 / Issue #191: windowing applied to detectThinking()
    const recentLines = cleanOutput.split('\n').slice(-THINKING_CHECK_LINE_COUNT).join('\n');
    if (detectThinking(cliToolId, recentLines)) {
      scheduleNextPoll(worktreeId, cliToolId);
      return;
    }

    // 4. Stop condition delta check (Issue #314)
    if (processStopConditionDelta(worktreeId, pollerState!, cleanOutput)) {
      return;
    }

    // 5. Detect and respond to prompt
    const result = await detectAndRespondToPrompt(worktreeId, pollerState!, cliToolId, cleanOutput);
    if (result === 'responded') {
      // Issue #306: Apply cooldown interval after successful response
      scheduleNextPoll(worktreeId, cliToolId, COOLDOWN_INTERVAL_MS);
      return;
    }
  } catch (error) {
    // IC003: This catch handles captureAndCleanOutput() or processStopConditionDelta()
    // errors only. detectAndRespondToPrompt() catches its own errors and returns
    // 'error' instead of throwing (preventing double incrementErrorCount).
    incrementErrorCount(worktreeId);
    logger.warn('poller:poll-error', { worktreeId, error: getErrorMessage(error) });
  }

  // Schedule next poll (catch block fallthrough or other paths)
  scheduleNextPoll(worktreeId, cliToolId);
}

/**
 * Schedule the next polling iteration
 * @param overrideInterval - Optional interval in milliseconds (S2-F009: type definition).
 *   When provided (e.g., COOLDOWN_INTERVAL_MS), overrides pollerState.currentInterval.
 *   Type: number | undefined (optional parameter).
 */
function scheduleNextPoll(
  worktreeId: string,
  cliToolId: CLIToolType,
  overrideInterval?: number
): void {
  const pollerState = getPollerState(worktreeId);
  if (!pollerState) return;

  // S4-F003: Floor guard - polling interval must not be below POLLING_INTERVAL_MS
  const interval = Math.max(overrideInterval ?? pollerState.currentInterval, POLLING_INTERVAL_MS);
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, interval);
}

// =============================================================================
// Public Poller API
// =============================================================================

/**
 * Start server-side auto-yes polling for a worktree.
 * Validates the worktree ID, checks auto-yes state, enforces concurrent poller limits,
 * and begins the polling loop.
 *
 * @param worktreeId - Worktree identifier (must match WORKTREE_ID_PATTERN)
 * @param cliToolId - CLI tool type to poll for
 * @returns Result indicating whether the poller was started, with reason if not
 */
export function startAutoYesPolling(
  worktreeId: string,
  cliToolId: CLIToolType
): StartPollingResult {
  // Validate worktree ID (security)
  if (!isValidWorktreeId(worktreeId)) {
    return { started: false, reason: 'invalid worktree ID' };
  }

  // Check if auto-yes is enabled
  const autoYesState = getAutoYesState(worktreeId);
  if (!autoYesState?.enabled) {
    return { started: false, reason: 'auto-yes not enabled' };
  }

  // Check concurrent poller limit (DoS protection)
  // If this worktree already has a poller, don't count it toward the limit
  const existingPoller = autoYesPollerStates.has(worktreeId);
  if (!existingPoller && autoYesPollerStates.size >= MAX_CONCURRENT_POLLERS) {
    return { started: false, reason: 'max concurrent pollers reached' };
  }

  // Stop existing poller if any
  if (existingPoller) {
    stopAutoYesPolling(worktreeId);
  }

  // Create new poller state
  const pollerState: AutoYesPollerState = {
    timerId: null,
    cliToolId,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,  // S2-F003: initialized to null
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,  // Issue #314 fix: -1 = first poll (baseline not set)
  };
  autoYesPollerStates.set(worktreeId, pollerState);

  // Start polling immediately
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, POLLING_INTERVAL_MS);

  logger.info('poller:started', { worktreeId, cliToolId });
  return { started: true };
}

/**
 * Stop server-side auto-yes polling for a worktree.
 * Clears the timer and removes the poller state.
 *
 * @param worktreeId - Worktree identifier
 */
export function stopAutoYesPolling(worktreeId: string): void {
  const pollerState = getPollerState(worktreeId);
  if (!pollerState) return;

  // Clear timer
  if (pollerState.timerId) {
    clearTimeout(pollerState.timerId);
  }

  // Remove state
  autoYesPollerStates.delete(worktreeId);
  logger.info('poller:stopped', { worktreeId });
}

/**
 * Stop all server-side auto-yes polling (graceful shutdown).
 * Clears all timers and removes all poller states.
 */
export function stopAllAutoYesPolling(): void {
  for (const [worktreeId, pollerState] of autoYesPollerStates.entries()) {
    if (pollerState.timerId) {
      clearTimeout(pollerState.timerId);
    }
    logger.info('poller:stopped', { worktreeId, reason: 'shutdown' });
  }
  autoYesPollerStates.clear();
}

/**
 * Get all worktree IDs that have active auto-yes poller entries.
 * Used by periodic resource cleanup to detect orphaned entries.
 *
 * @internal Exported for resource-cleanup and testing purposes.
 * @returns Array of worktree IDs present in the autoYesPollerStates Map
 */
export function getAutoYesPollerWorktreeIds(): string[] {
  return Array.from(autoYesPollerStates.keys());
}
