/**
 * Sanitization utilities for XSS prevention
 * Used primarily for terminal output which may contain ANSI escape codes
 */

import DOMPurify from 'isomorphic-dompurify';
import AnsiToHtml from 'ansi-to-html';
import {
  MAX_TERMINAL_OUTPUT_LENGTH,
  TERMINAL_TRUNCATION_MARKER,
  TERMINAL_TRUNCATION_LINE_SCAN_LIMIT,
} from '@/config/terminal-output-config';

const ansiConverter = new AnsiToHtml({
  fg: '#d1d5db',  // gray-300
  bg: '#1f2937',  // gray-800
  newline: true,
  escapeXML: true,  // Important: Enable XML escaping
});

/**
 * Matches the FINAL byte of an ANSI escape sequence — anything in `@`–`~`
 * (0x40–0x7e). Parameter and intermediate bytes are all below 0x40, and a newline
 * can never appear inside a sequence at all.
 */
// eslint-disable-next-line no-control-regex
const ANSI_FINAL_BYTE = /[\x40-\x7e]/;

/**
 * Advance `index` past an ANSI escape sequence that starts before it and has not
 * terminated by it. Used only as a fallback when no line boundary is available.
 */
function skipStraddlingAnsiEscape(text: string, index: number): number {
  const escIndex = text.lastIndexOf('\x1b', index - 1);
  if (escIndex === -1) return index;

  // `body` is everything after the ESC up to the cut. For `\x1b[38;2;205;214;2`
  // that is `[38;2;205;214;2`; the leading `[` is an introducer, not a final byte.
  const body = text.slice(escIndex + 1, index);
  if (ANSI_FINAL_BYTE.test(body.slice(1))) return index; // already terminated

  // Unterminated: skip forward to just past this sequence's final byte.
  for (let i = index; i < text.length; i++) {
    if (ANSI_FINAL_BYTE.test(text[i])) return i + 1;
  }
  return text.length;
}

/**
 * Truncate oversized terminal output, keeping the TAIL (Issue #1674).
 *
 * A terminal is read from the bottom: the newest output is what the user needs.
 * The previous implementation kept `slice(0, MAX)` — the head — so once Issue
 * #1624 let a real Codex capture reach 1,182,902 characters, the most recent
 * 134,326 characters (composer line, final assistant message) were silently
 * dropped and the pane looked like a stalled session.
 *
 * The cut is aligned to a line boundary. Cutting at an exact character offset
 * lands inside an ANSI escape roughly as often as escapes are dense, and
 * `ansi-to-html` then emits the sequence's parameter bytes as literal text
 * (the real capture rendered a trailing `+2;205;214;2`). A newline can never
 * appear inside an escape sequence, so starting the tail right after one is
 * sufficient.
 *
 * Mirrors `truncateMessage()` (`src/lib/response-cleaner.ts`), which is
 * tail-preserving for the same reason, marker included.
 *
 * @param output - Terminal output that may contain ANSI escape codes
 * @returns `output` unchanged when within the cap, otherwise marker + tail
 */
export function truncateTerminalOutput(output: string): string {
  if (output.length <= MAX_TERMINAL_OUTPUT_LENGTH) return output;

  const markerWithNewline = TERMINAL_TRUNCATION_MARKER + '\n';
  const budget = MAX_TERMINAL_OUTPUT_LENGTH - markerWithNewline.length;
  if (budget <= 0) {
    // Degenerate configuration: the marker alone does not fit.
    return TERMINAL_TRUNCATION_MARKER.slice(0, MAX_TERMINAL_OUTPUT_LENGTH);
  }

  const rawCut = output.length - budget;

  // Align forward to a line start. Forward (never backward) so the result stays
  // within `MAX_TERMINAL_OUTPUT_LENGTH`.
  const newlineIndex = output.indexOf('\n', rawCut);
  if (newlineIndex !== -1 && newlineIndex - rawCut <= TERMINAL_TRUNCATION_LINE_SCAN_LIMIT) {
    return markerWithNewline + output.slice(newlineIndex + 1);
  }

  // No usable line boundary (one enormous line). Keep the cut escape-aware, and
  // guard a split surrogate pair as `truncateMessage()` does.
  let cut = skipStraddlingAnsiEscape(output, rawCut);
  const code = output.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
  return markerWithNewline + output.slice(cut);
}

/**
 * Sanitize terminal output and convert to HTML
 *
 * @param output - Terminal output that may contain ANSI escape codes
 * @returns Sanitized HTML string
 *
 * @example
 * ```typescript
 * const html = sanitizeTerminalOutput('\x1b[31mError: Something went wrong\x1b[0m');
 * // Returns: '<span style="color:#f87171">Error: Something went wrong</span>'
 * ```
 */
export function sanitizeTerminalOutput(output: string): string {
  // Step 0: Input validation. Oversized input keeps its tail (Issue #1674).
  const validated = truncateTerminalOutput(output.replace(/\0/g, ''));

  // Step 1: Convert ANSI codes to HTML (escapeXML: true provides basic escaping)
  const html = ansiConverter.toHtml(validated);

  // Step 2: Additional sanitization with DOMPurify
  // Only allow span tags and style attributes (for ANSI colors)
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['span', 'br'],
    ALLOWED_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
  });

  return sanitized;
}

/**
 * Sanitize user input text
 *
 * @param input - User input text
 * @returns Sanitized text with all HTML tags removed
 *
 * @example
 * ```typescript
 * const safe = sanitizeUserInput('<script>alert(1)</script>');
 * // Returns: ''
 * ```
 */
export function sanitizeUserInput(input: string): string {
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: [],  // Remove all HTML tags
    ALLOWED_ATTR: [],
  });
}

/**
 * Check if a string contains potentially dangerous content
 *
 * @param content - Content to check
 * @returns true if potentially dangerous content is detected
 */
export function containsDangerousContent(content: string): boolean {
  const dangerousPatterns = [
    /<script\b/i,
    /javascript:/i,
    /on\w+\s*=/i,  // Event handlers like onclick=, onerror=
    /<iframe\b/i,
    /<object\b/i,
    /<embed\b/i,
    /data:text\/html/i,
  ];

  return dangerousPatterns.some(pattern => pattern.test(content));
}
