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
 * - OSC sequences: ESC]...BEL and ESC]...ST (ESC \\) - window title, and the
 *   OSC 8 hyperlinks that claude/codex/copilot emit (Issue #1912). Also
 *   available on its own as {@link stripOsc} (Issue #2369), for a consumer that
 *   renders SGR and must not render OSC.
 * - CSI sequences: ESC[...letter (cursor movement, erase, etc.)
 *
 * Known limitations (SEC-002): 8-bit CSI (0x9B), DEC private modes (ESC[?25h),
 * character-set switching (ESC(0), and some RGB color forms may not match. In
 * practice tmux capture-pane output rarely contains these.
 */

/**
 * One OSC sequence: `ESC ]`, a payload, and either terminator (BEL or ST).
 *
 * Split out of {@link ANSI_PATTERN} by Issue #2369 so a second consumer can
 * strip OSC **without** stripping SGR. `sanitizeTerminalOutput`
 * (`lib/security/sanitize.ts`) is that consumer: it hands the frame to
 * `ansi-to-html`, which turns SGR into colour and does not know OSC at all — so
 * before this split, Command Code's `/usage` panel rendered its breakdown link
 * as the literal text `]8;;https://commandcode.ai/…\` beside the label. Calling
 * `stripAnsi` there would have thrown the colour away with it.
 *
 * The payload class excludes ESC as well as BEL (Issue #1912) so a sequence
 * ended by ST cannot run on to a BEL later in the buffer and swallow the visible
 * link text between them. An OSC with no terminator at all matches nothing and
 * is left in place, which is the safe answer: eating the rest of the frame is
 * worse than showing one stray escape.
 *
 * The source is shared with {@link ANSI_PATTERN} rather than restated, so the
 * two cannot drift about which terminators exist.
 */
const OSC_SOURCE = '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)';

/** {@link OSC_SOURCE} as a reusable global pattern. */
export const OSC_PATTERN = new RegExp(OSC_SOURCE, 'g');

export const ANSI_PATTERN = new RegExp(
  `\\x1b\\[[0-9;]*[a-zA-Z]|${OSC_SOURCE}|\\[[0-9;]*m`,
  'g',
);

/** Remove all ANSI escape sequences from a string. */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '');
}

/**
 * Remove OSC sequences only, leaving SGR (colour) and CSI untouched.
 *
 * For OSC 8 hyperlinks — `ESC ] 8 ; ; <url> ST <label> ESC ] 8 ; ; ST` — this
 * drops both halves of the pair and keeps `<label>`, which is the text the
 * terminal itself shows. See {@link OSC_PATTERN} for who needs this and why
 * `stripAnsi` is not the answer for them.
 */
export function stripOsc(str: string): string {
  return str.replace(OSC_PATTERN, '');
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
