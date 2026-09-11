/**
 * The AskUserQuestion picker's own chrome, as claude-cli 2.1.268 draws it
 * (Issue #2486).
 *
 * Two parts of the picker are drawn AROUND the dialog rather than as part of it,
 * and the detectors read both as if they were the dialog:
 *
 * - **The tab row** above the question: `←  ☐ 権限モード  ☐ Goal/範囲  ✔ Submit  →`
 *   for a multi-question call, ` ☐ 権限モード ` for a single question. The upward
 *   scans that build `question` and `approvalTarget` swept it up, together with
 *   whatever the transcript showed above it (the previous tool's row).
 * - **The preview pane.** When an option carries a `preview`, the options column
 *   narrows to ~32 columns and a box opens to its right: `┌─…─┐` at the end of
 *   option 1's row, `│ … │` rows under it, `└─…─┘`, and `Notes: press n to add
 *   notes` at the box's indent below that. Its ~20 rows sit between the options
 *   and the footer, which put the options out of reach of the dialog reader's
 *   footer scan — `detectClaudeDialog` found no block, and `/prompt-response`
 *   refused the open dialog as `prompt_no_longer_active` (the refusal #2486
 *   reported). Its text also rode along on the option rows it shares a line with.
 *
 * Measured on a private tmux socket at the production 200x1000 geometry
 * (`tests/fixtures/claude-live-2486/`): the tab row alone did not stop
 * `detectClaudeDialog`; the pane did, with or without a tab row.
 *
 * ## A leaf on purpose
 *
 * Imports nothing, so `lib/chat/chat-tool-approvals.ts` — which client
 * components reach — takes its tab-bar pattern from here rather than keeping a
 * second copy of what the bar looks like (#2460 strips it from rows stored before
 * this Issue stopped the detector from putting it there).
 *
 * ## Why characters and not columns
 *
 * Every reader sees one of two spellings of these rows: the capture with its box
 * drawing, or the same capture after `stripBoxDrawing` (the Auto-Yes poller and
 * every `detectPrompt` caller). `stripBoxDrawing` removes a leading `│` with the
 * whitespace in front of it, so a pane row with nothing in the options column
 * loses its left border and slides to column 0, while a row that shares its
 * line with an option keeps the border in the middle. A column position cannot
 * follow that — and `terminal-columns.ts` deliberately counts a CJK character as
 * one column — so the pane is found by structure instead: its top border on
 * option 1's row, a bottom border of the same width, the FIRST `│` on each row
 * in between, and the picker's footer under it all. That reads the same in both
 * spellings.
 */

/**
 * The multi-question tab bar: `←`, one checkbox per question, `✔ Submit`, `→`.
 *
 * A tab name may hold spaces, Japanese or `/` (`Goal/範囲`); the class excludes
 * only the bar's own glyphs. `(?:[☐☒☑][^…☐☒☑…]*)+` cannot backtrack: every
 * repetition starts with a checkbox the inner class excludes. ReDoS-safe.
 */
const TAB_BAR_SOURCE = String.raw`←\s*(?:[☐☒☑][^←→☐☒☑✔]*)+✔\s*Submit\s*→`;

/**
 * The tab bar at the FRONT of a string an upward scan swept it into (#2460).
 *
 * Stored `question` values from before #2486 start with it; the chat surface
 * strips it at display time. Unanchored at the end on purpose — the question
 * follows it.
 */
export const ASK_USER_QUESTION_TAB_BAR_PREFIX_PATTERN = new RegExp(`^${TAB_BAR_SOURCE}\\s*`);

/**
 * The tab bar as a whole pane row.
 *
 * At most one leading space: Claude draws it at column 0, and a row the
 * transcript indents (tool output, a quoted reply) is not the picker's.
 */
const TAB_BAR_ROW_PATTERN = new RegExp(`^\\s?${TAB_BAR_SOURCE}$`);

