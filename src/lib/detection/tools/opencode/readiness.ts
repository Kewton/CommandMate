/**
 * Whether an opencode (v1) pane is ready to take a typed message body
 * (Issue #4040).
 *
 * The launch wait (`OpenCodeTool.waitForReady`) is not this test: it accepts
 * the `Connect a provider` overlay so a launch does not burn its window there,
 * and `OPENCODE_IDLE_COMPOSER_PATTERN` only anchors the placeholder's start —
 * it does not say the rest of the input box is empty, and opencode stops
 * painting the placeholder once a session has answered a turn (every
 * post-turn frame in `tests/fixtures/opencode-live-2047/w80/` has an input box
 * of blank gutter rows and no `Ask anything`).
 *
 * Ready means, on the WHOLE frame (the box is centred under the banner until
 * the first turn, ~100 rows above the bottom):
 *
 * - no dialog or overlay — the detector's `waiting` (permission strip, picker,
 *   palette, `Connect a provider`) and the picker header itself;
 * - the input box is on screen (`findOpenCodeComposerRows`: its bottom border
 *   and gutter);
 * - every buffer row of it is empty: blank, or the placeholder (optionally with
 *   its quoted suggestion) and nothing else. A row holding any other text —
 *   a previous body, a typed character — is not ready.
 *
 * A turn being generated keeps the empty box on screen (`turn-running.txt`),
 * so it is ready by the same rule; no generation exception is needed.
 *
 * Text right of a run of four or more spaces is not read as the row's own:
 * the sidebar (#2047/#2095) shares rows with the input box.
 *
 * @module lib/detection/tools/opencode/readiness
 */

import { stripAnsi } from '../../ansi';
import { detectSessionStatus } from '../../status-detector';
import { OPENCODE_SELECTION_LIST_PATTERN, findOpenCodeComposerRows } from './patterns';

/** The input box's gutter at the start of a row. */
const GUTTER = /^[^\S\n]*[│┃]/;

/** The placeholder opencode paints in an empty buffer, with its quoted suggestion. */
const PLACEHOLDER = /^Ask anything(?:\.\.\.|…)(?:[^\S\n]+"[^"\n]*")?$/;

/** The row's own text: after the gutter, up to the first run of 4+ spaces (the sidebar's column). */
function ownText(row: string): string {
  const rest = row.replace(GUTTER, '');
  const leading = rest.match(/^[^\S\n]*/)?.[0].length ?? 0;
  // Content starts two columns after the gutter; a long run before any text is
  // an empty buffer row with the sidebar beside it.
  if (leading >= 4) return '';
  return rest.trim().split(/[^\S\n]{4,}/)[0] ?? '';
}

/**
 * @param output - Raw `capture-pane` output of the whole pane (ANSI allowed)
 * @returns true when the input box is on screen, empty, and nothing covers it
 */
export function isOpenCodeComposerReady(output: string): boolean {
  const text = stripAnsi(output);
  if (OPENCODE_SELECTION_LIST_PATTERN.test(text)) return false;
  const status = detectSessionStatus(output, 'opencode');
  if (status.hasActivePrompt || status.status === 'waiting') return false;

  const rows = findOpenCodeComposerRows(text.split('\n'));
  if (rows === null || rows.length === 0) return false;
  return rows.every((row) => {
    const own = ownText(row);
    return own === '' || PLACEHOLDER.test(own);
  });
}
