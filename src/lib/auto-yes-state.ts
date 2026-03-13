/**
 * Auto-Yes State Management - In-memory state for auto-yes mode per worktree.
 *
 * Extracted from auto-yes-manager.ts (Issue #479) to separate state management
 * from polling logic.
 *
 * Dependencies: path-validator.ts, auto-yes-config (one-way dependency).
 * auto-yes-poller.ts -> auto-yes-state.ts -> path-validator.ts
 */

import { DEFAULT_AUTO_YES_DURATION, validateStopPattern, type AutoYesDuration, type AutoYesStopReason } from '@/config/auto-yes-config';
import { isValidWorktreeId } from './security/path-validator';
import { createLogger } from '@/lib/logger';

const logger = createLogger('auto-yes-state');

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
}

/** In-memory storage for auto-yes states (globalThis for hot reload persistence) */
const autoYesStates = globalThis.__autoYesStates ??
  (globalThis.__autoYesStates = new Map<string, AutoYesState>());

// =============================================================================
// Utility Functions
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

// =============================================================================
// Auto-Yes State Management
// =============================================================================

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
 * If matched, disables auto-yes for the worktree.
 *
 * Note: This function disables auto-yes state but does NOT stop polling.
 * The caller (auto-yes-poller.ts) is responsible for stopping polling when
 * this function returns true.
 *
 * Security: Pattern is re-validated before execution to handle cases where
 * a previously valid pattern becomes invalid (e.g., state corruption).
 *
 * @internal Exported for testing purposes only.
 * @param worktreeId - Worktree identifier
 * @param cleanOutput - ANSI-stripped terminal output to check
 * @param onStopMatched - Optional callback invoked when stop condition matches (for poller cleanup)
 * @returns true if stop condition matched and auto-yes was disabled
 */
export function checkStopCondition(
  worktreeId: string,
  cleanOutput: string,
  onStopMatched?: (worktreeId: string) => void
): boolean {
  const autoYesState = getAutoYesState(worktreeId);
  if (!autoYesState?.stopPattern) return false;

  const validation = validateStopPattern(autoYesState.stopPattern);
  if (!validation.valid) {
    logger.warn('invalid-stop-pattern', { detail: String({ worktreeId }) });
    disableAutoYes(worktreeId);
    return false;
  }

  try {
    const regex = new RegExp(autoYesState.stopPattern);
    const matched = executeRegexWithTimeout(regex, cleanOutput);

    if (matched === null) {
      // Execution failed - disable to prevent future errors
      logger.warn('stop-condition-check', { detail: String({ worktreeId }) });
      disableAutoYes(worktreeId);
      return false;
    }

    if (matched) {
      disableAutoYes(worktreeId, 'stop_pattern_matched');
      if (onStopMatched) {
        onStopMatched(worktreeId);
      }
      logger.warn('stop-condition-matched', { detail: String({ worktreeId }) });
      return true;
    }
  } catch {
    logger.warn('stop-condition-check', { detail: String({ worktreeId }) });
  }

  return false;
}

// =============================================================================
// Cleanup Functions (Issue #404: Resource leak prevention)
// =============================================================================

/**
 * Delete the auto-yes state for a worktree.
 * Used during worktree deletion to prevent memory leaks in the autoYesStates Map.
 *
 * [SEC-404-001] Validates worktreeId before deletion.
 *
 * @param worktreeId - Worktree identifier (must pass isValidWorktreeId)
 * @returns true if worktreeId was valid (deletion attempted), false if invalid
 */
export function deleteAutoYesState(worktreeId: string): boolean {
  if (!isValidWorktreeId(worktreeId)) {
    return false;
  }
  autoYesStates.delete(worktreeId);
  return true;
}

/**
 * Get all worktree IDs that have auto-yes state entries.
 * Used by periodic resource cleanup to detect orphaned entries.
 *
 * @internal Exported for resource-cleanup and testing purposes.
 * @returns Array of worktree IDs present in the autoYesStates Map
 */
export function getAutoYesStateWorktreeIds(): string[] {
  return Array.from(autoYesStates.keys());
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
// Constants (shared with auto-yes-poller.ts)
// =============================================================================

/** Polling interval in milliseconds */
export const POLLING_INTERVAL_MS = 2000;

/** Cooldown interval after successful response (milliseconds) (Issue #306) */
export const COOLDOWN_INTERVAL_MS = 5000;

/**
 * Duplicate prompt retry expiry in milliseconds (10 seconds).
 * After sending a response, if the same promptKey persists beyond this window,
 * the poller retries sending instead of permanently skipping as a duplicate.
 * This handles:
 * - Consecutive identical prompts (e.g., repeated "Approve?") where the
 *   5-second cooldown causes the poller to miss the "no prompt" state
 * - Silently failed keystrokes where the prompt remains unchanged
 */
export const DUPLICATE_RETRY_EXPIRY_MS = 10000;

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