/**
 * A single question's tab: ` ☐ 権限モード `.
 *
 * - At most one leading space, like the bar. TodoWrite's `☐ task` rows sit under
 *   `⎿` and are indented further, so they do not match.
 * - The header may not begin with a digit: `☐ 1. Blue` is how a multi-select
 *   option would read, and an option row must never be taken for chrome.
 * - AskUserQuestion caps a header at 12 characters, so 40 is generous and keeps a
 *   row of prose that happens to start with a checkbox from qualifying.
 */
const SINGLE_TAB_ROW_PATTERN = /^\s?[☐☒☑] [^\s\d←→☐☒☑✔][^←→☐☒☑✔]{0,40}$/;

/**
 * The picker's footer: `Enter to select · ↑/↓ to navigate · … · Esc to cancel`.
 *
 * The generic parser trims its scan at it and flags `isAskUserQuestion` from it
 * (#807); the pane finder below requires it under a pane (#2486). One pattern for
 * both, so "this is a live picker" means the same thing to each. A single
 * unbounded quantifier between literal anchors — ReDoS safe.
 */
export const ASK_USER_QUESTION_PICKER_FOOTER_PATTERN = /Enter\s+to\s+select\b.*\bnavigate\b/i;

/** Whether `row` is an AskUserQuestion picker's tab row, in either form. */
export function isAskUserQuestionTabRow(row: string): boolean {
  const text = row.trimEnd();
  return TAB_BAR_ROW_PATTERN.test(text) || SINGLE_TAB_ROW_PATTERN.test(text);
}

/**
 * The tab row above the question whose last row is `questionRow`, or -1.
 *
 * Only ever asked from a question or an option block upward, so the tab row is
 * found where the picker draws it — above its own question — and nowhere else.
 *
 * @param lines - ANSI-stripped rows, box drawing optional
 * @param questionRow - The question's last row (or the options' first row)
 * @param lookback - How many rows above `questionRow` the tab row may sit
 */
export function findAskUserQuestionTabRow(
  lines: readonly string[],
  questionRow: number,
  lookback: number,
): number {
  const floor = Math.max(0, questionRow - lookback);
  for (let i = questionRow - 1; i >= floor; i--) {
    if (isAskUserQuestionTabRow(lines[i] ?? '')) return i;
  }
  return -1;
}

/** The pane's top border, closing option 1's row: `❯ 1. label   ┌───┐`. */
const PREVIEW_TOP_BORDER_PATTERN = /┌(─+)┐\s*$/;

/**
 * What must precede the top border on its row: option 1, cursor or not.
 *
 * One of the two anchors that keep a box Claude renders in the TRANSCRIPT — a
 * Markdown table, a diagram in a reply — from being taken for a pane: those
 * start at the transcript's own indent, not on a numbered option row. The other
 * is the picker footer ({@link hasPickerFooterBelow}).
 */
const PREVIEW_ANCHOR_OPTION_PATTERN = /^\s*(?:[❯›>]\s*)?1\.\s+\S/;

/** The pane's bottom border, alone on its row; the indent is the pane's column. */
const PREVIEW_BOTTOM_BORDER_PATTERN = /^( *)└(─+)┘\s*$/;

/** The pane's left border. The first one on a row is the border, never content. */
const PREVIEW_LEFT_BORDER = '│';

/**
 * What the options column may hold beside the pane: an option row, or the
 * wrapped tail of a label (`    (Recommended)`). Anything else to the left of a
 * `│` is pane content that `stripBoxDrawing` slid left, and the row is pane.
 */
const OPTION_COLUMN_PATTERN = /^\s*(?:[❯›>]\s*)?\d{1,2}\.\s+\S|^\s{2,}\S/;

/** How far below its top border a pane's bottom border may be looked for. */
const MAX_PREVIEW_ROWS = 80;

/**
 * How many non-blank rows may separate a pane (and its notes) from the picker
 * footer. Measured: the separator rule and the unnumbered `Chat about this`.
 */
const PICKER_FOOTER_LOOKAHEAD_ROWS = 4;

