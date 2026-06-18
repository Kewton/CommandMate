/**
 * Auto-Yes State Management - In-memory state for auto-yes mode per worktree/agent.
 *
 * Extracted from auto-yes-manager.ts (Issue #479) to separate state management
 * from polling logic.
 *
 * Issue #525: Composite key migration (worktreeId:cliToolId) for per-agent auto-yes.
 *
 * Dependencies: path-validator.ts, auto-yes-config, cli-tools/types (one-way dependency).
 * auto-yes-poller.ts -> auto-yes-state.ts -> path-validator.ts
 */

import { DEFAULT_AUTO_YES_DURATION, validateStopPattern, type AutoYesDuration, type AutoYesStopReason } from '@/config/auto-yes-config';
import { isValidWorktreeId } from './security/path-validator';
import { isCliToolType, type CLIToolType } from './cli-tools/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('auto-yes-state');

// =============================================================================
// Composite Key Helpers (Issue #525: per-agent auto-yes)
// =============================================================================

/** [SF-002] Separator for composite key: "worktreeId:cliToolId" */
export const COMPOSITE_KEY_SEPARATOR = ':' as const;

/**
 * Build a composite key from worktreeId, cliToolId and (optionally) instanceId.
 *
 * Issue #896: per-instance auto-yes. A single worktree can run multiple instances
 * of the same CLI tool (e.g. "claude" + "claude-2"). Each instance must have its
 * own independent auto-yes state + poller.
 *
 * Key shape is backward-compatible:
 * - Primary instance (instanceId omitted or === cliToolId): 2-part "worktreeId:cliToolId"
 *   (unchanged from Issue #525, so existing state/tests are unaffected).
 * - Alias instance (instanceId !== cliToolId): 3-part "worktreeId:cliToolId:instanceId".
 *
 * @precondition worktreeId / instanceId must not contain COMPOSITE_KEY_SEPARATOR (':').
 *   Guaranteed by isValidWorktreeId() / isValidInstanceId() which restrict to
 *   alphanumeric + hyphens + underscores. If those allowed characters change,
 *   this function must be reviewed.
 *
 * [SEC4-SF-004] Defensive assertion: throws if worktreeId/instanceId contains separator.
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type
 * @param instanceId - Optional instance identifier (defaults to the primary, i.e. cliToolId)
 * @returns Composite key string
 */
export function buildCompositeKey(worktreeId: string, cliToolId: CLIToolType, instanceId?: string): string {
  if (worktreeId.includes(COMPOSITE_KEY_SEPARATOR)) {
    throw new Error(`worktreeId must not contain '${COMPOSITE_KEY_SEPARATOR}': ${worktreeId}`);
  }
  // Primary instance keeps the 2-part key for backward compatibility.
  if (!instanceId || instanceId === cliToolId) {
    return `${worktreeId}${COMPOSITE_KEY_SEPARATOR}${cliToolId}`;
  }
  if (instanceId.includes(COMPOSITE_KEY_SEPARATOR)) {
    throw new Error(`instanceId must not contain '${COMPOSITE_KEY_SEPARATOR}': ${instanceId}`);
  }
  return `${worktreeId}${COMPOSITE_KEY_SEPARATOR}${cliToolId}${COMPOSITE_KEY_SEPARATOR}${instanceId}`;
}

/**
 * Extract worktreeId from a composite key.
 * worktreeId never contains a colon, so it is always the first segment.
 *
 * @param compositeKey - Composite key string
 * @returns worktreeId portion, or the full string if no separator found
 */
export function extractWorktreeId(compositeKey: string): string {
  const firstIndex = compositeKey.indexOf(COMPOSITE_KEY_SEPARATOR);
  return firstIndex === -1 ? compositeKey : compositeKey.substring(0, firstIndex);
}

/**
 * Extract cliToolId from a composite key.
 * cliToolId is always the second segment (it never contains a colon).
 * Validates the extracted value against known CLI tool IDs.
 *
 * @param compositeKey - Composite key string
 * @returns CLIToolType if valid, null otherwise
 */
export function extractCliToolId(compositeKey: string): CLIToolType | null {
  const cliToolId = compositeKey.split(COMPOSITE_KEY_SEPARATOR)[1];
  if (cliToolId === undefined) return null;
  return isCliToolType(cliToolId) ? cliToolId : null;
}

/**
 * Extract instanceId from a composite key (Issue #896).
 * - 3-part key "wt:cli:instance" -> "instance" (alias instance)
 * - 2-part key "wt:cli"          -> "cli"      (primary instance id === cliToolId)
 *
 * @param compositeKey - Composite key string
 * @returns instanceId portion, or null if the key has no cliToolId segment
 */
