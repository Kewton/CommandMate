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
 * Uses date-fns `'PPp'` (long localized date + long localized time), ensuring
 * consistent timestamp presentation across all chat-style UI surfaces. The
 * callers are `ConversationPairCard` (the transcript rows behind `HistoryPane` /
 * `ChatSurface`) and `TreeNode`'s file metadata. UI callers should pass a
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

/**
 * Format a session note's time as the compact absolute stamp (Issue #2427).
 *
 * `14:32` when the note was written today, `9/7 14:32` when it was written
 * before today. Sibling of {@link formatMessageTimestamp} — same module, same
 * `date-fns` `format`, same empty-string fallback for an invalid `Date` — but
 * deliberately NOT the same pattern: `'PPp'` renders `September 7, 2026 at
 * 2:32 PM`, which is a transcript row's worth of text next to a one-line memo in
 * a four-way split header. This is the shortest form that still answers "is this
 * note about what the session is doing right now, or about yesterday".
 *
 * ## Why absolute rather than `formatRelativeTimeShort`
 *
 * "4h ago" re-reads as a different fact every time the pane repaints, and the
 * question a note's time answers is whether it predates the instruction the
 * operator is looking at — which is a clock time they can compare against their
 * own memory of when they sent it. A relative stamp forces that subtraction back
 * onto the reader.
 *
 * ## Why it is not localized
 *
 * The date half is `M/d`, which reads the same to an English and a Japanese
 * operator (`9/7`), and the time half is 24-hour so it never spends four columns
 * on `2:32 PM`. The Issue's acceptance condition names these two shapes
 * literally, so a locale that reordered them would fail it.
 *
 * @param timestamp - When the note was written
 * @param now - The instant "today" is measured against; injectable so a test can
 *   pin the boundary instead of racing midnight
 * @returns `HH:mm`, `M/d HH:mm`, or an empty string for an invalid input
 *
 * @example
 * ```ts
 * formatSessionNoteTimestamp(new Date('2026-09-08T14:32:00'), new Date('2026-09-08T18:00:00'))
 * // => '14:32'
 * formatSessionNoteTimestamp(new Date('2026-09-07T14:32:00'), new Date('2026-09-08T18:00:00'))
 * // => '9/7 14:32'
 * ```
 */
export function formatSessionNoteTimestamp(timestamp: Date, now: Date = new Date()): string {
  if (!(timestamp instanceof Date) || isNaN(timestamp.getTime())) {
    return '';
  }
  const reference = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
  const sameDay =
    timestamp.getFullYear() === reference.getFullYear()
    && timestamp.getMonth() === reference.getMonth()
    && timestamp.getDate() === reference.getDate();

  return format(timestamp, sameDay ? 'HH:mm' : 'M/d HH:mm');
}
