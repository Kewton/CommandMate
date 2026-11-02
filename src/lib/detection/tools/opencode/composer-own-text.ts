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

import { indexAtColumn, visibleWidth } from '../../terminal-columns';
import { OPENCODE_COMPOSER_BOTTOM_BORDER, findOpenCodeComposerRows, stripOpenCodeGutter } from './patterns';

/** The input box's bottom border row (`╹▀…▀`), the newest one on the pane, or `null`. */
function bottomBorderRow(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPENCODE_COMPOSER_BOTTOM_BORDER.test(lines[i])) return lines[i];
  }
  return null;
}

/**
 * The column just right of the input box: the end of its bottom border
 * (`╹▀…▀`), the newest one on the pane. `null` when there is none.
 *
 * The end of the border's FIRST run: on a border an overlay cuts in two
 * ({@link opencodeBoxObscured}) that is where the overlay starts, not the box's
 * right edge.
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact
 */
export function opencodeBoxRightEdge(lines: string[]): number | null {
  const row = bottomBorderRow(lines);
  if (row === null) return null;
  const border = /╹▀+/.exec(row);
  return border ? border.index + border[0].length : null;
}

/**
 * Whether something is drawn over the input box: its bottom border is cut in
 * two — `╹▀▀▀▀▀▀`, blanks, then `▀▀▀▀▀▀▀▀` further right (review of #4067).
 * A palette or picker (`opencode-live-2049/command-palette-11822.txt`,
 * `opencode-live-1896/command-palette.txt`, `canary/opencode-picker.raw.txt`)
 * paints over the box's rows from that cut on, so what the box holds there
 * cannot be read: neither an empty box nor the absence of one. No capture with
 * a whole box has a `▀` right of its border's first run (the sidebar's rows
 * included: every `.txt` capture under `tests/` was checked).
 *
 * @param lines - Captured pane lines, ANSI-stripped, box drawing intact
 */
export function opencodeBoxObscured(lines: string[]): boolean {
  const row = bottomBorderRow(lines);
  if (row === null) return false;
  const border = /╹▀+/.exec(row);
  return border !== null && row.includes('▀', border.index + border[0].length);
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

/** {@link readOpenCodeComposerBox}'s reading of the input box. */
export interface OpenCodeComposerBox {
  /** Each buffer row's own text ({@link opencodeOwnText}). */
  rows: string[];
  /**
   * An overlay is drawn over the box ({@link opencodeBoxObscured}). The rows are
   * then read out to the border's last `▀` — the box's whole width, overlay text
   * included — since its first run ends where the overlay starts.
   */
  obscured: boolean;
}

/**
 * The input box as the submit read-back reads it: its rows' own text, and
 * whether an overlay hides part of it. `null` when no box is on screen.
 *
 * @param lines - Captured pane lines of the WHOLE pane, ANSI-stripped
 */
export function readOpenCodeComposerBox(lines: string[]): OpenCodeComposerBox | null {
  const rows = findOpenCodeComposerRows(lines);
  if (rows === null) return null;
  if (!opencodeBoxObscured(lines)) {
    const rightEdge = opencodeBoxRightEdge(lines);
    return { rows: rows.map((row) => opencodeOwnText(row, rightEdge)), obscured: false };
  }
  const border = bottomBorderRow(lines)!;
  // A column, like the right edge: the overlay's text on the border row may be wide.
  const farEdge = visibleWidth(border.slice(0, border.lastIndexOf('▀') + 1));
  return { rows: rows.map((row) => opencodeOwnText(row, farEdge)), obscured: true };
}
