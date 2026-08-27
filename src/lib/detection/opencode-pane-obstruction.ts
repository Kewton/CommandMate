/**
 * opencode's sidebar, detected structurally from a captured frame (Issue #2095).
 *
 * ## What this is about
 *
 * opencode 1.18.22 paints a right-hand sidebar (session title, `Context` /
 * token counters, `LSP` status) that does **not** get its own region of a
 * `capture-pane`. It shares ROWS with the transcript and with the input box, so
 * every captured line becomes `<transcript text> … <sidebar text>` and every
 * reader in this repo sees one row (Issue #2047 measured this at ≥121 columns).
 *
 * Issue #2046 then measured the consequence at the width production actually
 * runs opencode at. `ctrl+x b` (`sidebar_toggle`) turns the sidebar on at **80
 * columns**, below the width #2047 found it appearing at on its own, and the
 * same finished turn flips from `ready` / `opencode_response_complete` to
 * `running` / `unknown_frame` with the sidebar's own text saved as the
 * assistant's reply. Escape does not close it; pressing `ctrl+x b` again does.
 *
 * #2046 removed `b` from {@link OPENCODE_LEADER_CHORD_VALUES} and the
 * special-keys route refuses it, but that only closes CommandMate's own door:
 * opencode's `ctrl+p` command palette lists `Show sidebar   ctrl+x b` and a user
 * can run it from there. **This module does not stop the sidebar. It makes the
 * sidebar visible to the people and the tools that are waiting on the pane.**
 *
 * ## The signature, and why it is not a word list
 *
 * `Context`, `LSP` and `tokens` are on the sidebar, and they are also ordinary
 * English an agent writes in a reply — a word list would flag any turn that
 * happens to discuss LSPs. The signature this module uses is the geometry
 * instead:
 *
 * ```
 *   ┃                                     Context          ← gutter row, second column
 *      OK2046                             1% used
 *   ┃  Build · Claude Sonnet 4.6 GitHub   maenokota-share-work-…
 *   ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  commandmate-issue-2046/…
 *                                       ↑ the box ends here
 * ```
 *
 * opencode draws the input box's bottom edge as `╹` + a run of `▀` spanning the
 * box's full width, and pads every gutter (`┃`) row out to that same width. So
 * the box's right edge is measurable from the frame itself, and **content to the
 * right of it on a row that belongs to the box is a second column** — something
 * a box that owns the full pane width can never produce, because its own text
 * wraps at that edge.
 *
 * Deliberately NOT gated on the pane being wide. #2046's measurement is that the
 * explicit toggle ignores the 121-column threshold, so a width branch would miss
 * the case this Issue exists for.
 *
 * ## What a match means, and what it does not
 *
 * A match means the frame was laid out in two columns. A **non**-match means the
 * layout could not be read — most often because no bottom border was on the
 * frame at all, which is what a permission dialog produces (measured:
 * `permission-bash.txt` / `permission-edit.txt` under every width of
 * `tests/fixtures/opencode-live-2047` carry no border row) — and NEVER "the
 * sidebar is off". Nothing reading this may report
 * `null` as an all-clear, for the same reason `upstream-faults.ts` says so.
 *
 * A leaf module by design: it imports {@link stripAnsi} and the excerpt bound and
 * nothing else, so the payload builder, the CLI types and the client components
 * that derive this from the frame they already hold can all share one rule.
 *
 * @module lib/detection/opencode-pane-obstruction
 */

import { stripAnsi } from './ansi';
import { truncateToByteBudget } from './excerpt';

/**
 * Published `paneObstruction.id` for this signature.
 *
 * Snake case, like every `sessionStatusReason` value, because the same operators
 * read the two next to each other in `capture --json`.
 */
export const OPENCODE_SIDEBAR_OBSTRUCTION_ID = 'opencode_sidebar';

/**
 * The keystroke that closes it, in opencode's own notation.
 *
 * Taken verbatim from opencode's keybind table, which its `ctrl+p` palette
 * prints as `Show sidebar   ctrl+x b` — see
 * `tests/fixtures/opencode-live-2046/w80/dialog-command-palette.txt:70`.
 * Exported rather than written into each surface so the UI banner, the history
 * row and `wait`'s stderr cannot drift apart, and so no surface has to hold a
 * bare key literal of its own.
 */
