/**
 * Date Utility Functions [SF-001]
 *
 * Provides date formatting utilities for UI display.
 * Separated from date-locale.ts for Single Responsibility Principle.
 *
 * @module lib/date-utils
 */

import { format, formatDistanceToNow } from 'date-fns';
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

/**
 * Convert an ISO 8601 date string to a compact relative time string. (Issue #1072)
 *
 * Produces short, fixed-width-friendly forms (e.g. "now", "5m ago", "4h ago",
 * "3d ago", "2w ago", "6mo ago", "1y ago") for dense list UIs where the verbose
 * `formatRelativeTime` output ("about 4 hours ago") is too long. Returns an
 * empty string for invalid input, matching `formatRelativeTime`.
 *
 * @param isoString - ISO 8601 format date string
 * @returns Compact relative time string, or empty string if the input is invalid
 *
 * @example
 * ```ts
 * formatRelativeTimeShort('2026-07-12T08:00:00Z') // "4h ago" (when now is 12:00Z)
 * formatRelativeTimeShort('invalid')              // ""
 * ```
 */
export function formatRelativeTimeShort(isoString: string): string {
  const date = new Date(isoString);

  if (isNaN(date.getTime())) {
    return '';
  }

  const diffSeconds = Math.round((Date.now() - date.getTime()) / 1000);

  if (diffSeconds < 45) {
    return 'now';
  }
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  if (days < 30) {
    return `${Math.round(days / 7)}w ago`;
  }
  if (days < 365) {
    return `${Math.round(days / 30)}mo ago`;
  }
  return `${Math.round(days / 365)}y ago`;
}

/**
 * Format a message timestamp as a localized date + time string. (Issue #687)
 *
 * Uses date-fns `'PPp'` (long localized date + long localized time) to match
 * `MessageList.tsx` and `PromptMessage.tsx`, ensuring consistent timestamp
 * presentation across all chat-style UI surfaces. UI callers should pass a
 * resolved `Locale` from `getDateFnsLocale()`.
 *
 * Returns an empty string for invalid `Date` values (or non-`Date` runtime
 * inputs) as a safe UI fallback.
 *
 * @param timestamp - The Date to render
 * @param locale - Optional date-fns Locale object
 * @returns Localized "PPp" string, or empty string for invalid input
 *
 * @example
 * ```ts
 * formatMessageTimestamp(new Date('2026-02-15T10:30:00Z'), ja)
 * // => '2026年2月15日 19:30' (example, depends on TZ/locale)
 * formatMessageTimestamp(new Date('invalid')) // => ''
 * ```
 */
export function formatMessageTimestamp(timestamp: Date, locale?: Locale): string {
  if (!(timestamp instanceof Date) || isNaN(timestamp.getTime())) {
    return '';
  }
  return format(timestamp, 'PPp', locale ? { locale } : undefined);
}
