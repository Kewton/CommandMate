/**
 * Command Code's selection-list / plan-review / question-page patterns and
 * readers, moved out of `selection-shape.ts` (Issue #3218). `selection-shape.ts`
 * re-exports every name it used to export from here.
 *
 * Imports only `ansi` and `selection-shape-patterns`: the screen-side modules
 * reach this through `selection-shape.ts`, so nothing server-only may come in,
 * and importing `selection-shape.ts` back would be a cycle.
 */

import { stripAnsi } from '../../ansi';
import { COMMAND_CODE_PLAN_REVIEW_FOOTER } from '../../selection-shape-patterns';

/**
 * Command Code's picker footer (v1.40.1, measured at 200x1000 for Issue #2297).
 *
 *     type to search · ↑/↓ navigate · shift+↑/↓ jump provider · enter to select · esc to cancel
 *
 * Before this Issue no detector branch matched it, so the overlay fell through
 * to the `default` floor and the chat surface raised its `unclassified` card —
 * whose controls are the `1`–`9` / `y` / `n` answer keys, every one of which
 * would have been typed into that `Type to search models...` box. The
 * command-code detector imports this and answers
 * `STATUS_REASON.COMMAND_CODE_SELECTION_LIST` instead, which puts the arrow pad
 * on the card.
 *
 * Lower case is what Command Code draws, and the `·` separator keeps the pattern
 * off ordinary prose — the same two narrowings `COPILOT_SELECTION_FOOTER_PATTERN`
 * settled on for the same reason.
 */
export const COMMAND_CODE_SELECTION_LIST_FOOTER =
  /\benter\s+to\s+select\b\s*[·•]\s*esc\s+to\s+cancel\b/i;

/**
 * The footer of an overlay whose ONLY exit is the dismiss (Issue #2369).
 *
 * Measured on Command Code 1.49's `/usage`, whose last row is verbatim
 * `Press Esc to close`. The panel above it is read-only — a plan header, two
 * meters, a breakdown URL — so there is no highlight to move and no key to
 * confirm with. Before this pattern existed nothing matched the screen, it
 * reached the `default` floor, and the chat surface answered an
 * eighteen-button `unclassified` card to a panel with one working key.
 *
 * ## Why it is this narrow
 *
 * Three narrowings, and each one is there because this predicate SUPPRESSES
 * controls — a false positive takes the arrow pad and the answer keys away from
 * a screen that needed them:
 *
 *  - **a verb before the key.** `Press`/`Hit`/`Type`, or nothing at all, but not
 *    an arbitrary run of prose. `esc to cancel` on its own is the tail of every
 *    picker footer in this file, including
 *    {@link COMMAND_CODE_SELECTION_LIST_FOOTER}, and those screens have a
 *    highlight;
 *  - **`close`/`dismiss`/`exit`, never `cancel` or `go back`.** The distinction
 *    is measured rather than stylistic: `cancel` is what a screen with a
 *    COMMITTABLE choice calls its escape (claude's `/model`, codex's picker,
 *    Command Code's own), while `close` is what a panel that decided nothing
 *    calls it;
 *  - **the whole row.** Anchored at both ends (leading/trailing space aside), so
 *    a hint bar that offers a dismiss ALONGSIDE something else — `↑/↓ navigate ·
 *    enter to select · esc to close` — does not match, and keeps the arrows the
 *    other half of its sentence promises.
 *
 * Case-insensitive because the measured row is `Press Esc to close` and Command
 * Code writes its picker hints in lower case; nothing rests on which it uses.
 */
export const DISMISSABLE_PANEL_FOOTER_PATTERN =
  /^\s*(?:press|hit|type)?\s*(?:<)?esc(?:ape)?(?:>)?\s+to\s+(?:close|dismiss|exit)\b[\s.·•]*$/im;


/**
 * The radio row `ctrl+a` puts in place of the action list when comments are
 * pending (Issue #2793).
 *
 * Measured on 1.58.0 (`tests/fixtures/command-code-plan-review-2763/`): with
 * zero comments `ctrl+a` approves at once, and with one or more it first asks
 * what to do with them. The three action rows are replaced by ONE row, and the
 * selected side is `(•)`, the other `( )` — readable without the ANSI:
 *
 *     Approve (•) with 4 comments as notes ( ) original plan · discard comments
 *
 * `comments?` because the badge above it is measured in both numbers
 * (`1 pending comment` / `4 pending comments`); the radio itself was captured
 * with four.
 */
