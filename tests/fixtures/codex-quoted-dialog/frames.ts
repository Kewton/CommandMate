/**
 * Synthetic codex frames whose CONVERSATION quotes dialog chrome while the pane
 * is idle at the composer (Issue #2841).
 *
 * Shaped after a live capture of 2026-09-24 (`mcbd-codex-commandagent-develop`,
 * 200x1000): an agent that had delegated to a second codex session reported the
 * approval dialog that session was stopped on, verbatim, in its final message.
 * The pane read `waiting` / `codex_selection_list` — the chat pane showed the
 * selection-list card with a Pick pad offering 1/2/3 — although the bottom of
 * the pane was the empty composer and nothing was open. The live capture holds a
 * private conversation, so the text here is rewritten; the row structure and the
 * SGR attributes of the rows the detector reads (composer, `Worked for`, status
 * bar) are copied from it byte for byte.
 *
 * Every frame ends the same way: `Worked for …` (dim), a blank row, the empty
 * composer (`ESC[1m›ESC[0m ESC[2mAsk Codex to do anything`), a blank row and the
 * status bar. Only the quoted chrome above them differs.
 */

const ESC = '\x1b';

/** Rows codex draws under a finished turn, copied from the live capture. */
const IDLE_TAIL: readonly string[] = [
  '',
  `${ESC}[2m  Worked for 5m 7s · done 8:52 AM`,
  `${ESC}[0m `,
  ' ',
  `${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything`,
  `${ESC}[0m `,
  `  ${ESC}[38;2;246;226;183mgpt-6-sol high${ESC}[2m${ESC}[39m · ${ESC}[0m${ESC}[38;2;171;223;167m~/work/sample-repo${ESC}[2m${ESC}[39m · ${ESC}[0m${ESC}[38;2;156;222;211mClarify request`,
  '',
];

/** Ordinary transcript above the quote, so the frame is not all chrome. */
const TRANSCRIPT_HEAD: readonly string[] = [
  `${ESC}[1m${ESC}[38;5;2m${ESC}[49m•${ESC}[0m ${ESC}[1mRan${ESC}[0m ${ESC}[38;2;137;180;250mls${ESC}[38;2;205;214;244m workspace/tmp`,
  '  └ notes.md',
  '',
];

function frame(body: readonly string[]): string {
  return [...TRANSCRIPT_HEAD, ...body, ...IDLE_TAIL].join('\n');
}

/**
 * The reported case: an approval dialog quoted inside the final message, with
 * one more paragraph of prose under its footer.
 */
export const IDLE_AFTER_QUOTED_APPROVAL = frame([
  `• ${ESC}[0mThe second session is stopped on an approval prompt. I have not answered it.`,
  '',
  '  Would you like to run the following command?',
  '',
  '    Environment: local',
  '    Reason: Read the current session id before delegating?',
  '',
  '    $ commandmatedev whoami --json',
  '',
  '  › 1. Yes, proceed (y)',
  "    2. Yes, and don't ask again for commands that start with `commandmatedev whoami` (p)",
  '    3. No, and tell Codex what to do differently (esc)',
  '',
  '    Press enter to confirm or esc to cancel',
  '',
  '  Tell me which of 1, 2 or 3 to answer. The request was already sent, so I will not send it again.',
]);

/** The same quote with the footer as the message's last row. */
export const IDLE_AFTER_QUOTED_APPROVAL_AT_TAIL = frame([
  `• ${ESC}[0mThe second session shows this:`,
  '',
  '  Would you like to run the following command?',
  '',
  '    $ npm test',
  '',
  '  › 1. Yes, proceed (y)',
  '    2. No, and tell Codex what to do differently (esc)',
  '',
  '    Press enter to confirm or esc to cancel',
]);

/** A quoted `/model` picker footer (`esc to go back`), the menu family. */
export const IDLE_AFTER_QUOTED_MODEL_PICKER = frame([
  `• ${ESC}[0mThe picker looked like this when I opened it:`,
  '',
  '  Select Model and Effort',
  '  › 1. gpt-6-sol (current)',
  '    2. gpt-6-astra',
  '',
  '    Press enter to confirm or esc to go back',
]);

/** A quoted transcript-pager footer (branch 0.7's anchor). */
export const IDLE_AFTER_QUOTED_PAGER_FOOTER = frame([
  `• ${ESC}[0mIn the transcript view the footer reads:`,
  '',
  '    ↑/↓ to scroll   pgup/pgdn to page   home/end to jump',
  '    q to quit   esc/← to edit prev   → to edit next   enter to edit message',
]);

/** A quoted hooks-review footer (branch 0.75's anchor). */
export const IDLE_AFTER_QUOTED_HOOKS_FOOTER = frame([
  `• ${ESC}[0mcodex asked me to review hooks; its screen said:`,
  '',
  '    Press t to trust all; enter to review hooks; esc to close',
]);
