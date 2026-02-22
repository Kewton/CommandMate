/**
 * Auto Yes Manager - Server-side in-memory state management
 *
 * Manages auto-yes mode per worktree using an in-memory Map.
 * State is automatically cleared on server restart.
 *
 * Issue #138: Added server-side polling functionality to handle
 * auto-yes responses when browser tabs are in background.
 */

import type { CLIToolType } from './cli-tools/types';
import { captureSessionOutput } from './cli-session';
import { detectPrompt } from './prompt-detector';
import { resolveAutoAnswer } from './auto-yes-resolver';
import { sendPromptAnswer } from './prompt-answer-sender';
import { CLIToolManager } from './cli-tools/manager';
import { stripAnsi, detectThinking, buildDetectPromptOptions } from './cli-patterns';
import { DEFAULT_AUTO_YES_DURATION, validateStopPattern, type AutoYesDuration, type AutoYesStopReason } from '@/config/auto-yes-config';
import { generatePromptKey } from './prompt-key';

// Re-export from shared config for backward compatibility (Issue #314)
export type { AutoYesStopReason } from '@/config/auto-yes-config';

/** Auto yes state for a worktree */
export interface AutoYesState {
  /** Whether auto-yes is enabled */
  enabled: boolean;
  /** Timestamp when auto-yes was enabled (Date.now()) */
  enabledAt: number;
  /** Timestamp when auto-yes expires (enabledAt + selected duration) */
  expiresAt: number;
  /** Optional regex pattern for stop condition (Issue #314) */
  stopPattern?: string;
  /** Reason why auto-yes was stopped (Issue #314) */
  stopReason?: AutoYesStopReason;
}

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
// Constants (Issue #138)
// =============================================================================

/** Polling interval in milliseconds */
export const POLLING_INTERVAL_MS = 2000;

/** Cooldown interval after successful response (milliseconds) (Issue #306) */
export const COOLDOWN_INTERVAL_MS = 5000;

/** Maximum backoff interval in milliseconds (60 seconds) */
export const MAX_BACKOFF_MS = 60000;

/** Number of consecutive errors before applying backoff */
export const MAX_CONSECUTIVE_ERRORS = 5;

/** Maximum concurrent pollers (DoS protection) */
export const MAX_CONCURRENT_POLLERS = 50;

/**
 * Number of lines from the end to check for thinking indicators (Issue #191)
 * Matches detectPrompt()'s multiple_choice scan range (50 lines in prompt-detector.ts)
 * to ensure Issue #161 Layer 1 defense covers the same scope as prompt detection.
 *
 * IMPORTANT: This value is semantically coupled to the hardcoded 50 in
 * prompt-detector.ts detectMultipleChoicePrompt() (L268: Math.max(0, lines.length - 50)).
 * See SF-001 in Stage 1 review. A cross-reference test validates this coupling.
 */
export const THINKING_CHECK_LINE_COUNT = 50;

/** Worktree ID validation pattern (security: prevent command injection) */
const WORKTREE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Extract error message from unknown error type.
 * Provides consistent error message extraction across the module (DRY).
 *
 * @param error - Unknown error object
 * @returns Error message string, or 'Unknown error' for non-Error values
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

// =============================================================================
// In-memory State (globalThis for hot reload persistence - Issue #153)
// =============================================================================

/**
 * globalThis pattern for hot reload persistence (Issue #153)
 *
 * Problem: Next.js hot reload or worker restart resets module-scoped variables,
 * causing UI and background state inconsistency.
 *
 * Solution: Use globalThis to persist state. globalThis is unique per process
 * and persists even when modules are reloaded.
 *
 * Limitation: In multi-process environments (cluster mode, etc.), each process
 * has its own state. CommandMate is designed for single-process operation,
 * so this limitation is acceptable.
 */
declare global {
  // eslint-disable-next-line no-var
  var __autoYesStates: Map<string, AutoYesState> | undefined;
  // eslint-disable-next-line no-var
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}

/** In-memory storage for auto-yes states (globalThis for hot reload persistence) */
const autoYesStates = globalThis.__autoYesStates ??
  (globalThis.__autoYesStates = new Map<string, AutoYesState>());

/** In-memory storage for poller states (globalThis for hot reload persistence) */
const autoYesPollerStates = globalThis.__autoYesPollerStates ??
  (globalThis.__autoYesPollerStates = new Map<string, AutoYesPollerState>());

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Validate worktree ID format (security measure).
 * Only allows alphanumeric characters, hyphens, and underscores.
 *
 * @param worktreeId - Worktree ID to validate
 * @returns true if the ID matches the allowed pattern
 */
export function isValidWorktreeId(worktreeId: string): boolean {
  if (!worktreeId || worktreeId.length === 0) return false;
  return WORKTREE_ID_PATTERN.test(worktreeId);
}

