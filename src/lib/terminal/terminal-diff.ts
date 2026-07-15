/**
 * Terminal output diff for selection-preserving rendering (Issue #1120).
 *
 * The polling renderer replaced the entire terminal innerHTML on every update,
 * which cleared any active text selection. Instead we diff the previous vs. the
 * next raw output: when the next output merely extends the previous one, we emit
 * an `append` update carrying only the new suffix, so the client can append a
 * new DOM node while leaving the already-rendered (and possibly selected) nodes
 * untouched. Divergence (screen clear, scrollback truncation, TUI redraw) falls
 * back to a full `replace`.
 */

export type TerminalUpdateMode = 'noop' | 'append' | 'replace';

export interface TerminalUpdate {
  mode: TerminalUpdateMode;
  /** The authoritative full next text. */
  text: string;
  /** The suffix to append (only meaningful for mode === 'append'). */
  appended: string;
  /**
   * Length of `prev` that remains valid/rendered. For a clean append this equals
   * `prev.length`; when the append boundary falls inside an incomplete ANSI
   * escape it backs up to the start of that escape so the appended suffix carries
   * the full sequence (the previously-rendered partial escape produced no visible
   * output, so re-emitting it is invisible).
   */
  retainedLength: number;
}

/**
 * Matches an incomplete ANSI escape at the very end of a string:
 *  - a bare ESC (`\x1b`)
 *  - an unterminated CSI (`\x1b[` optionally followed by parameter/intermediate
 *    bytes but no final letter)
 */
// eslint-disable-next-line no-control-regex
const INCOMPLETE_ANSI_AT_END = /\x1b(?:\[[0-9;?]*)?$/;

/**
 * Compute how to update the rendered terminal from `prev` to `next`.
 *
 * @param prev - Previously rendered raw output (may contain ANSI codes)
 * @param next - New raw output
 */
export function computeTerminalUpdate(prev: string, next: string): TerminalUpdate {
  if (prev === next) {
    return { mode: 'noop', text: next, appended: '', retainedLength: prev.length };
  }
  // Nothing rendered yet, or the next output no longer extends the previous one
  // (clear / truncation / redraw) → full replace.
  if (prev.length === 0 || next.length <= prev.length || !next.startsWith(prev)) {
    return { mode: 'replace', text: next, appended: '', retainedLength: 0 };
  }

  // Clean prefix extension. Guard the boundary against an incomplete ANSI escape.
  const match = prev.match(INCOMPLETE_ANSI_AT_END);
  const retainedLength = match ? prev.length - match[0].length : prev.length;
  return {
    mode: 'append',
    text: next,
    appended: next.slice(retainedLength),
    retainedLength,
  };
}