export function extractInstanceId(compositeKey: string): string | null {
  const parts = compositeKey.split(COMPOSITE_KEY_SEPARATOR);
  // parts[2] = alias instanceId; fall back to parts[1] (cliToolId) for primary keys.
  return parts[2] ?? parts[1] ?? null;
}

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
 * Issue #525: Map key changed from worktreeId to compositeKey (worktreeId:cliToolId).
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
// Auto-Yes State Management (Issue #525: compositeKey-based)
// =============================================================================

/**
 * Get the auto-yes state for a worktree and CLI tool.
 * Returns null if no state exists. If expired, auto-disables and returns the disabled state.
 *
 * Issue #525: Changed from (worktreeId) to (worktreeId, cliToolId).
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type (default: 'claude')
 * @param instanceId - Optional instance identifier (Issue #896; defaults to primary)
 * @returns Current auto-yes state, or null if no state exists
 */
export function getAutoYesState(
  worktreeId: string,
  cliToolId: CLIToolType = 'claude',
  instanceId?: string
): AutoYesState | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const state = autoYesStates.get(key);
  if (!state) return null;

  // Auto-disable if expired (Issue #314: delegate to disableAutoYes)
  if (isAutoYesExpired(state)) {
    return disableAutoYes(worktreeId, cliToolId, 'expired', instanceId);
  }

  return state;
}

/**
 * Set the auto-yes enabled state for a worktree and CLI tool.
 *
 * Issue #525: Changed from (worktreeId, enabled, duration?, stopPattern?) to
 * (worktreeId, cliToolId, enabled, duration?, stopPattern?).
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type
 * @param enabled - Whether to enable or disable auto-yes
 * @param duration - Optional duration in milliseconds (must be an ALLOWED_DURATIONS value).
 *                   Defaults to DEFAULT_AUTO_YES_DURATION (1 hour) when omitted.
 * @param stopPattern - Optional regex pattern for stop condition (Issue #314).
 * @param instanceId - Optional instance identifier (Issue #896; defaults to primary).
 */
export function setAutoYesEnabled(
  worktreeId: string,
  cliToolId: CLIToolType,
  enabled: boolean,
  duration?: AutoYesDuration,
  stopPattern?: string,
  instanceId?: string
): AutoYesState {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  if (enabled) {
    const now = Date.now();
    const effectiveDuration = duration ?? DEFAULT_AUTO_YES_DURATION;
    const state: AutoYesState = {
      enabled: true,
      enabledAt: now,
      expiresAt: now + effectiveDuration,
      stopPattern,
    };
    autoYesStates.set(key, state);
    return state;
  } else {
    // Issue #314: Delegate disable path to disableAutoYes()
    return disableAutoYes(worktreeId, cliToolId, undefined, instanceId);
  }
}

/**
 * Disable auto-yes for a worktree and CLI tool with an optional reason.
 * Preserves existing state fields (enabledAt, expiresAt, stopPattern) for inspection.
 *
 * Issue #314: Centralized disable logic for expiration, stop pattern match, and manual disable.
 * Issue #525: Changed from (worktreeId, reason?) to (worktreeId, cliToolId, reason?).
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type (default: 'claude')
 * @param reason - Optional reason for disabling ('expired' | 'stop_pattern_matched')
 * @param instanceId - Optional instance identifier (Issue #896; defaults to primary)
 * @returns Updated auto-yes state
 */
