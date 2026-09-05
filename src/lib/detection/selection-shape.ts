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
 *    showing too much;
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
  if (footer < 0) return null;

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