export const COMMAND_CODE_PLAN_APPROVE_CHOICE_ROW =
  /^\s*Approve\s+\([• ]\)\s+with\s+\d+\s+comments?\s+as\s+notes\s+\([• ]\)\s+original\s+plan\b/im;

/**
 * The hint bar under {@link COMMAND_CODE_PLAN_APPROVE_CHOICE_ROW}, verbatim
 * `←/→ choose · enter confirm · esc back`.
 *
 * Anchored to the LAST row of the text it is tested against (no `m` flag: `$` is
 * the end of the input), because that is where the overlay draws every one of
 * its five measured hint bars, and because it is what keeps a transcript that
 * QUOTES this screen from matching — the composer is always drawn below a
 * transcript, so there the quote is never the last row.
 */
export const COMMAND_CODE_PLAN_APPROVE_CHOICE_FOOTER =
  /(?:^|\n)[ \t]*←\/→\s+choose\s*·\s*enter\s+confirm\s*·\s*esc\s+back\s*$/i;

/**
 * Whether this tail is the approve-with-comments confirmation (Issue #2793).
 *
 * BOTH rows, for the reason {@link COMMAND_CODE_PLAN_REVIEW_FOOTER} gives for
 * its two: either half alone is a sentence something else could print. Not
 * adjacent — `Editor exited with code 127` and a blank row sit between them on
 * both captures — so each is tested on its own.
 *
 * Deliberately NOT folded into {@link COMMAND_CODE_PLAN_REVIEW_FOOTER}, and
 * therefore not {@link SelectionListShape.offersPlanApprove}: on this screen
 * `enter` is the documented CONFIRM of an approval the human already started
 * with `ctrl+a`, so the chat surface must keep its `Enter`, and what `ctrl+a`
 * does here was not measured.
 *
 * @param tail - the frame's last rows, ANSI stripped, last content row last
 */
export function isCommandCodePlanApproveChoice(tail: string): boolean {
  return (
    COMMAND_CODE_PLAN_APPROVE_CHOICE_ROW.test(tail) &&
    COMMAND_CODE_PLAN_APPROVE_CHOICE_FOOTER.test(tail)
  );
}

/**
 * How many content rows the plan review footer's LAST row (`Cancel esc`) may
 * have under it and still be the overlay's own footer (Issue #2846): the footer's
 * two rows plus three.
 *
 * Measured over the sixteen plan review captures that carry the footer
 * (`tests/fixtures/command-code-plan-review-2761/`, `-2763/`): fourteen draw ONE
 * row below it, the hint bar (`type + enter to comment · …`); one draws two, an
 * `Editor exited with code 127` row and then the hint bar; and the garbled
 * `editor-killed-staircase.txt` draws three, because the pane wrapped the hint
 * bar. So the plan review footer is NOT the last row the way the picker's is,
 * and a "last two rows" rule misses every one of them.
 *
 * What bounds it from above is the composer. A transcript is always drawn above
 * one, and its shortest measured form is four rows — rule, `❯ Ask your
 * question...`, rule, status row — so a footer QUOTED in a reply has at least
 * four content rows under it and its `Approve` row falls outside this window.
 * The margin between the widest overlay (3) and the narrowest composer (4) is
 * one row; a capture that narrows it is the reason to re-measure, not to widen
 * this.
 */
const COMMAND_CODE_PLAN_REVIEW_TAIL_ROW_COUNT = 5;

/**
 * The last `count` rows of `text` that carry content, joined with `\n`.
 *
 * Blank rows are dropped rather than counted: the pane is padded with them, and
 * a real footer is set off from its hint bar by one.
 */
function lastContentRows(text: string, count: number): string {
  return text
    .split('\n')
    .filter((row) => row.trim() !== '')
    .slice(-count)
    .join('\n');
}

/**
 * Whether the LAST content row of this tail is Command Code's picker footer
 * (Issue #2846).
 *
 * {@link COMMAND_CODE_SELECTION_LIST_FOOTER} matches the sentence anywhere, and
 * a reply that quotes the `/model` footer is that sentence in the middle of the
 * transcript. The picker draws the footer as the last row of the pane (all four
 * captures that carry it do, `tests/fixtures/chat-dialog-card-2254/`), and a
 * transcript always has the composer under it — the same reasoning
 * {@link COMMAND_CODE_PLAN_APPROVE_CHOICE_FOOTER} anchors with `$`.
 *
 * @param tail - the frame's last rows, ANSI stripped, last content row last
 */
