/**
 * What a selection-list frame OFFERS, read off the frame itself (Issue #2297).
 *
 * Issue #2254 gave the chat surface a dialog card, and gave every selection list
 * the same controls: `NavigationButtons`, i.e. ▲▼◀▶ Enter Esc. That is the right
 * verb for a moving highlight and it is not the whole story, because the TUIs
 * disagree about what CONFIRMS:
 *
 * | measured screen                     | what the footer says                                          |
 * |-------------------------------------|---------------------------------------------------------------|
 * | claude 2.1.259/2.1.260 `/model`     | `Enter to set as default · s to use this session only · Esc`   |
 * | codex 0.151.0 `/model`              | `Press enter to confirm or esc to go back`                     |
 * | copilot 1.0.80 `/permissions`       | `1-2 to select · ↑/↓ to navigate · enter to confirm · esc`     |
 * | copilot 1.0.80 `/model`             | `↑/↓ to navigate · … · enter to select · esc to cancel`, over a `❯  Search models…` row |
 * | Command Code 1.40.1 `/model`        | `type to search · ↑/↓ navigate · … · enter to select · esc`    |
 * | antigravity `Switch Model`          | name rows, no numbers                                          |
 *
 * So the surface cannot pick its buttons from the tool id. It picks them from
 * the frame it is already drawing, which is what this module reads.
 *
 * ## The three readings, and why each one is worth its own field
 *
 * **`optionCount`** — how many numbered options the dialog is offering, so the
 * card can put a `1`…`N` row under it and turn a seven-step arrow walk into one
 * tap. Zero means "no numbered list here", which is the honest answer for
 * antigravity's `Switch Model` and Command Code's name list, and those keep the
 * arrows they already work with.
 *
 * **`offersSessionScope`** — the footer names a key that takes the highlighted
 * row for THIS SESSION. Only claude's `/model` does, and it is the whole reason
 * Issue #2297 exists: `Enter` on that overlay rewrites `model` in
 * `~/.claude/settings.json` (Issue #1495) and `s` does not, and the chat surface
 * published the first and not the second.
 *
 * **`hasFilterInput`** — the dialog has a focused search box. This is the guard
 * that keeps `optionCount` from being a trap: on copilot's `/model` and Command
 * Code's picker a typed character goes into the filter, not into a selection, so
 * a number button there would silently type `4` into a search field.
 *
 * ## MEASURED: on claude's `/model`, a number key is not a cursor move
 *
 * Issue #2297's plan B reads "number buttons move the highlight, then the tool's
 * own confirm key commits". A live probe on claude 2.1.260 (private tmux socket,
 * 200x1000) says otherwise: pressing `4` on the `/model` overlay answered
 * `Set model to Sonnet 5 and saved as your default for new sessions` and
 * rewrote `~/.claude/settings.json` in one keystroke. The number key IS the
 * commit, and on that screen the commit is the global write the Issue is about.
 *
 * That is why {@link shouldOfferOptionNumbers} refuses the number row exactly
 * where {@link SelectionListShape.offersSessionScope} is true. On claude's
 * `/model` the card offers arrows plus the two LABELLED commits (`s` = this
 * session, `Enter` = set as default) and no unlabelled one-tap default write;
 * every other numbered list — codex's picker, copilot's `/permissions`, claude's
 * own `Enter to select`/`Enter to confirm` dialogs — keeps its numbers.
 *
 * ## Pure, leaf, browser-safe
 *
 * `./ansi` is the only import, exactly as `lib/terminal-display-normalize`
 * takes it: the consumer is `ChatSurface`, a client component, and pulling
 * `cli-patterns` (logger, tool registry types) into the browser bundle to reach
 * three regexes would be the wrong trade. The command-code detector imports
 * {@link COMMAND_CODE_SELECTION_LIST_FOOTER} back out of here so the pattern is
 * written once.
 */

import { stripAnsi } from './ansi';