export const OPENCODE_SIDEBAR_RECOVERY_CHORD = 'ctrl+x b';

/**
 * How many box rows must carry a second column before this reports a match.
 *
 * Two, as cheap insurance against a single stray cell — a wide character
 * straddling the edge, a repaint caught mid-write. Not a tuned threshold: the
 * measured frames carry 3 (in the 100-row window this is judged on) to 11, so
 * the guard has an order of magnitude of headroom and has never been the thing
 * that decided a verdict.
 */
export const OPENCODE_SIDEBAR_MIN_ROWS = 2;

/** Bound on {@link OpenCodePaneObstruction.matchedText}, in UTF-8 bytes. */
export const OPENCODE_SIDEBAR_EXCERPT_MAX_BYTES = 200;

/** Appended when {@link OPENCODE_SIDEBAR_EXCERPT_MAX_BYTES} cut the excerpt. */
export const OPENCODE_SIDEBAR_TRUNCATION_MARKER = '…[truncated]';

/**
 * The input box's bottom edge: `  ╹▀▀▀▀▀…`.
 *
 * The same anchor `OPENCODE_COMPOSER_BOTTOM_BORDER` (`cli-patterns.ts`, Issue
 * #1911) uses, restated here with capture groups because this module needs the
 * edge's COLUMN and that one only needs to know the row exists.
 * `tests/unit/detection-opencode-pane-obstruction-2095.test.ts` asserts the two
 * still select the same rows, so the restatement cannot drift silently.
 */
const COMPOSER_BOTTOM_BORDER_ROW = /^([^\S\n]*)╹(▀{4,})/;

/**
 * A row of the input box: leading space, then the gutter.
 *
 * Character class shared with `OPENCODE_GUTTER_ROW_PATTERN` (Issue #1893):
 * opencode draws the same box with `┃` and, in some themes, `│`.
 */
const COMPOSER_GUTTER_ROW = /^([^\S\n]*)[│┃]/;

/** One code point that occupies no terminal column. See {@link indexAtColumn}. */
const COMBINING_MARK = /^\p{M}$/u;

/**
 * The UTF-16 index at which terminal column `column` begins.
 *
 * `String.prototype.slice` counts UTF-16 units and this rule is about terminal
 * COLUMNS. The two disagree in two ways, and only one of them can invent a
 * second column that is not there:
 *
 *  - **Combining marks are one code point and ZERO columns**, so a row of
 *    heavily-combining script — Thai, Devanagari, Hebrew with nikud, macOS's
 *    NFD Latin — is LONGER in units than in columns. Uncorrected, a box that
 *    owns the full pane width could slice to a non-empty tail and report a
 *    sidebar on a pane that has none. This skips them, which removes the case
 *    rather than making it unlikely. They are consumed greedily once the column
 *    is reached, too: a lone mark left in the tail would survive `trim()` and be
 *    counted as evidence.
 *  - **East Asian wide characters are one code point and TWO columns**, so a row
 *    of Japanese is SHORTER in units than in columns. That is NOT corrected
 *    here, deliberately: undercounting cuts LATER than the true column, which
 *    can only shorten the excerpt or miss a second column — never invent one.
 *    It is also exactly what a plain `slice` already did, so nothing regresses.
 *    Carrying a wcwidth table to buy back a few characters of excerpt would put
 *    a second source of truth about character widths in the repository for no
 *    verdict's benefit.
 *
 * Iterates code points, never UTF-16 units, so a surrogate pair is one step.
 */
function indexAtColumn(line: string, column: number): number {
  // Exact, not an approximation: counted columns can never exceed the unit
  // count, so a line this short consumes whole in the loop below and returns
  // the same answer. It is here because it is the case every full-width box row
  // takes, on every poll and every render.
  if (line.length <= column) return line.length;

  let columns = 0;
  let index = 0;
  for (const char of line) {
    const width = COMBINING_MARK.test(char) ? 0 : 1;
    if (width === 1 && columns >= column) break;
    columns += width;
    index += char.length;
  }
  return index;
}

