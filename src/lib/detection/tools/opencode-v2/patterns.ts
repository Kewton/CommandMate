/**
 * OpenCode V2 pattern constants moved out of `../../cli-patterns.ts`
 * (Issue #3217 I-3). `cli-patterns.ts` re-exports every public name.
 */

import { PASTED_TEXT_PATTERN } from '../../shared/pasted-text';
import { OPENCODE_SEPARATOR_PATTERN } from '../opencode/patterns';

// =============================================================================
// OpenCode V2 (`opencode2`, Issue #2934)
// =============================================================================
//
// A separate tool id from `opencode` (Epic #2370, decision 1). Its TUI is drawn
// by the same toolkit and many rows look alike, but v1's constants are v1's:
// they are left exactly as they are, and v2 names its own here so a change on
// either side cannot move the other. Phase 1 reads only what the send path and
// the fallback status reader need; the approval dialog (`Always allow`, the
// reverse of v1's `Allow always`), the completion row and the session tabs are
// Phase 3's.

/**
 * OpenCode V2's empty composer: the input box's `┃` gutter with the
 * `Ask anything…` placeholder on the same row (2.0.18 draws U+2026; the ASCII
 * `...` is accepted too, as for v1 since #2915).
 *
 * Measured on 2.0.18 at 80x200 (2026-09-28):
 * `   ┃  Ask anything… "Fix broken tests"`. Match against the ANSI-stripped
 * frame BEFORE `stripBoxDrawing`, which removes the gutter this anchors on.
 */
export const OPENCODE_V2_IDLE_COMPOSER_PATTERN =
  /^[^\S\n]*[\u2502\u2503][^\S\n]*Ask anything(?:\.\.\.|\u2026)/m;

/**
 * OpenCode V2's footer, which ends in `ctrl+p commands` on every frame the
 * TUI draws (before a turn: `<path>:<branch>  shift+tab agents  ctrl+p commands`;
 * after one: `<path>:<branch>  8.8K (1%)  ctrl+p commands`, 2.0.18).
 *
 * Proof that the TUI — and so its composer — is on screen, NOT that it is idle:
 * a running turn keeps the footer.
 */
export const OPENCODE_V2_FOOTER_PATTERN = /ctrl\+p commands/;

/**
 * OpenCode V2 working indicator: the footer's `esc interrupt` hint, drawn only
 * while a turn is running (2.0.18).
 */
export const OPENCODE_V2_THINKING_PATTERN = /esc interrupt/;

/**
 * Whether OpenCode V2's composer is on screen, so a send may type into it
 * (Issue #2934, D6): the gutter-anchored placeholder, or the footer.
 *
 * @param text - ANSI-stripped capture, box drawing intact
 */
export function isOpencodeV2ComposerVisible(text: string): boolean {
  return OPENCODE_V2_IDLE_COMPOSER_PATTERN.test(text) || OPENCODE_V2_FOOTER_PATTERN.test(text);
}

/** OpenCode V2 rows that are chrome, never reply content. */
export const OPENCODE_V2_SKIP_PATTERNS: readonly RegExp[] = [
  OPENCODE_SEPARATOR_PATTERN,
  OPENCODE_V2_FOOTER_PATTERN,
  OPENCODE_V2_THINKING_PATTERN,
  /Ask anything(?:\.\.\.|\u2026)/,
  /^Build\s+·/,
  PASTED_TEXT_PATTERN,
] as const;
