/**
 * The one reader of a numbered option block, shared by every tool's
 * `prompt.ts` (Issue #1928, 方針書 §4 D1 決定 4).
 *
 * Every CLI in the registry draws its dialogs the same shape — a question, a run
 * of `1. / 2. / 3.` rows with the highlighted one carrying a selection glyph,
 * and (usually) a footer naming the keys it takes. What differs per tool is
 * WHERE that block is allowed to sit and WHICH footer vouches for it, and those
 * are the two things a tool module states for itself. The parsing in between is
 * identical, and writing it seven times would be seven chances to disagree about
 * what an option row is.
 *
 * ## Why this is not `detectPrompt`
 *
 * `detectPrompt` answers "could a human answer something on this frame?" from
 * the text alone, which is exactly the generic inference §4 D1 決定 4 says
 * Auto-Yes may not fire on: an agent that *quotes* a numbered list in its reply
 * satisfies it (#1896). This module is deliberately dumber — it finds a block
 * and reports what it found, including the selection glyph and the rows
 * underneath it — and leaves the judgement to the tool module, which is the only
 * place that knows whether that position and that footer are its own dialog.
 *
 * ## Input contract
 *
 * Rows must be ANSI-stripped. They MAY still carry box drawing, and they may
 * equally have had it removed already: the Auto-Yes poller hands the detector a
 * frame that has been through `stripBoxDrawing(stripAnsi(...))`, while
 * `detectSessionStatus` hands it one that has not. Nothing here reads a gutter
 * glyph or an SGR attribute, so both spellings parse to the same block.
 */

/**
 * One numbered option row.
 *
 * `[❯›●>]` is the union of the selection glyphs measured across the registry:
 * claude and copilot draw `❯`, codex draws `›`, antigravity draws the ASCII `>`
 * (Issue #999), and `●` appears as the filled-radio spelling. The glyph is
 * OPTIONAL here because only the highlighted row wears it; whether its presence
 * is required at all is the tool module's call.
 *
 * A leading `│`/`┃` is accepted so a frame whose box drawing is still attached
 * parses to the same block as one whose gutter has been removed.
 *
 * No `/g` (keeps `.test()` stateless) and no nested quantifiers (ReDoS-safe).
 */
const OPTION_ROW_PATTERN = /^[^\S\n]*[│┃]?[^\S\n]*([❯›●>])?[^\S\n]*(\d{1,2})[.)][^\S\n]+(\S.*?)[^\S\n]*[│┃]?$/;

/**
 * How far above `endExclusive` the bottom-most option row may sit.
 *
 * Generous because the footer between the block and the region end is a couple
 * of rows at most on every measured frame, and because a frame captured
 * mid-repaint can put a blank row or two in there. Bounded at all so a numbered
 * list hundreds of rows up in a transcript cannot be adopted as "the dialog on
 * this frame".
 */
const DEFAULT_FOOTER_SCAN_ROWS = 8;

/** How many rows one option block may span, wrapped continuations included. */
const MAX_BLOCK_ROWS = 60;

/** The block a tool module was handed, and everything it needs to judge it. */
export interface NumberedOptionBlock {
  /** Option labels in draw order; index 0 is option `1.`. */
  readonly options: readonly string[];
  /** Index of the option wearing the selection glyph, or -1 if none does. */
  readonly selectedIndex: number;
  /**
   * The glyph {@link selectedIndex} was found by, or null.
   *
   * Exposed because the glyphs are NOT interchangeable across tools: `❯`/`›` are
   * selection cursors, while `●` is also how claude draws an ordinary bullet in
   * its own transcript. A tool that would be fooled by the second spelling says
   * so by checking this, rather than by the block reader guessing on its behalf.
   */
  readonly selectedGlyph: string | null;
  /** Row index of option `1.`. */
  readonly firstRow: number;
  /** Row index of the highest-numbered option's own row. */
  readonly lastRow: number;
  /** The non-blank rows between {@link lastRow} and the region end, joined. */
  readonly footer: string;
}

