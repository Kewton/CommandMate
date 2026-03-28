/**
 * Auto-Yes Poller - Server-side polling for auto-yes prompt responses.
 *
 * Extracted from auto-yes-manager.ts (Issue #479) to separate polling logic
 * from state management.
 *
 * Issue #525: Composite key migration (worktreeId:cliToolId) for per-agent auto-yes.
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
import {
  THINKING_POLLING_INTERVAL_MS,
  REDUCED_CAPTURE_LINES,
  FULL_CAPTURE_LINES,
  AUTO_STOP_ERROR_THRESHOLD,
} from '@/config/auto-yes-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('auto-yes-poller');
import { isValidWorktreeId } from './security/path-validator';
import {
  buildCompositeKey,
  extractWorktreeId,
  extractCliToolId,
  filterCompositeKeysByWorktree,
  getAutoYesState,
  disableAutoYes,
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

/** Poller state for a worktree/agent (Issue #138, #525) */
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
// Issue #525: Map key changed from worktreeId to compositeKey
// =============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}

/** In-memory storage for poller states (globalThis for hot reload persistence) */
const autoYesPollerStates = globalThis.__autoYesPollerStates ??
  (globalThis.__autoYesPollerStates = new Map<string, AutoYesPollerState>());

// =============================================================================
// Poller State Accessors (compositeKey-based)
// =============================================================================

/**
 * Get poller state by composite key.
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns Poller state or undefined
 */
function getPollerState(compositeKey: string): AutoYesPollerState | undefined {
  return autoYesPollerStates.get(compositeKey);
}

/**
 * Get the number of active pollers.
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
 * Get the last server response timestamp for a composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns Timestamp (Date.now()) of the last server response, or null if none
 */
export function getLastServerResponseTimestamp(compositeKey: string): number | null {
  const pollerState = getPollerState(compositeKey);
  return pollerState?.lastServerResponseTimestamp ?? null;
}

/**
 * Check if a server-side auto-yes poller is active for a composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns true if a poller is actively running
 */
export function isPollerActive(compositeKey: string): boolean {
  return autoYesPollerStates.has(compositeKey);
}

/**
 * Update the last server response timestamp.
 *
 * @param compositeKey - Composite key
 * @param timestamp - Timestamp value (Date.now())
 */
function updateLastServerResponseTimestamp(compositeKey: string, timestamp: number): void {
  const pollerState = getPollerState(compositeKey);
  if (pollerState) {
    pollerState.lastServerResponseTimestamp = timestamp;
  }
}

/**
 * Reset error count for a poller and restore the default polling interval.
 *
 * @param compositeKey - Composite key
 */
function resetErrorCount(compositeKey: string): void {
  const pollerState = getPollerState(compositeKey);
  if (pollerState) {
    pollerState.consecutiveErrors = 0;
    pollerState.currentInterval = POLLING_INTERVAL_MS;
  }
}

/**
 * Increment error count and apply backoff if the threshold is exceeded.
 * [IA-MF-001] compositeKey-based: extracts worktreeId/cliToolId for disableAutoYes.
 *
 * @param compositeKey - Composite key
 */
function incrementErrorCount(compositeKey: string): void {
  const pollerState = getPollerState(compositeKey);
  if (pollerState) {
    pollerState.consecutiveErrors++;
    pollerState.currentInterval = calculateBackoffInterval(pollerState.consecutiveErrors);

    // Issue #499 Item 5: Auto-stop after consecutive error threshold.
    if (pollerState.consecutiveErrors >= AUTO_STOP_ERROR_THRESHOLD) {
      const worktreeId = extractWorktreeId(compositeKey);
      const cliToolId = extractCliToolId(compositeKey);
      if (cliToolId) {
        disableAutoYes(worktreeId, cliToolId, 'consecutive_errors');
      }
      stopAutoYesPolling(compositeKey);
    }
  }
}

/**
 * Check if the given prompt has already been answered recently.
 *
 * @param pollerState - Current poller state
 * @param promptKey - Composite key of the current prompt
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
 * Issue #525: Changed from (worktreeId, pollerState) to (compositeKey, pollerState).
 *
 * @internal Exported for testing purposes only.
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @param pollerState - Current poller state (or undefined if not found)
 * @returns 'valid' | 'stopped' | 'expired'
 */
