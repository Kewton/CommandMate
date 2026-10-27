/**
 * codex frames with an old composer left above a dialog (Issue #3927).
 *
 * The frame is the one #3906 pinned the clear on
 * (`tests/unit/session/composer-clear-codex-3906.test.ts`, "re-review 2 (1)"),
 * built the same way: the live codex-cli 0.160.0 capture
 * `codex-multiline-composer-3205/tc104-raw-pane.txt` (transcript and footer),
 * ANSI intact, with the composer rows replaced. Shared here so the extractor,
 * the published payload, the browser's reading and the rendered bar are all
 * checked against one frame.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ESC = '\u001b';
const TC104 = readFileSync(
  path.resolve(__dirname, 'codex-multiline-composer-3205/tc104-raw-pane.txt'),
  'utf-8',
).split('\n');
const TRANSCRIPT = TC104.slice(0, 38);
const FOOTER = TC104[45];

const GLYPH = `${ESC}[1m›${ESC}[0m `;

/** The old composer's text, as the unsent bar would show it. */
export const OLD_COMPOSER_TEXT = 'row 1: old\nrow 2: old\nrow 3: old';

const COMPOSER_ROWS = OLD_COMPOSER_TEXT.split('\n').map((line, i) => (i === 0 ? GLYPH : '  ') + line);

/** A three-row composer from before, and an approval dialog's options drawn below it. */
export const CODEX_DIALOG_BELOW_FRAME = [
  ...TRANSCRIPT,
  ...COMPOSER_ROWS,
  '',
  `${ESC}[1m${ESC}[38;5;6m› 1. Yes, proceed (y)${ESC}[0m`,
  '  2. No, and tell Codex what to do differently (esc)',
].join('\n');

/** The same rows as the live composer, under codex's model / cwd footer (the control). */
export const CODEX_LIVE_COMPOSER_FRAME = [...TRANSCRIPT, ...COMPOSER_ROWS, '', FOOTER].join('\n');
