/**
 * Keys that move a TUI selection list's cursor onto one option (Issue #2878).
 *
 * Start-up dialogs (folder trust and the like) do not agree on which option is
 * pre-selected — claude 2.1.283 puts the cursor on "No, exit", antigravity on
 * "Yes" — so the probe reads where the cursor is and where the wanted option
 * is, instead of hard-coding "press Enter".
 */

import { stripAnsi } from '@/lib/detection/ansi';

/** A selection cursor at the start of a row: `❯`, `›` or `>`. */
const CURSOR_ROW = /^\s*[❯›>]\s+\S/;

/** How far above/below the wanted option the cursor row may be. */
const LIST_WINDOW = 8;

/**
 * @returns the keys to send (`Down`/`Up` repeated, then `Enter`), or null when
 *   the option or the cursor is not on screen.
 */
export function selectionKeys(frame: string, option: RegExp): string[] | null {
  const rows = stripAnsi(frame).split('\n');
  let target = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (option.test(rows[i])) {
      target = i;
      break;
    }
  }
  if (target === -1) return null;

  let cursor = -1;
  let best = Number.POSITIVE_INFINITY;
  const from = Math.max(0, target - LIST_WINDOW);
  const to = Math.min(rows.length - 1, target + LIST_WINDOW);
  for (let i = from; i <= to; i++) {
    if (CURSOR_ROW.test(rows[i]) && Math.abs(i - target) < best) {
      cursor = i;
      best = Math.abs(i - target);
    }
  }
  if (cursor === -1) return null;

  const distance = target - cursor;
  const move = distance >= 0 ? 'Down' : 'Up';
  return [...Array<string>(Math.abs(distance)).fill(move), 'Enter'];
}
