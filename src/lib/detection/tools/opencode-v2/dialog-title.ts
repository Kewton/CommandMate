/**
 * OpenCode V2's dialog title row — a pure, dependency-free leaf (Issue #2983).
 *
 * Moved out of `cli-patterns.ts` (which re-exports both names) so a client
 * component can read the same row the detector reads without pulling the
 * logger and the tool registry into the browser bundle: the chat surface's
 * dialog card draws v2's model keys only while one of these dialogs is open,
 * because each of those keys closes the dialog with `Escape` before it is sent.
 *
 * @module lib/detection/tools/opencode-v2/dialog-title
 */

/**
 * The title row of an OpenCode V2 dialog opened over the composer: the model
 * picker (`ctrl+x m`), the variant picker it opens next, the Commands palette
 * (`ctrl+p`), Sessions (`ctrl+x l`) and Select agent (`ctrl+x a`) — Issue #2971.
 *
 * Measured on 2.0.18 at 80x200 (2026-09-29,
 * `tests/fixtures/opencode-v2-live-2971/`): every one of them opens with a row
 * `   <Title>                                     esc`, the dismiss hint
 * right-aligned after a wide gap, with no `┃` gutter in front. The row BELOW it
 * is the filter (`Search`, or whatever was typed into it) and changes; the
 * title row does not. The footer (`… ctrl+p commands`) stays drawn under every
 * one of them, which is why the footer alone cannot say the composer is free.
 *
 * Not matched: the running footer (`esc interrupt  ctrl+p commands`, `esc` not
 * last) and the question form's `┃  ↑↓ select  enter submit  esc dismiss`
 * (gutter, `esc` not last). Match against the ANSI-stripped frame; the title
 * sits far above the 15-line status window (row 52 of 200), so pass the whole
 * capture.
 */
export const OPENCODE_V2_DIALOG_TITLE_PATTERN =
  /^[^\S\n]*[^\s\u2502\u2503\u2579\u2580][^\n]*?[^\S\n]{8,}esc[^\S\n]*$/m;

/**
 * The title of the OpenCode V2 dialog open on the pane (`Select variant`), or
 * `null` when none is (Issue #2971). A send must not type while one is open:
 * the text lands in the dialog's filter, not in the composer.
 *
 * @param text - ANSI-stripped capture of the whole pane
 */
export function findOpencodeV2DialogTitle(text: string): string | null {
  const match = OPENCODE_V2_DIALOG_TITLE_PATTERN.exec(text);
  if (match === null) return null;
  return match[0].trim().replace(/\s+esc$/, '');
}