export function hasCommandCodeSelectionListFooterAtBottom(tail: string): boolean {
  return COMMAND_CODE_SELECTION_LIST_FOOTER.test(lastContentRows(tail, 1));
}

/**
 * Whether the LAST content row of this tail is the dismiss-only panel's footer
 * (Issue #2846). `Press Esc to close` is the panel's last row
 * ({@link DISMISSABLE_PANEL_FOOTER_PATTERN}); the same row inside a reply has
 * the composer under it.
 *
 * @param tail - the frame's last rows, ANSI stripped, last content row last
 */
export function hasCommandCodeDismissablePanelFooterAtBottom(tail: string): boolean {
  return DISMISSABLE_PANEL_FOOTER_PATTERN.test(lastContentRows(tail, 1));
}

/**
 * Whether the plan review footer ({@link COMMAND_CODE_PLAN_REVIEW_FOOTER}) sits
 * at the bottom of this tail (Issue #2846): both of its rows are within the last
 * {@link COMMAND_CODE_PLAN_REVIEW_TAIL_ROW_COUNT} content rows, which is the
 * overlay's own hint bar and nothing as tall as a composer.
 *
 * @param tail - the frame's last rows, ANSI stripped, last content row last
 */
export function hasCommandCodePlanReviewFooterAtBottom(tail: string): boolean {
  return COMMAND_CODE_PLAN_REVIEW_FOOTER.test(
    lastContentRows(tail, COMMAND_CODE_PLAN_REVIEW_TAIL_ROW_COUNT),
  );
}

/**
 * How many rows from the end of the content the dismiss footer is looked for.
 *
 * The same 15-row tail the detection chain hands a tool module as
 * `NormalizedFrame.lastLines` (`STATUS_CHECK_LINE_COUNT`), restated as a number
 * here because this module is a browser-safe leaf and `tools/frame.ts` pulls in
 * `cli-patterns`. `detect.ts` reads `frame.lastLines` and never this constant,
 * so the two cannot disagree about the detector's own window; this one bounds
 * the CLIENT-side reading in {@link hasDismissablePanelFooter}.
 */
const DISMISSABLE_PANEL_TAIL_LINE_COUNT = 15;

/**
 * Whether the tail of this frame is a dismiss-only panel (Issue #2369).
 *
 * The same question `commandCodeStatusDetector.afterPrompt` asks of
 * `frame.lastLines`, asked of a raw capture, so the chat surface can answer for
 * a frame whose server verdict has not reached it. The pattern is shared rather
 * than restated — one expression, two call sites, exactly as
 * {@link COMMAND_CODE_SELECTION_LIST_FOOTER} is shared between the detector and
 * the dialog card.
 *
 * @param frame - a raw `capture-pane -p -e` frame, ANSI intact
 */
export function hasDismissablePanelFooter(frame: string | null | undefined): boolean {
  if (!frame) return false;
  const lines = stripAnsi(frame.replace(/\r\n/g, '\n')).split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last -= 1;
  if (last < 0) return false;
  const tail = lines.slice(Math.max(0, last + 1 - DISMISSABLE_PANEL_TAIL_LINE_COUNT), last + 1);
  return tail.some((line) => DISMISSABLE_PANEL_FOOTER_PATTERN.test(line));
}

/**
 * The horizontal rule Command Code draws directly above a full-screen dialog.
 *
 * Command Code is an INLINE tool (`alternate_on=0`): opening `/model` does not
 * clear the pane, it paints the picker under whatever the session has already
 * printed. On the capture taken for Issue #2326 that is 256 rows of banner and
 * transcript followed by a 77-row picker, and this rule row is the seam between
 * them — 200 columns of U+2500 at the production `TUI_PANE_WIDTH`, the only
 * such row anywhere on the frame while the picker is open (the composer's own
 * two rules are not drawn while a dialog has the screen).
 *
 * Matched as "nothing but the rule glyph", not as "contains one", because a box
 * border (`╭──…──╮`, which is how copilot draws ITS pickers) carries corners and
 * must NOT be read as this seam — see
 * {@link extractCommandCodeSelectionListFrame} for why that non-match is the
 * safe answer rather than a missed case.
 */
export const COMMAND_CODE_RULE_ROW_PATTERN = /^\u2500+$/;