/**
 * How many rows up from the last content row the shape is read.
 *
 * The dialog is at the END of the content on every capture measured for Issue
 * #2254 — including the top-anchored ones, where "the end of the content" is
 * row 32 of a 1000-row pane and everything below it is padding. Forty rows
 * covers the tallest dialog in `tests/fixtures/chat-dialog-card-2254/`
 * (copilot's `/theme` panel is 15 rows, Command Code's provider-grouped model
 * list is ~70 and is deliberately NOT fully covered — see `optionCount`, which
 * wants the run nearest the footer rather than every number on the pane).
 *
 * Bounded rather than unbounded because the alternative reads the transcript: a
 * markdown answer that happens to contain `1.` / `2.` sits hundreds of rows
 * above the dialog on a 200x1000 pane and must not be counted as options.
 */
export const SELECTION_SHAPE_TAIL_LINE_COUNT = 40;

/** Highest option number a single keystroke can deliver (`10` is two keys). */
export const MAX_OPTION_NUMBER = 9;

/**
 * One numbered option row.
 *
 * The prefix is `[^0-9A-Za-z]*` rather than `\s*` because every measured dialog
 * puts something in front of the number: a selection caret (`❯` claude/copilot,
 * `›` codex, `●` gemini), a panel border (`│` copilot's boxed pickers), or a
 * bullet. Requiring a non-alphanumeric prefix is what keeps `id 3. foo` and a
 * wrapped sentence ending in a digit out.
 *
 * The trailing `\s+\S` requires the option to have a LABEL, which is what stops
 * a diff gutter (`5 -   export default getUser;`, live in
 * `copilot-picker-1895/picker-theme.txt`) from matching: it has no `.` or `)`
 * after the digit, and this pattern requires one.
 */
const OPTION_ROW_PATTERN = /^[^0-9A-Za-z]*([1-9])[.)]\s+\S/;

/**
 * claude's session-scope footer, verbatim from the live captures.
 *
 * `s to use this session only`. Not anchored to a line start because the footer
 * shares its row with the other two hints.
 */
export const SESSION_SCOPE_FOOTER_PATTERN = /\bs\s+to\s+use\s+this\s+session\s+only\b/i;

/**
 * The footer half that says `Enter` writes a default rather than confirming.
 *
 * Kept separate from {@link SESSION_SCOPE_FOOTER_PATTERN} so the card can label
 * the two buttons from what the frame actually claims, instead of asserting
 * claude's wording for a screen that may not carry it.
 */
export const SET_AS_DEFAULT_FOOTER_PATTERN = /\bEnter\s+to\s+set\s+as\s+default\b/i;

/**
 * A focused search/filter row inside the dialog.
 *
 * Three measured spellings, and nothing wider — this predicate SUPPRESSES a
 * control, so a false positive costs the user their number buttons:
 *  - `Type to search models...` / `type to search` (Command Code 1.40.1);
 *  - `Search models…` (copilot 1.0.80's `/model`, recorded verbatim in
 *    `cli-patterns.ts`'s `COPILOT_SELECTION_FOOTER_PATTERN` docblock);
 *  - `/ search` (copilot's `/session` and `/settings` footers).
 *
 * Deliberately does NOT match claude's `/model` blurb ("Switch between Claude
 * models…") or codex's ("Access legacy models by running codex -m…"), neither of
 * which contains the word.
 */
const FILTER_INPUT_PATTERN =
  /\btype\s+to\s+search\b|\bsearch\s+\w+\s*(?:…|\.\.\.)|(?:^|·)\s*\/\s+search\b/im;

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
const COMMAND_CODE_RULE_ROW_PATTERN = /^\u2500+$/;

/**
 * How wide a rule row must be before it counts as the dialog seam.
 *
 * The measured row is the full pane width (200 columns), and a pure function
 * cannot know that width, so this is a floor rather than an equality: it only
 * has to reject a short dash run inside a reply. Forty columns is a quarter of
 * the production pane and wider than any decorative rule measured in
 * `tests/fixtures/`.
 */
