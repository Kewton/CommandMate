/**
 * Antigravity (agy) pattern constants and helpers moved out of `../../cli-patterns.ts`
 * (Issue #3217). `cli-patterns.ts` re-exports every public name.
 */

import { PASTED_TEXT_PATTERN } from '../../shared/pasted-text';

/**
 * The banner agy paints INTO its empty input box while a non-default permission
 * mode is on (Issue #2592).
 *
 * Measured on agy 1.2.4 in the #2592 UAT
 * (`tests/fixtures/agent-mode-2592/antigravity-{accept-edits,plan}.txt`, row 18,
 * between the box's two rules):
 *
 *   `> Accept-edits mode: file edits auto-approved (shift+tab to cycle)`
 *   `> Plan mode: research & plan only (shift+tab to cycle)`
 *
 * It takes the place of the bare `>` an empty box shows in default — it is a
 * placeholder, not typed text — so a reader that only accepts the bare glyph
 * reads an idle accept-edits / plan pane as "no input box at all". Before this
 * pattern existed that is exactly what happened: the status detector fell through
 * to its `default` floor (`running` + `isUnclassifiedActive`), `commandmate ls`
 * showed a resting agent as running, `wait` never completed, and
 * `isAntigravityReady` refused every send. #2592 made those two modes one click
 * away, so the hole had to close with it.
 *
 * The structure is matched rather than the two sentences: `<Name> mode: <text>
 * (shift+tab to cycle)`, anchored on the key hint agy ends every banner with, so
 * a third mode needs no edit here. What stays out is anything a user could have
 * typed into the box — the trailing hint is the part nobody types.
 *
 * Whole-row, no `/g`, no nested quantifiers (`[^\n]*` is followed by a literal).
 */
export const ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE =
  '>[^\\S\\n]+[A-Z][A-Za-z-]*[^\\S\\n]mode:[^\\n]*\\(shift\\+tab to cycle\\)[^\\S\\n]*';

/** {@link ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE} as a single-row pattern. */
export const ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN = new RegExp(
  `^${ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE}$`,
  'm',
);

/**
 * Antigravity (agy) interactive REPL prompt pattern (Issue #988)
 * agy shows a bare ">" input box line when waiting for user input. The input box
 * is always rendered (even while generating), so prompt presence alone does not
 * mean "ready" — running vs idle is resolved together with the thinking pattern /
 * footer status bar in status-detector.ts. (Confirmed on machine: line is "> ".)
 *
 * Issue #2592: or the mode banner that replaces the bare glyph in an EMPTY box
 * while accept-edits / plan is on ({@link ANTIGRAVITY_COMPOSER_MODE_BANNER_PATTERN}).
 * Every consumer of this pattern is asking "is agy's input box drawn and empty?"
 * — the idle rule in `detection/tools/antigravity/detect.ts`, the survey guard
 * beside it, `isAntigravityReady` (the send gate) and the liveness probe — and
 * the answer does not depend on the permission mode, so the banner is folded in
 * here once rather than at each of them.
 */
export const ANTIGRAVITY_PROMPT_PATTERN = new RegExp(
  `^(?:>\\s*|${ANTIGRAVITY_COMPOSER_MODE_BANNER_SOURCE})$`,
  'm',
);

/**
 * Antigravity (agy) thinking/processing pattern (Issue #988)
 * While generating, agy shows a braille spinner with "Generating..." in the
 * conversation area and an "esc to cancel" hint in the footer status bar. When
 * idle the footer shows "? for shortcuts" instead, so "esc to cancel" is a
 * reliable running signal. Braille spinner chars (U+2800-U+28FF) also matched.
 */
export const ANTIGRAVITY_THINKING_PATTERN = /[\u2800-\u28FF]|Generating|esc to cancel/;

/**
 * Antigravity (agy) separator pattern (Issue #988)
 * agy draws turn separators and the input-box border with runs of U+2500 (─).
 */
export const ANTIGRAVITY_SEPARATOR_PATTERN = /^─{3,}$/m;

/**
 * Antigravity (agy) selection list pattern (Issue #995, broadened in #997)
 * Detects agy's interactive arrow-key selection TUIs (e.g. the "Switch Model"
 * model picker, the "Do you want to proceed?" permission-approval menu). Their
 * footer status bar renders "esc to cancel", which ANTIGRAVITY_THINKING_PATTERN
 * also matches, so this pattern must be checked BEFORE thinking detection in
 * status-detector.ts to keep the selection screen from being misreported as
 * "generating".
 *
 * Matches (either is sufficient):
 *   - The "Switch Model" header of the model picker.
 *   - The "↑/↓ Navigate" arrow-key navigation hint, common to every agy
 *     selection TUI footer. Issue #995 originally required an "enter Select"
 *     hint too, but the permission-approval menu footer is
 *     "↑/↓ Navigate · tab Amend · ctrl+g … · ctrl+r Review" (no "enter Select"),
 *     so #997 relaxes this to the "↑/↓ Navigate" footer alone. This covers the
 *     Switch Model picker, permission-approval menus, and future agy selection
 *     TUIs in one shot, while staying agy-specific (the cliToolId === 'antigravity'
 *     guard in status-detector.ts keeps other tools unaffected).
 *
 * No /g flag (S4-5: would make test() stateful).
 * No `.*` at all (SEC4-001: ReDoS safe — strictly safer than the #995 form).
 */
