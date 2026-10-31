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
 * Text right of the box is not read as the row's own: the sidebar
 * (#2047/#2095) shares rows with the input box, beyond the right end of the
 * box's bottom border (`╹▀…▀`, measured in `opencode-live-2047/w200/`: border
 * to column 156, sidebar from 160). Text inside the box is the buffer however
 * far it is indented (`┃    old` is not empty), as `submit-composer-read`'s
 * `opencode-box` reader reads it.
 *
 * @module lib/detection/tools/opencode/readiness
 */

import { stripAnsi } from '../../ansi';
import { detectSessionStatus } from '../../status-detector';
import {
  OPENCODE_COMPOSER_BOTTOM_BORDER,
  OPENCODE_SELECTION_LIST_PATTERN,
  findOpenCodeComposerRows,
  stripOpenCodeGutter,
} from './patterns';

/** The placeholder opencode paints in an empty buffer, with its quoted suggestion. */
const PLACEHOLDER = /^Ask anything(?:\.\.\.|…)(?:[^\S\n]+"[^"\n]*")?$/;

/**
 * The column just right of the input box: the end of its bottom border
 * (`╹▀…▀`), the newest one on the pane. `null` when there is none.
 */
function boxRightEdge(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!OPENCODE_COMPOSER_BOTTOM_BORDER.test(lines[i])) continue;
    const border = /╹▀+/.exec(lines[i]);
    return border ? border.index + border[0].length : null;
  }
  return null;
}

/** The row's own text: inside the box (left of `rightEdge`), gutter removed. */
function ownText(row: string, rightEdge: number): string {
  return stripOpenCodeGutter(row.slice(0, rightEdge));
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

  const lines = text.split('\n');
  const rows = findOpenCodeComposerRows(lines);
  const rightEdge = boxRightEdge(lines);
  if (rows === null || rows.length === 0 || rightEdge === null) return false;
  return rows.every((row) => {
    const own = ownText(row, rightEdge);
    return own === '' || PLACEHOLDER.test(own);
  });
}
