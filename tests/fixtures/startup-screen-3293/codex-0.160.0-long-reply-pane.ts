/**
 * A codex 0.160.0 pane after a REPLY longer than the pane (Issue #3293).
 *
 * BUILT, not captured. The isolated probe these fixtures were taken with has no
 * provider that answers, so a long reply cannot be captured there. What is
 * captured is the layout it is built to:
 *
 *  - `codex-0.160.0-first-turn-reply.txt` supplies every drawn row — the echo,
 *    the reply's first row, the `Worked for …` row and the four chrome rows
 *    (composer 996, status bar 998, `? for shortcuts` 999), byte for byte;
 *  - `codex-0.160.0-overflow-interrupted.txt` is the measurement of what codex
 *    does when the transcript outgrows the pane: it draws in the alternate
 *    screen, so there is no scrollback — the pane keeps the LAST 994 rows of
 *    the transcript on rows 0-993, two blank rows, and the chrome where it was.
 *    The banner and the echo leave the pane off the top.
 *
 * The rows added between the reply's first row and `Worked for …` are the only
 * invented text. They are drawn as codex draws the rows under a reply's first
 * one: a two-space indent and no attributes.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { stripAnsi } from '@/lib/detection/cli-patterns';

const FIRST_TURN_REPLY = join(
  process.cwd(),
  'tests/fixtures/startup-screen-3293/codex-0.160.0-first-turn-reply.txt'
);

/** Reply rows added. More than a pane, so the banner and the echo are pushed off it. */
export const CODEX_LONG_REPLY_ADDED_ROWS = 1200;

/** Blank rows codex keeps between the transcript and the composer (measured: 994 and 995). */
const BLANK_ROWS_ABOVE_COMPOSER = 2;

/** The n-th added reply row (1-based). */
export function codexLongReplyRow(n: number): string {
  return `  reply line ${n} of ${CODEX_LONG_REPLY_ADDED_ROWS}`;
}

/**
 * The capture of that pane: 1000 rows and the trailing newline, like its source.
 *
 * @returns The frame, ANSI intact
 */
export function buildCodexLongReplyPane(): string {
  const rows = readFileSync(FIRST_TURN_REPLY, 'utf8').split('\n');
  const rowStartingWith = (prefix: string): number =>
    rows.findIndex(row => stripAnsi(row).trimStart().startsWith(prefix));

  const replyRow = rowStartingWith('• UAT-OK-CODEX');
  const workedRow = rowStartingWith('Worked for');
  const composerRow = rowStartingWith('› Ask Codex to do anything');
  if (replyRow < 0 || workedRow < replyRow || composerRow < workedRow) {
    throw new Error('codex-0.160.0-first-turn-reply.txt no longer has the rows this pane is built from');
  }

  const transcript = [
    ...rows.slice(0, replyRow + 1),
    ...Array.from({ length: CODEX_LONG_REPLY_ADDED_ROWS }, (_, i) => codexLongReplyRow(i + 1)),
    ...rows.slice(replyRow + 1, workedRow + 1),
  ];

  return [
    ...transcript.slice(-(composerRow - BLANK_ROWS_ABOVE_COMPOSER)),
    // `Worked for …` is drawn dim and its row carries no reset; in the capture
    // the reset arrives on a later, otherwise empty row. Same here.
    '\x1b[0m',
    ...Array<string>(BLANK_ROWS_ABOVE_COMPOSER - 1).fill(''),
    ...rows.slice(composerRow),
  ].join('\n');
}