export function validatePollingContext(
  compositeKey: string,
  pollerState: AutoYesPollerState | undefined
): 'valid' | 'stopped' | 'expired' {
  if (!pollerState) return 'stopped';

  const worktreeId = extractWorktreeId(compositeKey);
  const cliToolId = extractCliToolId(compositeKey);
  if (!cliToolId) {
    stopAutoYesPolling(compositeKey);
    return 'expired';
  }

  const autoYesState = getAutoYesState(worktreeId, cliToolId);
  if (!autoYesState?.enabled) {
    stopAutoYesPolling(compositeKey);
    return 'expired';
  }

  return 'valid';
}

/**
 * Capture tmux session output and strip ANSI escape codes.
 *
 * @internal Exported for testing purposes only.
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 * @returns Cleaned output string (ANSI stripped)
 */
export async function captureAndCleanOutput(
  worktreeId: string,
  cliToolId: CLIToolType,
  captureLines?: number
): Promise<string> {
  const lines = captureLines ?? FULL_CAPTURE_LINES;
  const output = await captureSessionOutput(worktreeId, cliToolId, lines);
  return stripBoxDrawing(stripAnsi(output));
}

/**
 * Process stop condition check using delta-based approach.
 *
 * Issue #525: Changed from (worktreeId, ...) to (compositeKey, ...).
 *
 * @internal Exported for testing purposes only.
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @param pollerState - Current poller state (mutated: stopCheckBaselineLength updated)
 * @param cleanOutput - ANSI-stripped terminal output
 * @returns true if stop condition matched and auto-yes was disabled
 */
export function processStopConditionDelta(
  compositeKey: string,
  pollerState: AutoYesPollerState,
  cleanOutput: string
): boolean {
  if (pollerState.stopCheckBaselineLength < 0) {
    pollerState.stopCheckBaselineLength = cleanOutput.length;
    return false;
  }

  const baseline = pollerState.stopCheckBaselineLength;
  if (cleanOutput.length > baseline) {
    const newContent = cleanOutput.substring(baseline);
    pollerState.stopCheckBaselineLength = cleanOutput.length;
    return checkStopCondition(compositeKey, newContent, stopAutoYesPolling);
  } else if (cleanOutput.length < baseline) {
    pollerState.stopCheckBaselineLength = cleanOutput.length;
  }

  return false;
}

/**
 * Detect prompt in terminal output, resolve auto-answer, and send response.
 *
 * @internal Exported for testing purposes only.
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
  cleanOutput: string,
  precomputedLines?: string[]
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId);
  try {
    // 1. Detect prompt
    const promptOptions = buildDetectPromptOptions(cliToolId);
    const promptDetection = detectPrompt(cleanOutput, {
      ...promptOptions,
      ...(precomputedLines && { precomputedLines }),
    });

    if (!promptDetection.isPrompt || !promptDetection.promptData) {
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
      invalidateCache(sessionName);
    }

    // 5. Update timestamp and reset error count
    updateLastServerResponseTimestamp(compositeKey, Date.now());
    resetErrorCount(compositeKey);

    // 6. Record answered prompt key and timestamp
    pollerState.lastAnsweredPromptKey = promptKey;
    pollerState.lastAnsweredAt = Date.now();

    logger.info('poller:response-sent', { worktreeId, cliToolId });

    return 'responded';
  } catch {
    incrementErrorCount(compositeKey);
    logger.warn('poller:detect-respond-error', { worktreeId, cliToolId });
    return 'error';
  }
}

/**
 * Internal polling function that recursively schedules itself via setTimeout.
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type being polled
 */
async function pollAutoYes(worktreeId: string, cliToolId: CLIToolType): Promise<void> {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId);

  // 1. Validate context
  const pollerState = getPollerState(compositeKey);
  const contextResult = validatePollingContext(compositeKey, pollerState);
  if (contextResult !== 'valid') {
    return;
  }

  try {
    // 2. Capture and clean output
    const autoYesState = getAutoYesState(worktreeId, cliToolId);
    const captureLines = autoYesState?.stopPattern
      ? FULL_CAPTURE_LINES
      : REDUCED_CAPTURE_LINES;
    const cleanOutput = await captureAndCleanOutput(worktreeId, cliToolId, captureLines);

    const lines = cleanOutput.split('\n');

    // 3. Stop condition delta check (Issue #314)
    if (processStopConditionDelta(compositeKey, pollerState!, cleanOutput)) {
      return;
    }

    // 4. Detect and respond to prompt
    const result = await detectAndRespondToPrompt(worktreeId, pollerState!, cliToolId, cleanOutput, lines);
    if (result === 'responded') {
      scheduleNextPoll(worktreeId, cliToolId, COOLDOWN_INTERVAL_MS);
      return;
    }

    // 5. Thinking check
    if (result === 'no_prompt') {
      const recentLines = lines.slice(-THINKING_CHECK_LINE_COUNT).join('\n');
      if (detectThinking(cliToolId, recentLines)) {
        scheduleNextPoll(worktreeId, cliToolId, THINKING_POLLING_INTERVAL_MS);
        return;
      }
    }
  } catch (error) {
    incrementErrorCount(compositeKey);
    logger.warn('poller:poll-error', { worktreeId, cliToolId, error: getErrorMessage(error) });
  }

  scheduleNextPoll(worktreeId, cliToolId);
}