/** A second column found sharing rows with the transcript. */
export interface OpenCodePaneObstruction {
  /** {@link OPENCODE_SIDEBAR_OBSTRUCTION_ID}. */
  id: typeof OPENCODE_SIDEBAR_OBSTRUCTION_ID;
  /**
   * The second column's own text on the first row that carried it, trimmed and
   * bounded.
   *
   * The tail rather than the whole row, which is the opposite of what
   * {@link UpstreamFaultMatch.matchedText} publishes, and for the same reason
   * that one publishes the whole line: the excerpt has to carry the evidence.
   * There the evidence is the wording around a four-character match; here it is
   * that a column exists at all, and the transcript half of the row says nothing
   * about that while dominating the byte budget.
   *
   * **`id` carries the meaning; this carries the proof.** Which cell it lands on
   * depends on how much of the pane the caller passed: over a whole capture the
   * first box row is near the top of the sidebar and the excerpt reads like the
   * session title (`OK2046` on the #2046 fixture), while over the 100-row window
   * the payload publishes it is the sidebar's footer and reads like a path
   * (`/private/tmp/…`). Both are the sidebar. Neither is a classification, and
   * nothing may branch on the text.
   */
  matchedText: string;
  /** Column the input box ends at, 0-based and exclusive. Diagnostic only. */
  boxRight: number;
  /** How many box rows carried a second column. Diagnostic only. */
  rows: number;
}

/**
 * The second column sharing rows with an opencode transcript, or null.
 *
 * Call it only for opencode: the anchors are opencode's own box drawing, and
 * every other tool is left exactly as it was (Issue #2095 changes no other
 * tool's detection).
 *
 * ANSI is stripped first — the sidebar is painted with an SGR background, so on
 * a raw `capture-pane -e` frame the column boundary is buried in escape
 * sequences.
 */
export function detectOpenCodePaneObstruction(frame: string): OpenCodePaneObstruction | null {
  const lines = stripAnsi(frame).split('\n');

  // The LAST border row, not the first: a long capture holds the borders of
  // every repaint still in scrollback, and the only one that describes the box
  // on screen now is the last one. Reading an older, wider edge would report
  // "no second column" on a pane that has one.
  let borderIndex = -1;
  let boxLeft = -1;
  let boxRight = -1;
  for (let i = 0; i < lines.length; i++) {
    const border = COMPOSER_BOTTOM_BORDER_ROW.exec(lines[i]);
    if (!border) continue;
    borderIndex = i;
    boxLeft = border[1].length;
    boxRight = boxLeft + 1 + border[2].length;
  }
  if (borderIndex === -1) return null;

  let rows = 0;
  let matchedText = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i !== borderIndex) {
      const gutter = COMPOSER_GUTTER_ROW.exec(line);
      // Same indent as the border, or it is not this box's row. At 200 columns
      // opencode centres the home screen's box (measured: `boxLeft` 63), so an
      // indent-agnostic test would count transcript rows as box rows.
      if (!gutter || gutter[1].length !== boxLeft) continue;
    }

    // Cut at the COLUMN, not at the UTF-16 unit — see {@link indexAtColumn} for
    // which of the two ways those disagree can invent a column that is not
    // there. A box that owns the full pane width slices to '' whatever is
    // written in it.
    const tail = line.slice(indexAtColumn(line, boxRight)).trim();
    if (tail === '') continue;

    rows += 1;
    if (matchedText === '') {
      matchedText = truncateToByteBudget(
        tail,
        OPENCODE_SIDEBAR_EXCERPT_MAX_BYTES,
        OPENCODE_SIDEBAR_TRUNCATION_MARKER,
      );
    }
  }

  if (rows < OPENCODE_SIDEBAR_MIN_ROWS) return null;

  return { id: OPENCODE_SIDEBAR_OBSTRUCTION_ID, matchedText, boxRight, rows };
}
