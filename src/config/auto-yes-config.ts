/**
 * Auto-Yes Configuration Constants
 *
 * Shared config for Auto-Yes duration settings.
 * Used by both server (auto-yes-manager.ts, route.ts) and client
 * (AutoYesConfirmDialog.tsx, AutoYesToggle.tsx) components.
 *
 * Issue #225: Duration selection feature
 */

/** Allowed Auto-Yes durations in milliseconds */
export const ALLOWED_DURATIONS = [3600000, 10800000, 28800000] as const;

/** Auto-Yes duration type (literal union from ALLOWED_DURATIONS) */
export type AutoYesDuration = typeof ALLOWED_DURATIONS[number];

/** Default Auto-Yes duration (1 hour = 3600000ms) */
export const DEFAULT_AUTO_YES_DURATION: AutoYesDuration = 3600000;

/** UI display labels for each duration value */
export const DURATION_LABELS: Record<AutoYesDuration, string> = {
  3600000: '1時間',
  10800000: '3時間',
  28800000: '8時間',
};

/**
 * Type guard: check whether a value is a valid AutoYesDuration.
 * Replaces `as AutoYesDuration` casts with a runtime-safe check.
 */
export function isAllowedDuration(value: unknown): value is AutoYesDuration {
  return typeof value === 'number' && (ALLOWED_DURATIONS as readonly number[]).includes(value);
}

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