export const ANTIGRAVITY_SELECTION_LIST_PATTERN = /Switch Model|↑\/↓\s*Navigate/m;

/**
 * The `↑/↓ Navigate` hint agy draws under every arrow-key screen it owns
 * (Issue #2364; measured on agy 1.1.27, pane 200x1000, 2026-09-06).
 *
 * The same token {@link ANTIGRAVITY_SELECTION_LIST_PATTERN} matches, split out
 * because the numbered-dialog reader anchors on THIS row and reads upward from
 * it. It is the one thing all four measured agy dialogs share — the `Do you want
 * to proceed?` command menu, the `Allow creation of this file?` file menu, the
 * folder-trust screen and the `/model` picker all end on it — while the words
 * after it differ on every one (`tab Amend · f full diff`, `tab Amend · ctrl+g
 * edit/expand command`, `enter Confirm`, `←/→ Effort  enter Select`).
 */
export const ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN = /↑\/↓\s*Navigate/;

/**
 * One numbered option row of agy's dialogs: `> 1. Yes`, `  4. No`,
 * `  2. No, deny creation`.
 *
 * The `>` gutter marks the highlighted row and is optional, because only one
 * of the rows carries it.
 */
export const ANTIGRAVITY_NUMBERED_OPTION_PATTERN = /^\s*>?\s*\d+\.\s+\S/m;

/**
 * The header of agy's `/model` picker (Issue #995).
 *
 * Kept as its own exclusion even though the picker's rows already fail the
 * numbered-row test: the Issue #2364 rule is written as "footer + numbered rows
 * + NOT the Switch Model picker", and the picker is the one agy screen whose
 * misreading has a measured cost (#995: NavigationButtons vanished).
 */
export const ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN = /^\s*Switch Model\s*$/;

/**
 * A row that ends the dialog block when reading UPWARD from the footer
 * (Issue #2364).
 *
 * Everything agy draws above its own dialog panel carries one of these:
 *
 *  - a horizontal rule (the turn separator, the input-box border, or the rule
 *    under the `Command` / `Create file` panel header);
 *  - a `>`-prefixed row that is not a numbered option — the echoed user prompt,
 *    the bare composer, the highlighted row of an UNNUMBERED picker (`> Gemini
 *    3.8 Flash`, `> Yes, I trust this folder`) or of the slash-command popup
 *    (`> /add-dir  Add a directory …`);
 *  - a `●` tool-call row, a `⎿` tool-result row or a `▸ Thought for …` row.
 *
 * Bounding the block at the nearest one is what keeps a numbered list in the
 * MODEL'S PROSE, sitting in the transcript above an open picker or popup, from
 * being adopted as that screen's options. Wrapped option labels never start
 * with any of these on the measured frames: agy prints the command text inside
 * the quotes of `… commands that start with '<cmd>'`, indented under the row
 * that opened it.
 *
 * `stripBoxDrawing` blanks the rule rows before the response poller's copy of
 * the frame reaches this rule; the `●` / `>` rows survive it, so the block is
 * bounded the same way on both paths.
 */
export const ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN = /^\s*(?:─{3,}\s*$|[●⎿▸]|>(?!\s*\d+\.\s+\S))/;

/**
 * How many rows above the `↑/↓ Navigate` footer the dialog block may reach.
 *
 * The tallest measured frame (`dialog-bash-wrapped.txt`: header, rule,
 * `Requesting permission for:`, a four-row command, the question and four
 * options of which two wrap onto three rows each) spans 18 rows; the cap leaves
 * room for a longer command without letting a boundary-free frame drag the
 * whole transcript into the block.
 */
export const ANTIGRAVITY_DIALOG_MAX_ROWS = 60;

/**
 * agy's post-answer survey row (Issue #2364).
 *
 * Drawn once, in place of the composer, after some tool decisions:
 *
 * ```
 *  How's the CLI experience so far? Help us improve:
 *  [1] Good  [2] Fine  [3] Bad  [0] Skip
 *
 * ? for shortcuts …
 * ```
 *
 * Every option sits on ONE row in `[N] label` form and the screen takes a
 * typed digit, not the arrow keys; there is no `↑/↓ Navigate` footer and no bare
 * `>` composer, so before this pattern existed the frame reached the `default`
 * floor — `running`, with the chat surface showing "generating" over a screen
 * that was waiting for a keypress. Anchored to the whole row.
 */
export const ANTIGRAVITY_SURVEY_PATTERN = /^\s*\[1\]\s*Good\s+\[2\]\s*Fine\s+\[3\]\s*Bad\s+\[0\]\s*Skip\s*$/m;

/** Where agy's dialog block sits on a frame — see {@link locateAntigravityDialogRegion}. */
export interface AntigravityDialogRegion {
  /** Index of the first row that may belong to the dialog (just below the nearest boundary). */
  readonly start: number;
  /** Index of the `↑/↓ Navigate` footer row. */
  readonly footer: number;
}

