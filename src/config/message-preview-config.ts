/**
 * Message Preview Configuration
 *
 * Constants for message preview truncation lengths.
 * Used in Sessions page to display last sent message preview.
 *
 * Issue #606: Sessions page enhancement
 */

/** Maximum preview length for PC display (md breakpoint and above) */
export const MESSAGE_PREVIEW_MAX_LENGTH_PC = 100;

/** Maximum preview length for SP (mobile) display (below md breakpoint) */
export const MESSAGE_PREVIEW_MAX_LENGTH_SP = 20;

/**
 * Sanitize message content for safe preview display [DR4-001, DR4-002].
 * Removes control characters, bidi marks, zero-width characters,
 * normalizes newlines to spaces, and collapses whitespace.
 *
 * @param message - Raw message string
 * @returns Sanitized single-line string safe for inline display
 */
export function sanitizePreview(message: string): string {
  return message
    // Remove C0/C1 control characters (except tab/newline/CR which we handle next)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
    // Remove zero-width and bidi control characters
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u061C]/g, '')
    // Normalize newlines and tabs to spaces
    .replace(/[\r\n\t]/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}