/** Where one or more preview panes sit in a region. */
export interface ClaudePreviewPanes {
  /** Rows holding nothing but pane: its interior beside an empty options column, its bottom border, its notes row. */
  readonly rows: Set<number>;
  /** Rows the pane shares with the options column: row → index at which the pane begins. */
  readonly cuts: Map<number, number>;
}

function leadingSpaces(row: string): number {
  return row.length - row.trimStart().length;
}

/**
 * Whether the picker's footer follows `from` within a few rows.
 *
 * A pane belongs to a LIVE picker, whose footer sits right under it. A reply
 * that quotes a preview picker — box, cursor and all — has no footer under it;
 * claiming its rows as chrome would hand the dialog reader the quoted options
 * as if nothing followed them. Read past the caller's region on purpose: the
 * generic parser's region ENDS at this footer.
 */
function hasPickerFooterBelow(lines: readonly string[], from: number): boolean {
  let seen = 0;
  for (let i = from; i < lines.length && seen < PICKER_FOOTER_LOOKAHEAD_ROWS; i++) {
    const row = lines[i];
    if (row.trim() === '') continue;
    if (ASK_USER_QUESTION_PICKER_FOOTER_PATTERN.test(row)) return true;
    seen++;
  }
  return false;
}

/**
 * Find the AskUserQuestion preview pane(s) in [start, end).
 *
 * A pane is claimed only when all of it is on screen: a top border on option
 * 1's row, a bottom border of exactly the same width below it, and the picker's
 * footer under that. Anything less — a pane caught mid-draw, a quoted one — is
 * left alone, which is the safe direction: its rows are read as they were before
 * this Issue, and the dialog reader declines the frame rather than trusting half
 * a box.
 *
 * @param lines - ANSI-stripped rows, box drawing optional
 * @param start - First index to consider (inclusive)
 * @param end - Last index to consider (exclusive)
 */
export function findClaudePreviewPanes(
  lines: readonly string[],
  start: number,
  end: number,
): ClaudePreviewPanes {
  const rows = new Set<number>();
  const cuts = new Map<number, number>();
  const last = Math.min(end, lines.length);

  for (let top = Math.max(0, start); top < last; top++) {
    const row = lines[top];
    if (!row.includes('┌')) continue;
    const topBorder = PREVIEW_TOP_BORDER_PATTERN.exec(row);
    if (!topBorder || !PREVIEW_ANCHOR_OPTION_PATTERN.test(row.slice(0, topBorder.index))) continue;

    let bottom = -1;
    let indent = 0;
    for (let i = top + 1; i < Math.min(last, top + MAX_PREVIEW_ROWS); i++) {
      const bottomBorder = PREVIEW_BOTTOM_BORDER_PATTERN.exec(lines[i]);
      if (bottomBorder && bottomBorder[2].length === topBorder[1].length) {
        bottom = i;
        indent = bottomBorder[1].length;
        break;
      }
    }
    if (bottom < 0) continue;

    const paneRows: number[] = [bottom];
    const paneCuts: Array<[number, number]> = [[top, topBorder.index]];
    for (let i = top + 1; i < bottom; i++) {
      const border = lines[i].indexOf(PREVIEW_LEFT_BORDER);
      const optionColumn = border > 0 ? lines[i].slice(0, border) : '';
      if (optionColumn.trim() !== '' && OPTION_COLUMN_PATTERN.test(optionColumn)) {
        paneCuts.push([i, border]);
      } else {
        paneRows.push(i);
      }
    }

    // `Notes: press n to add notes` — the pane's column continues under the box
    // at the box's own indent, which no row of the dialog shares.
    let next = bottom + 1;
    for (; next < last; next++) {
      const below = lines[next];
      if (below.trim() === '') continue;
      if (leadingSpaces(below) !== indent) break;
      paneRows.push(next);
    }
    if (!hasPickerFooterBelow(lines, next)) continue;

    for (const paneRow of paneRows) rows.add(paneRow);
    for (const [cutRow, index] of paneCuts) cuts.set(cutRow, index);
    top = next - 1;
  }

  return { rows, cuts };
}