const COMMAND_CODE_RULE_MIN_COLUMNS = 40;

/**
 * The cursor glyph Command Code draws against the highlighted option.
 *
 * U+276F, measured on the capture Issue #2521 was raised from. Only this one,
 * and not codex's `›` or gemini's `●`: {@link readCommandCodeQuestionRegion}
 * counts cursors to decide whether the region holds ONE live dialog, and a
 * wider alphabet would start counting glyphs that are not cursors at all.
 */
const COMMAND_CODE_CURSOR_GLYPH = '❯';

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

/** One `<marker> <label>` cell of the tab strip. */
const COMMAND_CODE_TAB_SEGMENT_PATTERN = new RegExp(
  `^\\s*([${COMMAND_CODE_TAB_SELECTED_MARKERS}${COMMAND_CODE_TAB_UNSELECTED_MARKERS}])\\s+\\S`,
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
 *  - **at least one filled marker and at least one hollow one.** A tab strip
 *    says which tab has the screen. A row of identical bullets does not, and
 *    `● one | ● two` is exactly the list-with-a-pipe this rules out.
 */
function isCommandCodeQuestionTabRow(line: string): boolean {
  const segments = line.split('|');
  if (segments.length < 2) return false;
  let selected = 0;
  let unselected = 0;
  for (const segment of segments) {
    const match = COMMAND_CODE_TAB_SEGMENT_PATTERN.exec(segment);
    if (match === null) return false;
    if (COMMAND_CODE_TAB_SELECTED_MARKERS.includes(match[1])) selected += 1;
    else unselected += 1;
  }
  return selected > 0 && unselected > 0;
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
const COMMAND_CODE_QUESTION_REGION_REJECT_PATTERN =
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
  /** The option row carrying the one cursor glyph. */
  readonly cursorLineIndex: number;
  /** How many options the question draws: 2…{@link MAX_OPTION_NUMBER}. */
  readonly optionCount: number;
}

/**
 * Where a footer-less Command Code question screen sits on a pane (Issue #2521).
 *
 * ## The frame this exists for
 *
 * Command Code's `AskUserQuestion` draws no hint-bar footer. It draws a rule,
 * a tab strip, the question, and the options — and when an option's description
 * WRAPS, the continuation row begins with a single space:
 *
 *     ────────────────────────────… (200 columns of U+2500)
 *     ● Dispatch | ◯ Review
 *
 *     Approve proceeding from the plan into worktree creation and dispatch?
 *
 *     ❯ 1. Prepare worktrees + dispatch (Recommended)
 *          I create the worktrees and pause for you to
 *      answer).
 *       2. Worktrees only, then pause
 *     …
 *
 * Measured 2026-09-12 on a pane reported as Command Code 1.53.0 at the
 * production 200x1000; the anonymised capture is
 * `tests/fixtures/command-code-askuserquestion-2521/`. Nothing read it:
 * `detectPrompt` stops its scan at ` answer).` and never reaches option 1, and
 * the selection-list branch below wants a footer this screen does not draw. So
 * the frame fell through to the generic composer check — which matches, because
 * `COMMAND_CODE_PROMPT_PATTERN` is `^❯(\s*$|\s+\S)` and `❯ 1. Prepare …` is a
 * `❯` followed by a space and a glyph — and the pane was published as
 * `ready` / `input_prompt`. `wait` read that as a finished turn and exited 0 on
 * a session that was asking a question (Issue #2521's "偽完了").
 *
 * ## What this function is NOT
 *
 * It is not a general reading of footer-less dialogs, and it deliberately does
 * not make `optionCount` into a dialog test. {@link readSelectionListShape}
 * counts the numbers in the tail of ANY frame, an ordinary numbered answer
 * included, and the whole point of the conditions below is that a number list
 * on its own proves nothing. Five things have to line up:
 *
 *  1. the LAST rule row that qualifies as the seam ({@link
 *     COMMAND_CODE_RULE_ROW_PATTERN} at {@link COMMAND_CODE_RULE_MIN_COLUMNS} or
 *     wider) is the top edge, and the last row carrying content is the bottom.
 *     Taking the LAST one is what keeps an older dialog higher up the pane out:
 *     a new turn repaints the composer, whose own rules sit below the old
 *     dialog, and the region is then the composer's hint row;
 *  2. the first row under that rule is a tab strip
 *     ({@link isCommandCodeQuestionTabRow}) and a non-blank question body
 *     follows it before the first option;
 *  3. the options are a STRICT run `1.` … `N.`, 2 ≤ N ≤ {@link
 *     MAX_OPTION_NUMBER}. A gap, a repeat or a list that starts at `2` is not
 *     this screen;
 *  4. exactly one {@link COMMAND_CODE_CURSOR_GLYPH} in the region, and it is on
 *     an option row. Two cursors means two screens — typically a composer's own
 *     `❯` under the dialog — and none means the highlight is elsewhere;
 *  5. no filter box, no `/model` footer, no dismiss-only footer and no other
 *     turn's UI in the region ({@link FILTER_INPUT_PATTERN},
 *     {@link COMMAND_CODE_SELECTION_LIST_FOOTER},
 *     {@link DISMISSABLE_PANEL_FOOTER_PATTERN},
 *     {@link COMMAND_CODE_QUESTION_REGION_REJECT_PATTERN}). `Type something...`
 *     is an OPTION on this screen, not a filter, and the filter pattern is
 *     narrow enough to tell them apart.
 *
 * `null` for anything else, which leaves every existing verdict and every
 * existing crop exactly as they were.
 *
 * ## Tool-id-free and browser-safe, on purpose
 *
 * Three call sites read the same answer: the command-code detector's
 * `afterPrompt`, {@link extractCommandCodeSelectionListFrame} (which runs for
 * every CLI, with no tool id in hand) and `ChatSurface`, a client component.
 * So this takes a raw frame and nothing else, and imports nothing but
 * `./ansi` — the same trade the rest of this module makes.
 *
 * ## The one spelling it cannot answer on
 *
 * A capture that has been through `stripBoxDrawing` — which blanks a pure-U+2500
 * row, so condition 1 finds no seam and this returns `null`. Same limitation
 * `extractOpenCodeModalOverlayFrame` records for the same reason. Issue #2522
 * did not weaken the reading to work around it: the three consumers that clean
 * their frames (the response poller, Auto-Yes, `/prompt-response`) now keep the
 * same tick's RAW capture and hand that here, so both spellings of one capture
 * exist and the right one is passed.
 *
 * ## Issue #2522: the structural half is shared
 *
 * Conditions 1, 2, 3-minus-strictness and 5 moved into
 * {@link scanCommandCodeQuestionScreen}, which {@link hasCommandCodeQuestionChrome}
 * also reads. This function is exactly that scan plus the two conditions that
 * are about the LIST — a strict run and a single cursor — so every verdict it
 * gave before is the verdict it gives now.
 *
 * @param frame - a raw `capture-pane -p -e` frame, ANSI intact (CRLF tolerated)
 * @returns the region's line indices into the LF-normalised frame, or `null`
 */
export function readCommandCodeQuestionRegion(
  frame: string | null | undefined,
): CommandCodeQuestionRegion | null {
  const screen = scanCommandCodeQuestionScreen(frame);
  if (screen === null) return null;

  // 3 (continued). A STRICT run. The numbers were collected in the order they
  // are drawn and are compared against the run, rather than restarted on every
  // fresh `1` the way `countTrailingOptionRun` does: that function is reading a
  // tail that may hold two lists, and this one is asserting that the region
  // holds exactly one.
  if (!screen.numbers.every((value, index) => value === index + 1)) return null;

  // 4 (continued). Exactly ONE cursor. Two means two screens — typically a
  // composer's own `❯` under the dialog, or a frame caught mid-repaint.
  if (screen.cursorCount !== 1) return null;

  return {
    ruleLineIndex: screen.ruleLineIndex,
    firstLineIndex: screen.firstLineIndex,
    lastLineIndex: screen.lastLineIndex,
    tabLineIndex: screen.tabLineIndex,
    cursorLineIndex: screen.cursorLineIndex,
    optionCount: screen.numbers.length,
  };
}

/**
 * Is Command Code's question CHROME on this frame, whatever its numbering says?
 * (Issue #2522)
 *
 * The same five conditions {@link readCommandCodeQuestionRegion} applies, minus
 * the two that are about the LIST rather than about the screen: the run need not
 * be a strict `1.`…`N.`, and there may be more than one cursor on it.
 *
 * ## Why the weaker reading is worth having
 *
 * Issue #2522 確定仕様 B needs three answers where #2521 had two. "Not this
 * screen" keeps every existing verdict; "read in full" produces an answerable
 * prompt; and **"this screen, unreadable"** — a gap in the numbering, a repeated
 * row, a list that starts at `2`, a second cursor from a half-finished repaint —
 * has to reach the manual-operation fallback rather than the `ready` the generic
 * composer check would otherwise publish off the dialog's own `❯` row. That is
 * the very failure both Issues exist for: `wait` exiting 0 on a pane that is
 * asking a human a question.
 *
 * It is deliberately NOT a relaxation of the strict reading. Nothing that was
 * `null` becomes a REGION, so no partial option list is produced anywhere and no
 * existing crop, card or prompt payload changes. What this adds is the ability
 * to say "declined for a numbering reason" out loud.
 *
 * ## Why it is still narrow
 *
 * Every structural condition stays: the last qualifying rule row, a genuine tab
 * strip as the first row under it ({@link isCommandCodeQuestionTabRow} — one
 * filled marker, one hollow, `|`-separated), a non-blank question body before
 * the first option, at least two numbered rows, at least one `❯` ON one of them,
 * and none of the pickers, panels or other-turn UI the other branches own. An
 * assistant answering in a numbered list carries none of that, and a frame with
 * one option or with the `❯` on a composer row is still `false` — the two cases
 * #2521 recorded as "the highlight is elsewhere".
 *
 * @param frame - a raw `capture-pane -p -e` frame, ANSI intact (CRLF tolerated)
 */
export function hasCommandCodeQuestionChrome(frame: string | null | undefined): boolean {
  return scanCommandCodeQuestionScreen(frame) !== null;
}

/** What {@link scanCommandCodeQuestionScreen} read off one frame. */
interface CommandCodeQuestionScreen {
  readonly ruleLineIndex: number;
  readonly firstLineIndex: number;
  readonly lastLineIndex: number;
  readonly tabLineIndex: number;
  /** The option numbers, in draw order. NOT asserted to be a strict run. */
  readonly numbers: readonly number[];
  /** How many {@link COMMAND_CODE_CURSOR_GLYPH} the region carries. */
  readonly cursorCount: number;
  /** The LAST option row carrying a cursor. */
  readonly cursorLineIndex: number;
}

/**
 * The structural half of the question-screen reading, shared by the strict
 * {@link readCommandCodeQuestionRegion} and the weaker
 * {@link hasCommandCodeQuestionChrome} (Issue #2522 split them apart).
 *
 * Written once rather than twice on purpose: the conditions below are what make
 * the reading safe for every other CLI's frames, and a second copy of them is a
 * second thing to forget to narrow.
 */
function scanCommandCodeQuestionScreen(
  frame: string | null | undefined,
): CommandCodeQuestionScreen | null {
  if (!frame) return null;
  // Stripped per line off the same split, so every index below is valid against
  // the ANSI-bearing rows the cropper slices.
  const lines = frame.replace(/\r\n/g, '\n').split('\n').map(stripAnsi);

  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last -= 1;
  // A region needs a rule above it, so the last content row cannot be row 0.
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
  const body = region.join('\n');

  // 5. The screens this reading must not take over.
  if (FILTER_INPUT_PATTERN.test(body)) return null;
  if (COMMAND_CODE_SELECTION_LIST_FOOTER.test(body)) return null;
  if (DISMISSABLE_PANEL_FOOTER_PATTERN.test(body)) return null;
  if (COMMAND_CODE_QUESTION_REGION_REJECT_PATTERN.test(body)) return null;

  // 2. The tab strip opens the region.
  const tabOffset = region.findIndex((line) => line.trim() !== '');
  if (tabOffset < 0) return null;
  if (!isCommandCodeQuestionTabRow(region[tabOffset])) return null;

  // 3. Numbered rows under it.
  const numbers: number[] = [];
  let firstOptionOffset = -1;
  for (let i = tabOffset + 1; i < region.length; i += 1) {
    const match = OPTION_ROW_PATTERN.exec(region[i]);
    if (match === null) continue;
    if (firstOptionOffset < 0) firstOptionOffset = i;
    numbers.push(Number(match[1]));
  }
  // Two is the floor: one numbered row under a tab strip is not a choice. The
  // ceiling is {@link MAX_OPTION_NUMBER} and it is {@link OPTION_ROW_PATTERN}'s
  // rather than a length check — that pattern captures a SINGLE digit, so a
  // `10.` row is not read as an option at all and an eleven-option screen
  // reports its first nine. Recognising such a screen and under-counting it is
  // the right failure: declining it would put the pane back on the `ready` that
  // made `wait` exit 0. (Issue #2522's reader cross-checks the count against its
  // own block reading and declines to ANSWER such a screen; what it must not do
  // is hand the pane back to the composer check.)
  if (numbers.length < 2) return null;

  // 2 (continued). The question itself. A tab strip sitting straight on top of
  // its options is some other screen.
  if (!region.slice(tabOffset + 1, firstOptionOffset).some((line) => line.trim() !== '')) {
    return null;
  }

  // 4. A cursor, on an option row.
  let cursorCount = 0;
  let cursorOffset = -1;
  for (let i = 0; i < region.length; i += 1) {
    const inRow = region[i].split(COMMAND_CODE_CURSOR_GLYPH).length - 1;
    if (inRow === 0) continue;
    cursorCount += inRow;
    if (OPTION_ROW_PATTERN.test(region[i])) cursorOffset = i;
  }
  if (cursorCount === 0 || cursorOffset < 0) return null;

  return {
    ruleLineIndex,
    firstLineIndex: ruleLineIndex + 1,
    lastLineIndex: last,
    tabLineIndex: ruleLineIndex + 1 + tabOffset,
    numbers,
    cursorCount,
    cursorLineIndex: ruleLineIndex + 1 + cursorOffset,
  };
}

/**
 * The rows of a Command Code dialog, cut out of the pane it is painted on
 * (Issue #2326).
 *
 * ## Why the dialog card needs a rectangle here at all
 *
 * Issue #2309 gave a selection list every compacted row of the frame instead of
 * a 12–20 row tail, because a search-type picker is tens of rows long and a
 * tail slice threw away rows the arrows could still reach. That is right for a
 * tool that clears the screen. Command Code does not: measured on 2026-09-05
 * (v1.47.1, private socket, 200x1000), a five-turn session with `/model` open
 * gives a 333-row frame of which **256 rows are banner and transcript** and 77
 * are the picker. The card drew all 333, so the picker sat below the fold and
 * the arrow-moved highlight — which {@link findHighlightLineIndex} does now
 * locate correctly, Issue #2323 — was scrolled to inside a box whose visible
 * thirty rows were somebody's earlier conversation.
 *
 * `extractOpenCodeModalOverlayFrame` solves the same problem for opencode by
 * reading its painted rectangle. Command Code paints no rectangle (only the
 * selected ROW carries a background, which is exactly what #2323 turned into
 * the highlight rule), so the seam is read from the two things the picker draws
 * that the transcript does not: the rule above it, and the footer below it.
 *
 * ## The cut
 *
 * Bottom edge: the LAST row matching {@link COMMAND_CODE_SELECTION_LIST_FOOTER}
 * — the same pattern the command-code detector already classifies the screen
 * with, so the card cannot disagree with the detector about whether a picker is
 * up. Top edge: the row AFTER the nearest {@link COMMAND_CODE_RULE_ROW_PATTERN}
 * above that footer (the rule itself is the transcript's boundary, not the
 * dialog's first row; the blank that usually follows it is dropped by the
 * caller's blank-run compaction).
 *
 * ## Both non-matches are the safe answer
 *
 * `null` means "do not crop", and the caller then behaves exactly as it did
 * before this Issue. Two frames take that path deliberately:
 *
 *  - **no footer** — the picker was closed between the flags being read and the
 *    pane being captured, or the frame is some other dialog. Cropping on a
 *    guess would blank the card, which Issue #2326 calls out as worse than
 *    showing too much. Issue #2521 carved ONE screen out of this: a frame that
 *    {@link readCommandCodeQuestionRegion} positively recognises is cropped to
 *    that region, because `AskUserQuestion` draws no footer at all and its card
 *    was otherwise the whole pane. The carve-out is a positive reading, not a
 *    relaxation — everything it declines still lands here;
 *  - **a footer but no rule above it** — copilot's `/model` footer is
 *    `↑/↓ to navigate · … · enter to select · esc to cancel` and matches the
 *    same pattern, but copilot draws its picker in a corner-bordered box, so no
 *    row is nothing-but-rule and copilot's card is returned untouched. Verified
 *    on every committed fixture by `dialog-frame-2326.test.ts`.
 *
 * The one degradation this accepts: if the picker's own rule has scrolled off
 * the top of the capture, the nearest rule above the footer is an older one and
 * the crop keeps some transcript. That is strictly less than the whole pane,
 * which is what the frame would otherwise be.
 *
 * @param frame - a raw `capture-pane -p -e` frame, ANSI intact
 * @returns the dialog's own rows, ANSI intact, or `null` to crop nothing
 */
export function extractCommandCodeSelectionListFrame(frame: string): string | null {
  const lines = frame.replace(/\r\n/g, '\n').split('\n');

  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (COMMAND_CODE_SELECTION_LIST_FOOTER.test(stripAnsi(lines[i]))) {
      footer = i;
      break;
    }
  }
  // Issue #2521: no footer is no longer unconditionally "do not crop". One
  // screen draws none — `AskUserQuestion` — and it is the screen whose
  // uncropped card was 409 rows of transcript with the question below the fold.
  // The reading is the narrow one, so every other footer-less frame (a closed
  // picker, a permission dialog, another CLI's overlay) still takes the `null`
  // path and is returned untouched. Checked only when the footer is absent, so
  // a picker's own crop is decided exactly as #2326 left it.
  if (footer < 0) {
    const region = readCommandCodeQuestionRegion(frame);
    if (region === null) return null;
    // The rule row itself is the transcript's boundary and not the dialog's
    // first row — the same edge the footer path takes — and `lastLineIndex` is
    // the last row with content, so the pane's trailing padding is left out.
    return lines.slice(region.firstLineIndex, region.lastLineIndex + 1).join('\n');
  }

  for (let i = footer - 1; i >= 0; i -= 1) {
    const row = stripAnsi(lines[i]).trim();
    if (row.length < COMMAND_CODE_RULE_MIN_COLUMNS) continue;
    if (!COMMAND_CODE_RULE_ROW_PATTERN.test(row)) continue;
    return lines.slice(i + 1, footer + 1).join('\n');
  }
  return null;
}

