/**
 * Auto-Yes Configuration Constants
 *
 * Shared config for Auto-Yes duration settings and stop pattern validation.
 * Used by both server (auto-yes-manager.ts, route.ts) and client
 * (AutoYesConfirmDialog.tsx, AutoYesToggle.tsx) components.
 *
 * Issue #225: Duration selection feature
 * Issue #314: Stop condition (regex) validation
 * Issue #3913: Durations widened to 1〜24 hours (defined in auto-yes-duration.ts)
 */

import safeRegex from 'safe-regex2';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';

// Issue #3913: the duration definitions live in the dependency-free
// `auto-yes-duration.ts` so the CLI can re-export them; re-exported here so
// server and browser code keep importing from this module.
export {
  AUTO_YES_DURATIONS,
  PRESET_AUTO_YES_DURATIONS,
  DEFAULT_AUTO_YES_DURATION,
  MIN_AUTO_YES_HOURS,
  MAX_AUTO_YES_HOURS,
  isAllowedDuration,
  autoYesDurationToHours,
  hoursToAutoYesDuration,
  type AutoYesDuration,
} from './auto-yes-duration';

// =============================================================================
// Polling Interval Constants (Issue #499)
// =============================================================================

/** Polling interval when Thinking state is detected (Issue #499 Item 2) */
export const THINKING_POLLING_INTERVAL_MS = 5000;

/** Reduced capture lines when stopPattern is not set (Issue #499 Item 3) */
// Issue #1167: a 1000-row alternate-screen frame can place an active prompt
// near the top and a task panel at the bottom. Capture the whole current frame
// before applying semantic detection normalization.
export const REDUCED_CAPTURE_LINES = TUI_PANE_HEIGHT;

/** Full capture lines when stopPattern is set (Issue #499 Item 3) */
export const FULL_CAPTURE_LINES = 5000;

/**
 * Interval (ms) for the Auto-Yes countdown timer that refreshes the remaining
 * time display (Issue #760).
 * Site: AutoYesToggle.
 */
export const AUTO_YES_COUNTDOWN_INTERVAL_MS = 1000;

// =============================================================================
// Error Threshold Constants (Issue #499)
// =============================================================================

/** Number of consecutive errors before auto-stopping auto-yes (Issue #499 Item 5) */
export const AUTO_STOP_ERROR_THRESHOLD = 20;

// =============================================================================
// Stop Condition Types (Issue #314)
// =============================================================================

/**
 * Reason why auto-yes was stopped (shared between server and client).
 *
 * Issue #3730: `server-restart` is the one reason no running process decided.
 * A graceful stop (SIGINT / SIGTERM) records which grants were live
 * (`lib/auto-yes-shutdown-record`), and the next process seeds each still
 * in-period one as a DISABLED state with this reason, so "turned off by the
 * restart" reads differently from "never on". The grant itself is never
 * restored. A SIGKILL or a crash records nothing, and every grant then comes
 * back off with no reason, as before.
 */
export type AutoYesStopReason = 'expired' | 'stop_pattern_matched' | 'consecutive_errors' | 'server-restart';

/**
 * Why one Auto-Yes POLLER stopped, as `poller:stopped` logs it (Issue #3730).
 *
 * Not the same thing as {@link AutoYesStopReason}, which says why the GRANT
 * ended: a poller is also stopped while its grant lives on (an ID move restarts
 * it under the new key, a different CLI tool replaces it), so a poller reason
 * never disables anything by itself.
 *
 * The lifecycle events keep their names (`lib/auto-yes-lifecycle`), except
 * `server-shutdown`, which logs `shutdown` as it always has.
 */
export type AutoYesPollerStopReason =
  /** The auto-yes route turned it off (one instance, one tool, or every agent). */
  | 'manual'
  /** A tick found the grant past its deadline. */
  | 'expired'
  /** A tick found the grant disabled for another reason, or gone. */
  | 'not-enabled'
  /** A tick's composite key names no known CLI tool. */
  | 'invalid-key'
  /** The stop pattern matched the agent's output. */
  | 'stop-pattern'
  | 'consecutive-errors'
  | 'session-killed'
  | 'instance-removed'
  | 'worktree-deleted'
  | 'orphan-swept'
  | 'shutdown'
  /** A worktree ID moved; the poller restarts under the new key (grant kept). */
  | 'worktree-id-migrated'
  /** A poller for a different CLI tool took the key over (grant kept). */
  | 'replaced'
  /** A test seam cleared every poller (`clearAllPollerStates`). */
  | 'reset'
  /** No caller said. Every production call site passes a reason; tests may not. */
  | 'unspecified';

/**
 * Whether one instance's Auto-Yes reads "off, released by the last server
 * restart" (Issue #3730): disabled, with `stopReason: 'server-restart'`.
 * Shared by every surface that labels a toggle, so they cannot disagree.
 *
 * @param entry - The instance's state as a surface holds it, if any
 */
export function isReleasedByRestart(
  entry: { enabled?: boolean; stopReason?: string } | null | undefined,
): boolean {
  return entry?.enabled !== true && entry?.stopReason === 'server-restart';
}

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

/**
 * Execute a regex test with timeout protection.
 * Uses synchronous execution with safe-regex2 pre-validation as the primary defense.
 *
 * Lives here rather than in auto-yes-state.ts (Issue #1547) so the auto-yes
 * resolver can use it: the resolver is imported by a 'use client' hook, and
 * auto-yes-state pulls in path-validator, which imports `fs`.
 *
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
