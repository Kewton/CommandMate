/**
 * Command Code's `AskUserQuestion` drawn as a free-text question with the
 * `❯ 1. Submit` / `2. Cancel` pair as its only choices (Issue #3497).
 *
 * SYNTHETIC — written to the shape Kewton/Musunest#283 reported (no capture of
 * that pane was kept) and to the measured chrome of
 * `../command-code-askuserquestion-2754/` (a 200-column U+2500 rule, a
 * `● … | ◯ Review` tab strip, the U+276F cursor). The worker's own proposal is
 * the answer under the question. Plain text, no SGR.
 *
 * A module rather than a `.txt` capture on purpose: the `.txt` sweeps over
 * `tests/fixtures/` (`dialog-frame-2326`, `command-code-quoted-footer`) are
 * corpora of LIVE captures, and a synthetic frame does not belong in them.
 */

const RULE = '─'.repeat(200);

const ROWS: readonly string[] = [
  '# Command Code v1.54.1',
  '',
  '❯ Fix the flaky retry test in the queue worker. Ask me before you change the design.',
  '',
  '✻ Thought for 4 seconds [ctrl+o to expand]',
  '',
  ' QUESTION  [Asking 1 question]',
  '',
  '',
  RULE,
  '',
  '● Retry design | ◯ Review',
  '',
  'The flaky test comes from the retry living in the HTTP handler. Should I move it into the queue worker',
  'instead? Edit the answer below if you want something else.',
  '',
  '  Move the retry into the queue worker and drop the handler-level retry.',
  '',
  '❯ 1. Submit',
  '  2. Cancel',
  '',
];

/** The frame, padded the way a 200-column pane is, with blank rows under it. */
export const COMMAND_CODE_FREE_TEXT_CONFIRM_FRAME: string =
  ROWS.map((row) => (row === RULE ? row : row.padEnd(120))).join('\n') + '\n'.repeat(21);