/** What the dialog card can offer for this frame. */
export interface SelectionListShape {
  /**
   * Options `1`…`optionCount`, or `0` when the dialog is not a numbered list.
   *
   * The LAST ascending run in the tail, so codex's startup `Update available!`
   * box — which sits above the picker on a real launch frame and is the trap
   * Issue #2297 calls out by name — cannot contribute its rows to the count.
   */
  optionCount: number;
  /** The footer names a key that applies the choice to this session only. */
  offersSessionScope: boolean;
  /** The footer says `Enter` writes a default rather than merely confirming. */
  commitsDefaultOnEnter: boolean;
  /** A search/filter box is on the dialog, so a typed character is not a choice. */
  hasFilterInput: boolean;
}

/** The reading for a frame that carries no dialog at all. */
const EMPTY_SHAPE: SelectionListShape = {
  optionCount: 0,
  offersSessionScope: false,
  commitsDefaultOnEnter: false,
  hasFilterInput: false,
};

/** The last {@link SELECTION_SHAPE_TAIL_LINE_COUNT} rows that carry content. */
function tailLines(frame: string): string[] {
  const lines = stripAnsi(frame.replace(/\r\n/g, '\n')).split('\n');
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last -= 1;
  if (last < 0) return [];
  return lines.slice(Math.max(0, last + 1 - SELECTION_SHAPE_TAIL_LINE_COUNT), last + 1);
}

