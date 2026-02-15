/**
 * Date Utility Functions [SF-001]
 *
 * Provides date formatting utilities for UI display.
 * Separated from date-locale.ts for Single Responsibility Principle.
 *
 * @module lib/date-utils
 */

import { formatDistanceToNow } from 'date-fns';
import type { Locale } from 'date-fns';

/**
 * Convert an ISO 8601 date string to a relative time display string.
 *
 * Returns a human-readable relative time (e.g., "2 hours ago", "3 days ago").
 * If the input is an invalid date string, returns an empty string as a
 * safe fallback for UI display.
 *
 * @param isoString - ISO 8601 format date string (e.g., "2026-02-15T12:00:00Z")
 * @param locale - date-fns Locale object for localization (optional).
 *   When omitted, defaults to English.
 * @returns Relative time string, or empty string if the input is invalid
 *
 * @example
 * ```ts
 * formatRelativeTime('2026-02-15T10:00:00Z') // "about 2 hours ago"
 * formatRelativeTime('2026-02-15T10:00:00Z', ja) // "約2時間前"
 * formatRelativeTime('invalid') // ""
 * ```
 */
export function formatRelativeTime(isoString: string, locale?: Locale): string {
  const date = new Date(isoString);

  // Guard against invalid date strings to prevent runtime errors in UI
  if (isNaN(date.getTime())) {
    return '';
  }

  return formatDistanceToNow(date, {
    addSuffix: true,
    ...(locale ? { locale } : {}),
  });
}
