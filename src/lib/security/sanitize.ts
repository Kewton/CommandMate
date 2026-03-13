/**
 * Sanitization utilities for XSS prevention
 * Used primarily for terminal output which may contain ANSI escape codes
 */

import DOMPurify from 'isomorphic-dompurify';
import AnsiToHtml from 'ansi-to-html';

const ansiConverter = new AnsiToHtml({
  fg: '#d1d5db',  // gray-300
  bg: '#1f2937',  // gray-800
  newline: true,
  escapeXML: true,  // Important: Enable XML escaping
});

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
  // Step 1: Convert ANSI codes to HTML (escapeXML: true provides basic escaping)
  const html = ansiConverter.toHtml(output);

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