/**
 * Count the LAST run of option rows numbered `1, 2, 3, …`.
 *
 * Restarting the run on every fresh `1` is what makes the codex launch frame
 * safe: whatever numbered rows preceded the picker, the count that survives is
 * the one belonging to the run nearest the footer. A number out of sequence ends
 * the run without erasing what it had already reached, so copilot's `/session`
 * list — which numbers past `9` — still reports its first nine.
 */
function countTrailingOptionRun(lines: readonly string[]): number {
  let reached = 0;
  let running = 0;
  for (const line of lines) {
    const match = OPTION_ROW_PATTERN.exec(line);
    if (match === null) continue;
    const value = Number(match[1]);
    if (value === running + 1) {
      running = value;
      reached = value;
    } else if (value === 1) {
      running = 1;
      reached = 1;
    } else {
      running = 0;
    }
  }
  return Math.min(reached, MAX_OPTION_NUMBER);
}

/**
 * Read what the dialog on this frame offers.
 *
 * @param frame - a raw `capture-pane -p -e` frame (`PaneTerminalState.output`)
 * @returns the shape; all-false / zero for an empty or missing frame
 */
export function readSelectionListShape(frame: string | null | undefined): SelectionListShape {
  if (!frame) return EMPTY_SHAPE;
  const lines = tailLines(frame);
  if (lines.length === 0) return EMPTY_SHAPE;
  const tail = lines.join('\n');
  return {
    optionCount: countTrailingOptionRun(lines),
    offersSessionScope: SESSION_SCOPE_FOOTER_PATTERN.test(tail),
    commitsDefaultOnEnter: SET_AS_DEFAULT_FOOTER_PATTERN.test(tail),
    hasFilterInput: FILTER_INPUT_PATTERN.test(tail),
  };
}

/**
 * Whether the card may draw a `1`…`N` row for this shape.
 *
 * Two refusals, both measured rather than defensive:
 *
 *  - **a session-scope footer.** On claude's `/model` a number key commits AND
 *    rewrites the global default in one press (probed live on 2.1.260), so a
 *    number button there is an unlabelled version of the exact write Issue
 *    #2297 is about. That screen gets the two labelled commit buttons instead.
 *  - **a filter input.** copilot's `/model` and Command Code's picker put a
 *    focused search box on the dialog, where a `4` is four characters of a
 *    query and not the fourth model.
 */
export function shouldOfferOptionNumbers(shape: SelectionListShape): boolean {
  return shape.optionCount > 0 && !shape.offersSessionScope && !shape.hasFilterInput;
}