/**
 * Calculate backoff interval based on consecutive errors.
 * Returns the normal polling interval when errors are below the threshold,
 * and applies exponential backoff (capped at MAX_BACKOFF_MS) above it.
 *
 * @param consecutiveErrors - Number of consecutive errors encountered
 * @returns Polling interval in milliseconds
 */
export function calculateBackoffInterval(consecutiveErrors: number): number {
  if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
    return POLLING_INTERVAL_MS;
  }

  // Exponential backoff: 2^(errors - 4) * 2000
  // 5 errors: 2^1 * 2000 = 4000
  // 6 errors: 2^2 * 2000 = 8000
  // etc.
  const backoffMultiplier = Math.pow(2, consecutiveErrors - MAX_CONSECUTIVE_ERRORS + 1);
  const backoffMs = POLLING_INTERVAL_MS * backoffMultiplier;
  return Math.min(backoffMs, MAX_BACKOFF_MS);
}

// =============================================================================
// Auto-Yes State Management (Existing)
// =============================================================================

/**
 * Check if an auto-yes state has expired.
 * Compares current time against the expiresAt timestamp.
 *
 * @param state - Auto-yes state to check
 * @returns true if the current time is past the expiration time
 */
export function isAutoYesExpired(state: AutoYesState): boolean {
  return Date.now() > state.expiresAt;
}

/**
 * Get the auto-yes state for a worktree.
 * Returns null if no state exists. If expired, auto-disables and returns the disabled state.
 *
 * @param worktreeId - Worktree identifier
 * @returns Current auto-yes state, or null if no state exists
 */
export function getAutoYesState(worktreeId: string): AutoYesState | null {
  const state = autoYesStates.get(worktreeId);
  if (!state) return null;

  // Auto-disable if expired (Issue #314: delegate to disableAutoYes)
  if (isAutoYesExpired(state)) {
    return disableAutoYes(worktreeId, 'expired');
  }

  return state;
}

/**
 * Set the auto-yes enabled state for a worktree
 * @param duration - Optional duration in milliseconds (must be an ALLOWED_DURATIONS value).
 *                   Defaults to DEFAULT_AUTO_YES_DURATION (1 hour) when omitted.
 * @param stopPattern - Optional regex pattern for stop condition (Issue #314).
 *                      When terminal output matches this pattern, auto-yes is automatically disabled.
 */
export function setAutoYesEnabled(
  worktreeId: string,
  enabled: boolean,
  duration?: AutoYesDuration,
  stopPattern?: string
): AutoYesState {
  if (enabled) {
    const now = Date.now();
    const effectiveDuration = duration ?? DEFAULT_AUTO_YES_DURATION;
    const state: AutoYesState = {
      enabled: true,
      enabledAt: now,
      expiresAt: now + effectiveDuration,
      stopPattern,
    };
    autoYesStates.set(worktreeId, state);
    return state;
  } else {
    // Issue #314: Delegate disable path to disableAutoYes()
    return disableAutoYes(worktreeId);
  }
}

/**
 * Disable auto-yes for a worktree with an optional reason.
 * Preserves existing state fields (enabledAt, expiresAt, stopPattern) for inspection.
 *
 * Issue #314: Centralized disable logic for expiration, stop pattern match, and manual disable.
 *
 * @param worktreeId - Worktree identifier
 * @param reason - Optional reason for disabling ('expired' | 'stop_pattern_matched')
 * @returns Updated auto-yes state
 */
export function disableAutoYes(
  worktreeId: string,
  reason?: AutoYesStopReason
): AutoYesState {
  const existing = autoYesStates.get(worktreeId);
  const state: AutoYesState = {
    enabled: false,
    enabledAt: existing?.enabledAt ?? 0,
    expiresAt: existing?.expiresAt ?? 0,
    stopPattern: existing?.stopPattern,
    stopReason: reason,
  };
  autoYesStates.set(worktreeId, state);
  return state;
}

/**
 * Clear all auto-yes states.
 * @internal Exported for testing purposes only.
 */
export function clearAllAutoYesStates(): void {
  autoYesStates.clear();
}

// =============================================================================
// Server-side Polling (Issue #138)
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
 * Check if the given prompt has already been answered.
 * Extracted from pollAutoYes() to reduce responsibility concentration (F005/SRP).
 *
 * @param pollerState - Current poller state containing the last answered prompt key
 * @param promptKey - Composite key of the current prompt (generated by generatePromptKey)
 * @returns true if the prompt key matches the last answered prompt key
 */
function isDuplicatePrompt(
  pollerState: AutoYesPollerState,
  promptKey: string
): boolean {
  return pollerState.lastAnsweredPromptKey === promptKey;
}

// =============================================================================
// Stop Condition (Issue #314)
// =============================================================================

