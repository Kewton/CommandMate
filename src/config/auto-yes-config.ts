/**
 * Auto-Yes Configuration Constants
 *
 * Shared config for Auto-Yes duration settings and stop pattern validation.
 * Used by both server (auto-yes-manager.ts, route.ts) and client
 * (AutoYesConfirmDialog.tsx, AutoYesToggle.tsx) components.
 *
 * Issue #225: Duration selection feature
 * Issue #314: Stop condition (regex) validation
 */

import safeRegex from 'safe-regex2';

/** Allowed Auto-Yes durations in milliseconds */
export const ALLOWED_DURATIONS = [3600000, 10800000, 28800000] as const;

/** Auto-Yes duration type (literal union from ALLOWED_DURATIONS) */
export type AutoYesDuration = typeof ALLOWED_DURATIONS[number];

/** Default Auto-Yes duration (1 hour = 3600000ms) */
export const DEFAULT_AUTO_YES_DURATION: AutoYesDuration = 3600000;

/** i18n translation keys for each duration value */
export const DURATION_LABELS: Record<AutoYesDuration, string> = {
  3600000: 'autoYes.durations.1h',
  10800000: 'autoYes.durations.3h',
  28800000: 'autoYes.durations.8h',
};

/**
 * Type guard: check whether a value is a valid AutoYesDuration.
 * Replaces `as AutoYesDuration` casts with a runtime-safe check.
 */
export function isAllowedDuration(value: unknown): value is AutoYesDuration {
  return typeof value === 'number' && (ALLOWED_DURATIONS as readonly number[]).includes(value);
}

// =============================================================================
// Stop Condition Types (Issue #314)
// =============================================================================

/** Reason why auto-yes was stopped (shared between server and client) */
export type AutoYesStopReason = 'expired' | 'stop_pattern_matched';

// =============================================================================
// Stop Pattern Validation (Issue #314)
// =============================================================================

/** Maximum length for stop pattern (security: prevent excessive regex complexity) */
export const MAX_STOP_PATTERN_LENGTH = 500;

/** Result of stop pattern validation */
export interface StopPatternValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validate a stop pattern (regular expression string).
 *
 * Security measures:
 * - Length limit (MAX_STOP_PATTERN_LENGTH)
 * - safe-regex2 for catastrophic backtracking detection (ReDoS prevention)
 * - RegExp constructor for syntax validation
 * - Error messages are fixed strings only (no error.message passthrough for XSS prevention)
 *
 * @param pattern - Regular expression pattern string to validate
 * @returns Validation result with fixed-string error messages
 */
export function validateStopPattern(pattern: string): StopPatternValidation {
  if (pattern.length > MAX_STOP_PATTERN_LENGTH) {
    return { valid: false, error: `Pattern must be ${MAX_STOP_PATTERN_LENGTH} characters or less` };
  }

  // safe-regex2 detects catastrophic backtracking patterns (ReDoS prevention)
  if (!safeRegex(pattern)) {
    return { valid: false, error: 'Pattern may cause performance issues (catastrophic backtracking detected)' };
  }

  try {
    new RegExp(pattern);
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid regular expression syntax' };
  }
}

// =============================================================================
// Time Formatting
// =============================================================================

/** Milliseconds per second */
const MS_PER_SECOND = 1000;
/** Milliseconds per minute */
const MS_PER_MINUTE = 60000;
/** Milliseconds per hour */
const MS_PER_HOUR = 3600000;

/**
 * Format remaining time as MM:SS (under 1 hour) or H:MM:SS (1 hour or more).
 *
 * Extracted from AutoYesToggle.tsx for direct testability and reuse.
 * Negative remaining time is clamped to 0.
 */
export function formatTimeRemaining(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - Date.now());
  const hours = Math.floor(remaining / MS_PER_HOUR);
  const minutes = Math.floor((remaining % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((remaining % MS_PER_MINUTE) / MS_PER_SECOND);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