interface ParsedOptionRow {
  glyph: string | undefined;
  number: number;
  label: string;
}

function parseOptionRow(row: string): ParsedOptionRow | null {
  const match = OPTION_ROW_PATTERN.exec(row);
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { glyph: match[1], number, label: match[3].trim() };
}

/**
 * Find the bottom-most run of numbered options ending at or above
 * `endExclusive`.
 *
 * The run must descend to `1.` without a gap — `3. / 2. / 1.` reading upwards —
 * and must hold at least two options. Both are guards against the same false
 * positive: an ordinary sentence beginning `2020. ` is a single row with no `1.`
 * above it, and a one-option "dialog" is not a choice.
 *
 * Blank rows inside the run are skipped (claude puts one between its question
 * and its options and copilot puts one before its footer). A non-blank row that
 * is not an option row is taken as the WRAPPED TAIL of the option above it —
 * codex and copilot both wrap a long command onto a second row, and dropping it
 * would truncate the label `respond` shows the operator. Nothing bad comes of
 * being permissive there: the run still has to reach `1.` within
 * {@link MAX_BLOCK_ROWS}, so prose that merely sits above a `2. / 1.` pair is
 * bounded, and every caller additionally requires its own footer or selection
 * glyph before treating the result as a dialog.
 *
 * @param lines - ANSI-stripped rows, box drawing optional
 * @param endExclusive - Exclusive upper bound; the tool module's region end
 * @param footerScanRows - How many non-blank rows below the block to accept as
 *   its footer before giving up on finding one
 * @returns The block, or null when the region holds no numbered choice
 */
export function findNumberedOptionBlock(
  lines: readonly string[],
  endExclusive: number,
  footerScanRows: number = DEFAULT_FOOTER_SCAN_ROWS,
): NumberedOptionBlock | null {
  const end = Math.min(endExclusive, lines.length);

  // 1. Walk up through the footer zone to the bottom-most option row.
  let cursor = end - 1;
  let scanned = 0;
  const footerRows: string[] = [];
  let bottom: ParsedOptionRow | null = null;
  while (cursor >= 0 && scanned <= footerScanRows) {
    const row = lines[cursor];
    if (row.trim() === '') {
      cursor--;
      continue;
    }
    scanned++;
    bottom = parseOptionRow(row);
    if (bottom) break;
    footerRows.unshift(row.trim());
    cursor--;
  }
  if (!bottom) return null;

  const lastRow = cursor;

  // 2. Walk up the run, collecting each option and any wrapped rows above it.
  const collected: ParsedOptionRow[] = [bottom];
  let expected = bottom.number - 1;
  let row = cursor - 1;
  let spanned = 1;
  // Rows seen since the last option row. They are the wrapped tail of the option
  // ABOVE them, which the walk has not reached yet — attaching them to the one
  // below (the last entry of `collected`) would move a long command onto the
  // wrong choice, which is the label `respond` shows the operator.
  let pending: string[] = [];
  while (expected >= 1 && row >= 0 && spanned <= MAX_BLOCK_ROWS) {
    const text = lines[row];
    spanned++;
    if (text.trim() === '') {
      row--;
      continue;
    }
    const parsed = parseOptionRow(text);
    if (parsed && parsed.number === expected) {
      collected.unshift({ ...parsed, label: [parsed.label, ...pending].join(' ').trim() });
      pending = [];
      expected--;
      row--;
      continue;
    }
    if (parsed) break; // a numbered row out of sequence — not this block
    pending.unshift(text.trim());
    row--;
  }

  if (expected !== 0 || collected.length < 2) return null;

  const selectedIndex = collected.findIndex(option => option.glyph !== undefined);

  return {
    options: collected.map(option => option.label),
    selectedIndex,
    selectedGlyph: selectedIndex < 0 ? null : (collected[selectedIndex].glyph ?? null),
    firstRow: row + 1,
    lastRow,
    footer: footerRows.join('\n'),
  };
}
