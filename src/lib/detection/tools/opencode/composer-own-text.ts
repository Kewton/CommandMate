/**
 * The text an opencode input box holds, cut out of the rows it shares with the
 * sidebar (Issue #4067).
 *
 * opencode (v1, and v2 2.0.x — same box: `┃` gutter rows over a `╹▀…▀` bottom
 * border) draws its sidebar (#2047/#2095) on the same rows as the input box,
 * right of the box's bottom border: measured in `opencode-live-2047/w200/`
 * (border to column 156, sidebar from 160), `opencode-live-2046/w80/sidebar-on.txt`
 * and `opencode-v2-usage-2981/pane-turn1-2.0.18.txt`. A row's own text is what
 * lies left of that border's end, its gutter removed.
 *
 * Before #4067 there were two readings of the same rows: the send readiness
 * (#4040) cut at the right edge, and the submit read-back
 * (`submit-composer-read`'s `opencode-box`) read the whole row — so an empty box
 * beside the sidebar was ready to the one and held `/private/…` (the sidebar's
 * working directory) to the other, which then classified a delivered message
 * `replaced`. Both now read through this module.
 *
 * Text inside the box is the buffer however far it is indented (`┃    old` is
 * not empty).
 *
 * @module lib/detection/tools/opencode/composer-own-text
 */

import { indexAtColumn } from '../../terminal-columns';
import { OPENCODE_COMPOSER_BOTTOM_BORDER, findOpenCodeComposerRows, stripOpenCodeGutter } from './patterns';

/**
 * The column just right of the input box: the end of its bottom border
 * (`╹▀…▀`), the newest one on the pane. `null` when there is none.
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact
 */
export function opencodeBoxRightEdge(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!OPENCODE_COMPOSER_BOTTOM_BORDER.test(lines[i])) continue;
    const border = /╹▀+/.exec(lines[i]);
    return border ? border.index + border[0].length : null;
  }
  return null;
}

/**
 * The row's own text: inside the box (left of `rightEdge`), gutter removed.
 * With no right edge (no border found) the whole row is read, as before #4067.
 *
 * @param row - One composer row, gutter intact
 * @param rightEdge - {@link opencodeBoxRightEdge} of the same frame
 */
export function opencodeOwnText(row: string, rightEdge: number | null): string {
  const inside = rightEdge === null ? row : row.slice(0, indexAtColumn(row, rightEdge));
  return stripOpenCodeGutter(inside);
}

/**
 * The input box's buffer rows as their own text (gutter and sidebar removed),
 * or `null` when no box is on screen ({@link findOpenCodeComposerRows}).
 *
 * @param lines - Captured pane lines of the WHOLE pane, ANSI-stripped
 */
export function readOpenCodeComposerOwnRows(lines: string[]): string[] | null {
  const rows = findOpenCodeComposerRows(lines);
  if (rows === null) return null;
  const rightEdge = opencodeBoxRightEdge(lines);
  return rows.map((row) => opencodeOwnText(row, rightEdge));
}
