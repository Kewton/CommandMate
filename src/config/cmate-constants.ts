/**
 * CMATE.md Shared Constants
 * Issue #294: Constants shared between server-side parser and client-side validator
 *
 * This module has NO Node.js dependencies (no 'fs'), so it can be safely
 * imported from both server and client code.
 */

// =============================================================================
// File
// =============================================================================

/** CMATE.md filename */
export const CMATE_FILENAME = 'CMATE.md';

// =============================================================================
// Sanitization
// =============================================================================

/**
 * Unicode control character regex for sanitization.
 * Matches: C0 control chars (except \t \n \r), C1 control chars,
 * zero-width characters, directional control characters.
 *
 * NOTE: No /g flag on the export — callers must use String.replace(pattern, '')
 * with /g or String.replaceAll() to avoid lastIndex state issues.
 *
 * [S4-002] Strips potentially dangerous Unicode control characters
 */
export const CONTROL_CHAR_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F\u200B-\u200F\u2028-\u202F\uFEFF]/;

/**
 * Remove Unicode control characters from a string.
 * Preserves tabs (\t), newlines (\n), and carriage returns (\r).
 *
 * @param content - Raw string to sanitize
 * @returns Sanitized string with control characters removed
 */
export function sanitizeContent(content: string): string {
  // Use RegExp constructor with /g to avoid lastIndex state on the shared pattern
  return content.replace(new RegExp(CONTROL_CHAR_PATTERN.source, 'g'), '');
}

// =============================================================================
// Name Validation
// =============================================================================

/**
 * Name validation pattern.
 * Allows: ASCII word chars, Japanese chars (CJK, Hiragana, Katakana, Symbols),
 * spaces, and hyphens. Length: 1-100 characters.
 *
 * [S4-011] Prevents injection through name field
 */
export const NAME_PATTERN =
  /^[\w\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uF900-\uFAFF\s-]{1,100}$/;

// =============================================================================
// Limits
// =============================================================================

/** Maximum cron expression length */
export const MAX_CRON_EXPRESSION_LENGTH = 100;

/** Maximum number of schedule entries per worktree */
export const MAX_SCHEDULE_ENTRIES = 100;

// =============================================================================
// Cron Validation
// =============================================================================

/**
 * Validate a cron expression.
 * Checks length and basic format (5-6 fields separated by spaces).
 *
 * @param expression - Cron expression to validate
 * @returns true if the expression appears valid
 */
export function isValidCronExpression(expression: string): boolean {
  if (expression.length > MAX_CRON_EXPRESSION_LENGTH) {
    return false;
  }

  const parts = expression.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}
