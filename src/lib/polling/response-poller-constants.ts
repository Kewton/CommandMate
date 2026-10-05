/**
 * Constants of the response poller that import nothing (Issue #3374 split from
 * response-poller-core.ts, so the modules split out of response-checker.ts can
 * read them without importing response-poller-core).
 */

/**
 * Gemini auth/loading state indicators that should not be treated as complete responses.
 * Braille spinner characters are shared with CLAUDE_SPINNER_CHARS in cli-patterns.ts.
 * Extracted to module level for clarity and to avoid re-creation on each call.
 */
export const GEMINI_LOADING_INDICATORS: readonly string[] = [
  'Waiting for auth',
  '\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f',
];