/**
 * Find the rows between the last boundary and the last `↑/↓ Navigate` footer
 * (Issue #2364).
 *
 * The footer is searched from the bottom, so an older dialog still in the
 * scrollback above a newer one is never the one read. Returns null when the
 * frame has no footer at all.
 *
 * Also null when agy's input box is drawn BELOW that footer (Issue #2845): agy
 * paints no `>` composer while a dialog is open — the dialog takes its place —
 * so a footer with a composer under it is the model's reply quoting a dialog,
 * or a dialog left in the scrollback, not a screen waiting for a keypress. It is
 * the same reading `isAntigravitySurveyOpen` gives the survey row (#2364), and
 * the composer is recognised by the same {@link ANTIGRAVITY_PROMPT_PATTERN}.
 *
 * @param lines - ANSI-stripped rows, box drawing optional
 */
export function locateAntigravityDialogRegion(lines: readonly string[]): AntigravityDialogRegion | null {
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;
  for (let i = footer + 1; i < lines.length; i++) {
    if (ANTIGRAVITY_PROMPT_PATTERN.test(lines[i])) return null;
  }

  const floor = Math.max(0, footer - ANTIGRAVITY_DIALOG_MAX_ROWS);
  let start = floor;
  for (let i = footer - 1; i >= floor; i--) {
    if (ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  return { start, footer };
}

/**
 * Is this frame one of agy's NUMBERED dialogs rather than one of its
 * arrow-key-only pickers? (Issue #2270, re-measured by Issue #2364)
 *
 * Both kinds of screen share the `↑/↓ Navigate` footer that
 * {@link ANTIGRAVITY_SELECTION_LIST_PATTERN} matches, which is why #997 could
 * widen that pattern to cover the permission menu — and why the menu then
 * resolved as `antigravity_selection_list`, `hasActivePrompt: false`. On the
 * chat surface that reads as "a selection list is open, drive it from the
 * terminal": the arrow buttons can only Enter the highlighted option 1, so
 * options 2-4 became unreachable, while the poller and the push notification
 * described the very same frame as a `multiple_choice` prompt.
 *
 * #2270 told the two apart by the question line, `Do you want to proceed?`,
 * because that was the one dialog it had measured. #2364 measured a second one
 * — agy 1.1.27's file-creation menu asks `Allow creation of this file?` above
 * `1. Yes, allow creation` / `2. No, deny creation` — and it fell straight back
 * into the selection-list reading. So the rule is now about the STRUCTURE the
 * dialogs share and the pickers lack:
 *
 *  - the `↑/↓ Navigate` footer,
 *  - at least two `N. label` rows between the nearest boundary row and that
 *    footer ({@link ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN}), and
 *  - no `Switch Model` header in that region.
 *
 * The Switch Model picker, the folder-trust screen and the slash-command popup
 * all draw unnumbered rows (`> Gemini 3.8 Flash`, `> Yes, I trust this folder`,
 * `> /add-dir …`), so they keep the #995 reading — and because a `>` row that
 * is not numbered is itself a boundary, a numbered list in the transcript above
 * one of them cannot be counted.
 *
 * True here means "hand the frame to the agy dialog reader"
 * (`tools/antigravity/dialog.ts`), never "this is a prompt": a frame that
 * passes this test and still fails to read is published as an unclassified
 * frame, not as a selection list and never as "generating".
 *
 * Callers pass the same text they hand {@link ANTIGRAVITY_SELECTION_LIST_PATTERN}.
 */
export function isAntigravityNumberedDialog(text: string): boolean {
  const lines = text.split('\n');
  const region = locateAntigravityDialogRegion(lines);
  if (region === null) return false;

  let numberedRows = 0;
  for (let i = region.start; i < region.footer; i++) {
    const line = lines[i];
    if (ANTIGRAVITY_SWITCH_MODEL_HEADER_PATTERN.test(line)) return false;
    if (ANTIGRAVITY_NUMBERED_OPTION_PATTERN.test(line)) numberedRows++;
  }
  return numberedRows >= 2;
}

/**
 * Antigravity (agy) skip patterns for response cleaning (Issue #988)
 * Filters turn/input-box separators, the bare ">" input prompt, the idle status
 * bar ("? for shortcuts ... <model>"), the thinking footer/spinner, banner block
 * art, and pasted-text markers from extracted responses.
 */
export const ANTIGRAVITY_SKIP_PATTERNS: readonly RegExp[] = [
  ANTIGRAVITY_SEPARATOR_PATTERN, // Turn + input-box separators (─ runs)
  /^>\s*$/, // Bare input prompt line
  /^\?\s+for\s+shortcuts/, // Idle status bar (model name follows on the same line)
  ANTIGRAVITY_THINKING_PATTERN, // Spinner / Generating / "esc to cancel" footer
  /[▄▀█▌▐]/, // Banner block art (defensive; normally above the user-prompt anchor)
  PASTED_TEXT_PATTERN, // [Pasted text #N +XX lines]
] as const;