export function disableAutoYes(
  worktreeId: string,
  cliToolId: CLIToolType = 'claude',
  reason?: AutoYesStopReason,
  instanceId?: string
): AutoYesState {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const existing = autoYesStates.get(key);
  const state: AutoYesState = {
    enabled: false,
    enabledAt: existing?.enabledAt ?? 0,
    expiresAt: existing?.expiresAt ?? 0,
    stopPattern: existing?.stopPattern,
    stopReason: reason,
  };
  autoYesStates.set(key, state);
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
 * @internal Exported for testing purposes only.
 * @param regex - Pre-compiled RegExp to test
 * @param text - Text to test against
 * @param _timeoutMs - Reserved for future timeout implementation (default: 100ms)
 * @returns true/false for match result, null if execution failed
 */
export function executeRegexWithTimeout(
  regex: RegExp,
  text: string,
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
 * If matched, disables auto-yes for the worktree/agent.
 *
 * Issue #525: Changed from (worktreeId, ...) to (compositeKey, ...).
 * [MF-001] compositeKey is validated by extracting worktreeId and cliToolId.
 *
 * @internal Exported for testing purposes only.
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @param cleanOutput - ANSI-stripped terminal output to check
 * @param onStopMatched - Optional callback invoked with compositeKey when stop condition matches
 * @returns true if stop condition matched and auto-yes was disabled
 */
export function checkStopCondition(
  compositeKey: string,
  cleanOutput: string,
  onStopMatched?: (compositeKey: string) => void
): boolean {
  const worktreeId = extractWorktreeId(compositeKey);
  const cliToolId = extractCliToolId(compositeKey);
  if (!cliToolId) return false;
  // Issue #896: alias instances carry a 3-part key; resolve their instanceId so
  // the stop-condition disable targets the correct instance state.
  const instanceId = extractInstanceId(compositeKey) ?? undefined;

  const autoYesState = getAutoYesState(worktreeId, cliToolId, instanceId);
  if (!autoYesState?.stopPattern) return false;

  const validation = validateStopPattern(autoYesState.stopPattern);
  if (!validation.valid) {
    logger.warn('invalid-stop-pattern', { detail: String({ compositeKey }) });
    disableAutoYes(worktreeId, cliToolId, undefined, instanceId);
    return false;
  }

  try {
    const regex = new RegExp(autoYesState.stopPattern);
    const matched = executeRegexWithTimeout(regex, cleanOutput);

    if (matched === null) {
      // Execution failed - disable to prevent future errors
      logger.warn('stop-condition-check', { detail: String({ compositeKey }) });
      disableAutoYes(worktreeId, cliToolId, undefined, instanceId);
      return false;
    }

    if (matched) {
      disableAutoYes(worktreeId, cliToolId, 'stop_pattern_matched', instanceId);
      if (onStopMatched) {
        onStopMatched(compositeKey);
      }
      logger.warn('stop-condition-matched', { detail: String({ compositeKey }) });
      return true;
    }
  } catch {
    logger.warn('stop-condition-check', { detail: String({ compositeKey }) });
  }

  return false;
}

// =============================================================================
// Cleanup Functions (Issue #404: Resource leak prevention)
// =============================================================================

/**
 * Delete the auto-yes state by composite key.
 * Used during worktree deletion to prevent memory leaks in the autoYesStates Map.
 *
 * Issue #525: Changed from (worktreeId) to (compositeKey).
 * [MF-001] Validates compositeKey by extracting and checking worktreeId and cliToolId.
 *
 * @param compositeKey - Composite key (worktreeId:cliToolId)
 * @returns true if compositeKey was valid (deletion attempted), false if invalid
 */
export function deleteAutoYesState(compositeKey: string): boolean {
  const worktreeId = extractWorktreeId(compositeKey);
  if (!isValidWorktreeId(worktreeId)) {
    return false;
  }
  const cliToolId = extractCliToolId(compositeKey);
  if (!cliToolId) {
    return false;
  }
  autoYesStates.delete(compositeKey);
  return true;
}

/**
 * Get all composite keys that have auto-yes state entries.
 * Used by periodic resource cleanup to detect orphaned entries.
 *
 * Issue #525: Returns composite keys (worktreeId:cliToolId).
 *
 * @internal Exported for resource-cleanup and testing purposes.
 * @returns Array of composite keys present in the autoYesStates Map
 */
export function getAutoYesStateCompositeKeys(): string[] {
  return Array.from(autoYesStates.keys());
}


// =============================================================================
// byWorktree Helpers (Issue #525)
// =============================================================================

/**
 * Filter an array of composite keys to those belonging to a given worktreeId.
 * Shared utility to avoid duplicating the extractWorktreeId filter pattern (DRY).
 *
 * @param compositeKeys - Array of composite keys to filter
 * @param worktreeId - Worktree identifier to match
 * @returns Filtered array of composite keys belonging to this worktree
 */
export function filterCompositeKeysByWorktree(compositeKeys: string[], worktreeId: string): string[] {
  return compositeKeys.filter(key => extractWorktreeId(key) === worktreeId);
}

/**
 * Get all composite keys for a given worktreeId.
 *
 * @param worktreeId - Worktree identifier
 * @returns Array of composite keys belonging to this worktree
 */
export function getCompositeKeysByWorktree(worktreeId: string): string[] {
  return filterCompositeKeysByWorktree(Array.from(autoYesStates.keys()), worktreeId);
}

/**
 * Delete all auto-yes states for a given worktreeId (all agents).
 *
 * @param worktreeId - Worktree identifier
 * @returns Number of states deleted
 */
export function deleteAutoYesStateByWorktree(worktreeId: string): number {
  const keys = getCompositeKeysByWorktree(worktreeId);
  keys.forEach(key => autoYesStates.delete(key));
  return keys.length;
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
 */
export const THINKING_CHECK_LINE_COUNT = 50;