/**
 * Schedule the next polling iteration
 */
function scheduleNextPoll(
  worktreeId: string,
  cliToolId: CLIToolType,
  overrideInterval?: number
): void {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId);
  const pollerState = getPollerState(compositeKey);
  if (!pollerState) return;

  const interval = Math.max(overrideInterval ?? pollerState.currentInterval, POLLING_INTERVAL_MS);
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, interval);
}

// =============================================================================
// Public Poller API
// =============================================================================

/**
 * Start server-side auto-yes polling for a worktree/agent.
 *
 * @param worktreeId - Worktree identifier (must match WORKTREE_ID_PATTERN)
 * @param cliToolId - CLI tool type to poll for
 * @returns Result indicating whether the poller was started
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
  const autoYesState = getAutoYesState(worktreeId, cliToolId);
  if (!autoYesState?.enabled) {
    return { started: false, reason: 'auto-yes not enabled' };
  }

  const compositeKey = buildCompositeKey(worktreeId, cliToolId);

  // Check concurrent poller limit (DoS protection)
  const existingPollerState = getPollerState(compositeKey);
  if (!existingPollerState && autoYesPollerStates.size >= MAX_CONCURRENT_POLLERS) {
    return { started: false, reason: 'max concurrent pollers reached' };
  }

  // Issue #501: Idempotency check
  if (existingPollerState && existingPollerState.cliToolId === cliToolId) {
    return { started: true, reason: 'already_running' };
  }

  // Stop existing poller if cliToolId changed
  if (existingPollerState) {
    stopAutoYesPolling(compositeKey);
  }

  // Create new poller state
  const pollerState: AutoYesPollerState = {
    timerId: null,
    cliToolId,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
  autoYesPollerStates.set(compositeKey, pollerState);

  // Start polling immediately
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, POLLING_INTERVAL_MS);

  logger.info('poller:started', { worktreeId, cliToolId });
  return { started: true };
}

/**
 * Stop server-side auto-yes polling by composite key.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 */
export function stopAutoYesPolling(compositeKey: string): void {
  const pollerState = getPollerState(compositeKey);
  if (!pollerState) return;

  if (pollerState.timerId) {
    clearTimeout(pollerState.timerId);
  }

  autoYesPollerStates.delete(compositeKey);
  logger.info('poller:stopped', { compositeKey });
}

/**
 * Stop all server-side auto-yes polling (graceful shutdown).
 */
export function stopAllAutoYesPolling(): void {
  for (const [key, pollerState] of autoYesPollerStates.entries()) {
    if (pollerState.timerId) {
      clearTimeout(pollerState.timerId);
    }
    logger.info('poller:stopped', { compositeKey: key, reason: 'shutdown' });
  }
  autoYesPollerStates.clear();
}

/**
 * Get all composite keys that have active auto-yes poller entries.
 *
 * Issue #525: Returns composite keys (worktreeId:cliToolId).
 *
 * @returns Array of composite keys present in the autoYesPollerStates Map
 */
export function getAutoYesPollerCompositeKeys(): string[] {
  return Array.from(autoYesPollerStates.keys());
}


// =============================================================================
// byWorktree Helpers (Issue #525)
// =============================================================================

/**
 * Stop all auto-yes polling for a given worktreeId (all agents).
 * [SF-001] Uses shared filterCompositeKeysByWorktree (DRY).
 *
 * @param worktreeId - Worktree identifier
 */
export function stopAutoYesPollingByWorktree(worktreeId: string): void {
  const pollerKeys = filterCompositeKeysByWorktree(
    Array.from(autoYesPollerStates.keys()),
    worktreeId
  );
  pollerKeys.forEach(key => stopAutoYesPolling(key));
}

/**
 * Check if any auto-yes poller is active for a given worktreeId.
 * Uses shared filterCompositeKeysByWorktree (DRY).
 *
 * @param worktreeId - Worktree identifier
 * @returns true if any poller is active for this worktree
 */
export function isAnyPollerActiveForWorktree(worktreeId: string): boolean {
  return filterCompositeKeysByWorktree(
    Array.from(autoYesPollerStates.keys()),
    worktreeId
  ).length > 0;
}