/**
 * How wide a rule row must be before it counts as the dialog seam.
 *
 * The measured row is the full pane width (200 columns), and a pure function
 * cannot know that width, so this is a floor rather than an equality: it only
 * has to reject a short dash run inside a reply. Forty columns is a quarter of
 * the production pane and wider than any decorative rule measured in
 * `tests/fixtures/`.
 */
export const COMMAND_CODE_RULE_MIN_COLUMNS = 40;

/**
 * The cursor glyph Command Code draws against the highlighted option.
 *
 * U+276F, measured on the capture Issue #2521 was raised from. Only this one,
 * and not codex's `›` or gemini's `●`: {@link readCommandCodeQuestionRegion}
 * counts cursors to decide whether the region holds ONE live dialog, and a
 * wider alphabet would start counting glyphs that are not cursors at all.
 */
export const COMMAND_CODE_CURSOR_GLYPH = '❯';

/**
 * The markers Command Code paints on a question screen's tab strip.
 *
 * Measured row: `● Dispatch | ◯ Review` — a filled disc on the tab that has the
 * screen and a hollow ring on the one that does not. The names are NOT part of
 * the reading (a different question draws different tabs); what is read is the
 * strip's structure, which is what {@link isCommandCodeQuestionTabRow} states.
 *
 * Two families rather than one alphabet, because "one of these is filled and one
 * of these is not" is the whole signal. A list of bullets (`● item one`) carries
 * the first family and nothing else, and a bullet list is the thing this
 * reading must never mistake for a dialog.
 */
const COMMAND_CODE_TAB_SELECTED_MARKERS = '●◉⦿';
/** The hollow half of {@link COMMAND_CODE_TAB_SELECTED_MARKERS}'s pair. */
const COMMAND_CODE_TAB_UNSELECTED_MARKERS = '◯○◌⚪';
/**
 * The ANSWERED half, measured on 1.54.1 (Issue #2753).
 *
 * A multi-question `AskUserQuestion` keeps one tab per question and marks the
 * ones already answered: `✔ Party size | ✔ Rental car | ● Update scope | ◯ Review`.
 * Before this family existed the whole strip failed the cell test, the reader answered
 * `none`, and the generic parser read the checkbox list under it as a single
 * select — see the Issue for the capture.
 *
 * U+2714 and nothing else. `✓` (U+2713) and `☑` (U+2611) are the shapes a check
 * mark could take; neither has been seen on a pane, and this reading is shared
 * with `ChatSurface` and `extractCommandCodeSelectionListFrame`, which run for
 * EVERY tool — so an unmeasured glyph here widens what other tools' frames can
 * be claimed as this screen.
 */
const COMMAND_CODE_TAB_ANSWERED_MARKERS = '✔';

/** One `<marker> <label>` cell of the tab strip. */
const COMMAND_CODE_TAB_SEGMENT_PATTERN = new RegExp(
  `^\\s*([${COMMAND_CODE_TAB_SELECTED_MARKERS}${COMMAND_CODE_TAB_UNSELECTED_MARKERS}${COMMAND_CODE_TAB_ANSWERED_MARKERS}])\\s+\\S`,
);

/**
 * Is this row Command Code's question-screen tab strip?
 *
 * Three conditions, and each one is a bullet list this predicate has to refuse:
 *
 *  - **two or more `|`-separated cells.** `● Dispatch` on its own is a bullet;
 *    `● Dispatch | ◯ Review` is a strip. The separator is the cheapest part of
 *    the structure and the one prose never has in this position;
 *  - **every cell is `<marker> <label>`.** A row that is a strip for its first
 *    cell and prose for its second is prose;
 *  - **at least one filled marker, and at least one other cell.** A tab strip
 *    says which tab has the screen. A row of identical bullets does not, and
 *    `● one | ● two` is exactly the list-with-a-pipe this rules out. The other
 *    cell may be hollow (not answered yet) or the `✔` of an answered tab
 *    (measured on 1.54.1 — Issue #2753); what may not be missing is the filled
 *    one, so `✔ one | ✔ two` is still refused.
 */
export function isCommandCodeQuestionTabRow(line: string): boolean {
  const segments = line.split('|');
  if (segments.length < 2) return false;
  let selected = 0;
  let others = 0;
  for (const segment of segments) {
    const match = COMMAND_CODE_TAB_SEGMENT_PATTERN.exec(segment);
    if (match === null) return false;
    if (COMMAND_CODE_TAB_SELECTED_MARKERS.includes(match[1])) selected += 1;
    else others += 1;
  }
  return selected > 0 && others > 0;
}

