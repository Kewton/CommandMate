/**
 * Command Code: was a question declined in the turn on screen? (Issue #4313, D-1)
 *
 * When the operator declines an `AskUserQuestion` (`Esc` on the question, or the
 * Review page's `Cancel`), Command Code closes the tool block with
 *
 *      QUESTION  [User answered questions]
 *      └ User declined to answer questions
 *
 * and hands the agent nothing else. Measured on #4228's UAT (1.88.2,
 * `tests/fixtures/command-code-declined-question-4313/`): the agent read the
 * decline as "no answer", went on with its own recommendation, and Auto-Yes
 * answered the shell permissions that followed — the commit the operator had
 * just declined to approve went through. The same wording is drawn by 1.54.1
 * (`command-code-askuserquestion-2754/not-applicable-question-cancelled.txt`).
 *
 * Imports only the frame type: the poller's suppression step reads this.
 *
 * @module lib/detection/tools/command-code/declined-question
 */

import type { NormalizedFrame } from '../types';

/**
 * The tool block's closing row for a declined question. Anchored on the block's
 * `└` so an agent reply quoting the sentence (`⠶ … User declined to answer
 * questions.`) is not read as the decline. The other disposition,
 * `└ User wants to discuss the questions instead of answering`, is not a decline.
 */
export const COMMAND_CODE_DECLINED_QUESTION_PATTERN = /^\s*└\s*User declined to answer questions\s*$/;

/**
 * A row the operator typed: `❯ <text>` at the left edge. Command Code draws the
 * same glyph on a dialog's cursor row (`❯ 1. Yes`), which is excluded.
 */
const USER_ROW_PATTERN = /^❯\s+\S/;
const NUMBERED_CURSOR_ROW_PATTERN = /^❯\s*\d{1,2}[.)]\s/;

/**
 * The turn summary (`✻ Worked for 3s`): drawn when a turn ends. Advisory on the
 * status path (`COMMAND_CODE_COMPLETION_PATTERN`, absent for a sub-second turn),
 * but where it is drawn, the turn above it is over.
 */
const TURN_SUMMARY_PATTERN = /^\s*✻ Worked for /;

/**
 * Whether the declined-question row is in the current turn: it is on the frame,
 * above the live region (the dialog or composer), and no row the operator typed
 * and no turn summary comes after it. A decline in an earlier turn — the
 * operator has sent something since, or the turn ended — does not count, so a
 * decline in the scrollback does not hold Auto-Yes for the rest of the session.
 *
 * Rows the frame no longer holds cannot be read: a declined line scrolled off
 * the top is not seen (Auto-Yes then answers as before).
 */
export function isCommandCodeQuestionDeclinedThisTurn(frame: NormalizedFrame): boolean {
  const rows = frame.contentLines;
  const end = frame.liveRegion.anchor === 'none' ? rows.length : Math.min(frame.liveRegion.startRow, rows.length);
  for (let i = end - 1; i >= 0; i--) {
    const row = rows[i];
    if (COMMAND_CODE_DECLINED_QUESTION_PATTERN.test(row)) return true;
    if (TURN_SUMMARY_PATTERN.test(row)) return false;
    if (USER_ROW_PATTERN.test(row) && !NUMBERED_CURSOR_ROW_PATTERN.test(row)) return false;
  }
  return false;
}