/**
 * Execute a regex test with timeout protection.
 * Uses synchronous execution with safe-regex2 pre-validation as the primary defense.
 *
 * Note: Node.js is single-threaded, so true async timeout requires Worker threads.
 * The safe-regex2 pre-validation in validateStopPattern() prevents catastrophic
 * backtracking patterns from reaching this function. The timeoutMs parameter is
 * reserved for future Worker thread implementation.
 *
 * @internal Exported for testing purposes only.
 * @param regex - Pre-compiled RegExp to test
 * @param text - Text to test against
 * @param _timeoutMs - Reserved for future timeout implementation (default: 100ms)
 * @returns true/false for match result, null if execution failed
 */
export function executeRegexWithTimeout(
  regex: RegExp,
  text: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _timeoutMs: number = 100
): boolean | null {
  try {
    return regex.test(text);
  } catch {
    return null;
  }
}

/**
 * Check if the terminal output matches the stop condition pattern.
 * If matched, disables auto-yes and stops polling for the worktree.
 *
 * Security: Pattern is re-validated before execution to handle cases where
 * a previously valid pattern becomes invalid (e.g., state corruption).
 *
 * @internal Exported for testing purposes only.
 * @param worktreeId - Worktree identifier
 * @param cleanOutput - ANSI-stripped terminal output to check
 * @returns true if stop condition matched and auto-yes was disabled
 */
export function checkStopCondition(worktreeId: string, cleanOutput: string): boolean {
  const autoYesState = getAutoYesState(worktreeId);
  if (!autoYesState?.stopPattern) return false;

  const validation = validateStopPattern(autoYesState.stopPattern);
  if (!validation.valid) {
    console.warn('[Auto-Yes] Invalid stop pattern, disabling', { worktreeId });
    disableAutoYes(worktreeId);
    return false;
  }

  try {
    const regex = new RegExp(autoYesState.stopPattern);
    const matched = executeRegexWithTimeout(regex, cleanOutput);

    if (matched === null) {
      // Execution failed - disable to prevent future errors
      console.warn('[Auto-Yes] Stop condition check failed, disabling pattern', { worktreeId });
      disableAutoYes(worktreeId);
      return false;
    }

    if (matched) {
      disableAutoYes(worktreeId, 'stop_pattern_matched');
      stopAutoYesPolling(worktreeId);
      console.warn('[Auto-Yes] Stop condition matched, auto-yes disabled', { worktreeId });
      return true;
    }
  } catch {
    console.warn('[Auto-Yes] Stop condition check error', { worktreeId });
  }

  return false;
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
  return stripAnsi(output);
}

/**
 * Process stop condition check using delta-based approach.
 * Manages baseline length, extracts new content, and delegates
 * pattern matching to existing checkStopCondition().
 *
 * Note: This is a higher-level function that internally calls
 * checkStopCondition() (L409, Issue #314) for regex pattern matching.
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
    return checkStopCondition(worktreeId, newContent);
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
    const promptDetection = detectPrompt(cleanOutput, promptOptions);

    if (!promptDetection.isPrompt || !promptDetection.promptData) {
      // No prompt detected - reset lastAnsweredPromptKey (Issue #306)
      pollerState.lastAnsweredPromptKey = null;
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

    await sendPromptAnswer({
      sessionName,
      answer,
      cliToolId,
      promptData: promptDetection.promptData,
    });

    // 5. Update timestamp and reset error count
    updateLastServerResponseTimestamp(worktreeId, Date.now());
    resetErrorCount(worktreeId);

    // 6. Record answered prompt key
    pollerState.lastAnsweredPromptKey = promptKey;

    // Log success (without sensitive content)
    console.info(`[Auto-Yes Poller] Sent response for worktree: ${worktreeId}`);

    return 'responded';
  } catch (error) {
    // IC003: This catch handles errors from prompt detection/sending only.
    // incrementErrorCount is called here, and this function never throws,
    // preventing double incrementErrorCount in the outer pollAutoYes() catch.
    incrementErrorCount(worktreeId);
    console.warn(`[Auto-Yes Poller] Error in detectAndRespondToPrompt for worktree ${worktreeId}: ${getErrorMessage(error)}`);
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
    console.warn(`[Auto-Yes Poller] Error for worktree ${worktreeId}: ${getErrorMessage(error)}`);
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
    stopCheckBaselineLength: -1,  // Issue #314 fix: -1 = first poll (baseline not set)
  };
  autoYesPollerStates.set(worktreeId, pollerState);

  // Start polling immediately
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, POLLING_INTERVAL_MS);

  console.info(`[Auto-Yes Poller] Started for worktree: ${worktreeId}, cliTool: ${cliToolId}`);
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
  console.info(`[Auto-Yes Poller] Stopped for worktree: ${worktreeId}`);
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
    console.info(`[Auto-Yes Poller] Stopped for worktree: ${worktreeId} (shutdown)`);
  }
  autoYesPollerStates.clear();
}