/**
 * Rows that mean the region spans more than the one dialog on screen now.
 *
 * Issue #2521's condition 4: the tab strip and its options have to be the
 * SAME screen, with no other turn's generating or completion UI between them.
 * Structurally that is mostly settled by taking the LAST rule row as the top
 * edge — a new turn repaints the composer, and the composer's own lower rule
 * then becomes that edge — so this pattern is the belt to that braces, for a
 * frame captured mid-repaint.
 *
 * Two rows, both restated here rather than imported: `cli-patterns` owns
 * Command Code's busy and marker vocabularies and pulls the logger and the tool
 * registry in with them, and this module is the browser-safe leaf the chat
 * surface imports (see the module docblock).
 *
 *  - `esc to interrupt`, the tail Command Code appends to every status row
 *    (`COMMAND_CODE_INTERRUPT_HINT_PATTERN`). A turn is in flight;
 *  - a row that OPENS with U+273B and a word — `✻ Thought for 1 second`,
 *    `✻ Worked for 4s`. Matched by shape rather than by the two English verbs,
 *    so a reworded or localised marker still ends the region.
 */
export const COMMAND_CODE_QUESTION_REGION_REJECT_PATTERN =
  /\besc\s+to\s+interrupt\b|^[^\S\n]*✻[^\S\n]+\S/im;

/**
 * Where a footer-less Command Code question screen is, once one is recognised.
 *
 * Line indices, not rows, and measured against the LF-normalised frame the
 * caller passed in — so the cropper can slice the ANSI-bearing lines and the
 * detector can answer a status from the same reading (Issue #2521).
 */
export interface CommandCodeQuestionRegion {
  /** The rule row that bounds the region above. NOT part of the region. */
  readonly ruleLineIndex: number;
  /** First row of the region, i.e. {@link ruleLineIndex} + 1. */
  readonly firstLineIndex: number;
  /** Last row of the region: the frame's last row carrying content. */
  readonly lastLineIndex: number;
  /** The tab strip — the region's first non-blank row. */
  readonly tabLineIndex: number;
  /** The row carrying the one cursor glyph. */
  readonly cursorLineIndex: number;
  /**
   * Whether {@link cursorLineIndex} is one of the NUMBERED rows (Issue #2755).
   *
   * False on the three rows 1.54.1 lets the `❯` rest on outside the list —
   * `Submit`, `Next` and the `notes:` input `n` opens. The region is still this
   * screen, and saying so is what stopped six measured captures being published
   * as finished turns (#2521's 偽完了); what it is NOT is an answerable reading,
   * because a digit sent while the cursor is off the list does nothing at all.
   * `tools/command-code/dialog.ts` declines those frames to the manual-operation
   * fallback rather than to `ready`.
   */
  readonly cursorOnOptionRow: boolean;
  /** How many options the question draws: 2…{@link MAX_OPTION_NUMBER}. */
  readonly optionCount: number;
}

/**
 * The Review page's own three rows, measured on 1.54.1 (Issue #2755 §7).
 *
 * `Enter` on the `Submit` row does not send the answers — it opens a SECOND
 * screen:
 *
 *     ✔ Update scope | ● Review
 *
 *     1. Which files should I update?
 *        calc.js
 *
 *     ❯ 1. Submit
 *       2. Cancel
 *
 *     ← to go back and edit
 *
 * ## Why this needs a reading of its own
 *
 * Because it is a real numbered list under a real tab strip, and the GENERIC
 * parser answers it: a two-option `multiple_choice` whose default is `Submit`.
 * The default answer on that payload does not pick anything — it COMMITS
 * whatever the human has ticked so far, from a payload nobody meant to expose,
 * which is #1928's shape one screen later. Auto-Yes fires on defaults.
 *
 * Words rather than structure, and deliberately: the two numbered rows are
 * `Submit` and `Cancel`, which is the same shape as any other two-option
 * question. What separates this page from a question is only what it SAYS, so
 * all three rows are required together — the confirm pair AND the back hint —
 * and the whole thing is anchored inside a recognised question region. A screen
 * that carries two of the three keeps every verdict it had.
 *
 * The cursor glyph is optional on both numbered rows: it rests on `1. Submit`
 * when the page is reached by `Enter`, and the Issue is explicit that a pattern
 * decided on the bare word would miss it.
 */
