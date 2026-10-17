/**
 * What the strict `respond` (Issue #3756) reads off an observed screen before
 * any key: which option the answer names, the keys that reach it, and whether
 * the screen is still the open one at the bottom of the pane.
 *
 * Pure, so every rule is pinned by a unit test rather than by a live pane.
 *
 * @module lib/prompt-observation/strict-choice
 */

import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN,
  ANTIGRAVITY_PROMPT_PATTERN,
} from '@/lib/detection/tools/antigravity/patterns';
import { UNNUMBERED_STRICT_RESPOND_KINDS, type StrictRespondKind } from './kinds';
import type { StrictRespondReason } from './types';

export type StrictChoice =
  | { ok: true; index: number }
  | {
      ok: false;
      reason: Extract<
        StrictRespondReason,
        'label_not_found' | 'label_ambiguous' | 'number_on_unnumbered_screen' | 'number_out_of_range'
      >;
    };

/** Whitespace folded, ends trimmed, case folded: how two labels are compared. */
function fold(label: string): string {
  return label.replace(/\s+/g, ' ').trim().toLowerCase();
}

function indicesWhere(options: readonly string[], test: (folded: string) => boolean): number[] {
  return options.flatMap((option, index) => (test(fold(option)) ? [index] : []));
}

/**
 * The option an answer names.
 *
 * - A number is an option position, and only on a numbered screen: the rows of
 *   an unnumbered one carry none, so a number there is something the caller
 *   made up (`number_on_unnumbered_screen`).
 * - A label names the one option whose label equals it (case and runs of
 *   spaces aside), or — when none equals it — the one option whose label
 *   starts with it up to a word boundary (`Yes` for `Yes, I trust this
 *   folder`). Two or more matches is `label_ambiguous`, never the first: a
 *   repeated label, or `Yes` on a dialog with three `Yes…` rows.
 *
 * Only the options the screen shows are matched. An option scrolled out of
 * view was never read, so it is `label_not_found`.
 */
export function resolveStrictChoice(
  kind: StrictRespondKind,
  options: readonly string[],
  answer: string
): StrictChoice {
  const trimmed = answer.trim();
  if (/^\d+$/.test(trimmed)) {
    if (UNNUMBERED_STRICT_RESPOND_KINDS.includes(kind)) return { ok: false, reason: 'number_on_unnumbered_screen' };
    const position = Number(trimmed);
    if (position < 1 || position > options.length) return { ok: false, reason: 'number_out_of_range' };
    return { ok: true, index: position - 1 };
  }
  const wanted = fold(trimmed);
  if (wanted === '') return { ok: false, reason: 'label_not_found' };

  const exact = indicesWhere(options, folded => folded === wanted);
  if (exact.length === 1) return { ok: true, index: exact[0] };
  if (exact.length > 1) return { ok: false, reason: 'label_ambiguous' };

  const leading = indicesWhere(
    options,
    folded => folded.startsWith(wanted) && !/[\p{L}\p{N}]/u.test(folded.charAt(wanted.length))
  );
  if (leading.length === 1) return { ok: true, index: leading[0] };
  return { ok: false, reason: leading.length > 1 ? 'label_ambiguous' : 'label_not_found' };
}

/** The keys that move the highlight from `from` to `to` and confirm it: ↑/↓, then Enter. */
export function strictAnswerKeys(from: number, to: number): Array<'Up' | 'Down' | 'Enter'> {
  const step = to > from ? 'Down' : 'Up';
  return [...Array.from({ length: Math.abs(to - from) }, () => step), 'Enter'];
}

/** How many non-blank rows agy draws under its `↑/↓ Navigate` footer (`esc to cancel`, the model). */
const ROWS_UNDER_FOOTER_MAX = 3;

/**
 * Whether the pane ends in an open agy screen: a `↑/↓ Navigate` footer among
 * its last few non-blank rows, with no `>` composer drawn under it.
 *
 * The readers the classification uses already require the footer with no
 * composer under it somewhere in the frame; this asks for it at the BOTTOM.
 * A screen quoted in a reply that is still being generated (#3755 L3) can read
 * as the trust screen, but the rows under it are the reply going on — so the
 * footer is not among the last rows, and nothing is sent.
 *
 * @param frame - The capture, ANSI included or not
 */
export function isScreenOpenAtBottom(frame: string): boolean {
  const lines = stripAnsi(frame).split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  for (let i = last; i >= 0 && i >= last - ROWS_UNDER_FOOTER_MAX; i--) {
    if (!ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN.test(lines[i])) continue;
    for (let j = i + 1; j <= last; j++) {
      if (ANTIGRAVITY_PROMPT_PATTERN.test(lines[j].trimEnd())) return false;
    }
    return true;
  }
  return false;
}

/** Folder paths compared as drawn, ends trimmed. A null on either side never matches. */
export function sameApprovalTarget(observed: string | null, expected: string | null): boolean {
  return observed !== null && expected !== null && observed.trim() === expected.trim() && observed.trim() !== '';
}
