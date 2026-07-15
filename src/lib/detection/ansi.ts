/**
 * Dependency-free ANSI escape-sequence primitives.
 *
 * These live in their own leaf module (no logger/db/server imports) so both
 * server-side detection code (`cli-patterns.ts`, which re-exports them) and
 * client components (the terminal display normalizer, Issue #1172) can share the
 * exact same tested pattern without pulling Node-only modules into the browser
 * bundle.
 *
 * Covers:
 * - SGR sequences: ESC[Nm (colors, bold, underline, etc.)
 * - OSC sequences: ESC]...BEL (window title, hyperlinks, etc.)
 * - CSI sequences: ESC[...letter (cursor movement, erase, etc.)
 *
 * Known limitations (SEC-002): 8-bit CSI (0x9B), DEC private modes (ESC[?25h),
 * character-set switching (ESC(0), and some RGB color forms may not match. In
 * practice tmux capture-pane output rarely contains these.
 */

export const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g;

/** Remove all ANSI escape sequences from a string. */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '');
}

/**
 * Extract the ANSI escape sequences from a string, in order, discarding all
 * other characters. Reuses the same tested pattern as {@link stripAnsi} so the
 * two stay in lock-step. Used when collapsing blank layout rows for display
 * (Issue #1172): the visible glyphs are dropped but any color/reset sequences
 * that alter how subsequent rows render must be preserved.
 */
export function extractAnsiSequences(str: string): string {
  const matches = str.match(ANSI_PATTERN);
  return matches ? matches.join('') : '';
}