const COMMAND_CODE_REVIEW_SUBMIT_ROW_PATTERN =
  /^[^\S\n]*(?:\u276F[^\S\n]*)?1[.)][^\S\n]+Submit[^\S\n]*$/im;
/** The `Cancel` half of {@link COMMAND_CODE_REVIEW_SUBMIT_ROW_PATTERN}'s pair. */
const COMMAND_CODE_REVIEW_CANCEL_ROW_PATTERN =
  /^[^\S\n]*(?:\u276F[^\S\n]*)?2[.)][^\S\n]+Cancel[^\S\n]*$/im;
/** The footer only the Review page draws. */
const COMMAND_CODE_REVIEW_BACK_HINT_PATTERN =
  /^[^\S\n]*\u2190[^\S\n]+to[^\S\n]+go[^\S\n]+back[^\S\n]+and[^\S\n]+edit[^\S\n]*$/im;

/**
 * The warning the Review page carries when it was reached with answers missing.
 *
 * Measured from the undocumented `d`, which ends a multi-select from any row:
 * `⚠ You have not answered all questions` over a `No answer`. Issue #2755 §7
 * requires that such a page is never read as "answered", which is why the
 * predicate below reports it rather than hiding it.
 */
const COMMAND_CODE_REVIEW_UNANSWERED_PATTERN =
  /have\s+not\s+answered\s+all\s+questions/i;

/** What a frame's Review page says, when one is on it (Issue #2755). */
export interface CommandCodeReviewPage {
  /** True when `⚠ You have not answered all questions` is on the page. */
  readonly hasUnansweredWarning: boolean;
  /** True when the `❯` rests on `1. Submit`, i.e. an Enter would commit. */
  readonly cursorOnSubmit: boolean;
}

/**
 * Read Command Code's `AskUserQuestion` Review page, if this frame is one
 * (Issue #2755 §7).
 *
 * The same region {@link readCommandCodeQuestionRegion} works on — last rule
 * row, tab strip as the first row under it — plus the three rows above. The
 * question-shaped conditions are deliberately NOT applied: this page has no
 * question body of its own on the `Submit`/`Cancel` spelling (the answers sit
 * where the question would), and it draws `1.` twice, so the strict reading
 * declines it for a numbering reason that says nothing about what it is.
 *
 * `null` for everything else, so no existing verdict moves except the two
 * captures this is about.
 *
 * @param frame - a raw `capture-pane -p -e` frame, ANSI intact (CRLF tolerated)
 */
export function readCommandCodeReviewPage(
  frame: string | null | undefined,
): CommandCodeReviewPage | null {
  if (!frame) return null;
  const lines = frame.replace(/\r\n/g, '\n').split('\n').map(stripAnsi);

  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last -= 1;
  if (last < 1) return null;

  let ruleLineIndex = -1;
  for (let i = last - 1; i >= 0; i -= 1) {
    const row = lines[i].trim();
    if (row.length < COMMAND_CODE_RULE_MIN_COLUMNS) continue;
    if (!COMMAND_CODE_RULE_ROW_PATTERN.test(row)) continue;
    ruleLineIndex = i;
    break;
  }
  if (ruleLineIndex < 0) return null;

  const region = lines.slice(ruleLineIndex + 1, last + 1);
  const tabOffset = region.findIndex((line) => line.trim() !== '');
  if (tabOffset < 0) return null;
  if (!isCommandCodeQuestionTabRow(region[tabOffset])) return null;

  const body = region.join('\n');
  if (!COMMAND_CODE_REVIEW_SUBMIT_ROW_PATTERN.test(body)) return null;
  if (!COMMAND_CODE_REVIEW_CANCEL_ROW_PATTERN.test(body)) return null;
  if (!COMMAND_CODE_REVIEW_BACK_HINT_PATTERN.test(body)) return null;

  const submitRow = region.find((row) =>
    COMMAND_CODE_REVIEW_SUBMIT_ROW_PATTERN.test(row),
  );
  return {
    hasUnansweredWarning: COMMAND_CODE_REVIEW_UNANSWERED_PATTERN.test(body),
    cursorOnSubmit: submitRow !== undefined && submitRow.includes(COMMAND_CODE_CURSOR_GLYPH),
  };
}
