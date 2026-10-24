/**
 * Which option of a question the question itself recommends (Issue #3863).
 *
 * Auto-Yes's `recommended` answer mode answers a question with the option
 * whose TITLE ends in a recommendation marker — `(Recommended)`, `（推奨）` or
 * `(推奨)`. The title, not the label as a whole: on Claude's and Command
 * Code's pickers an option is a title row and, under it, a description, and a
 * description may end in the same words (`… see Recommended Next Actions`),
 * or quote the marker. So the readers that still know where a title ends —
 * the block reader, Command Code's question reader and Claude's
 * AskUserQuestion parser — say per option what its title shows:
 *
 * - `true`: the title ends in a marker;
 * - `false`: it does not;
 * - `'unknown'`: the reader could not tell the title from what follows it
 *   (a continuation row that may be the title wrapping or a description).
 *
 * A reader never answers `false` for a title it could not delimit: a marker
 * on the part it could not place would make "no option is recommended" (the
 * default is then answered) a guess.
 *
 * The labels themselves, and every text a contract's deny patterns are
 * matched against, are left as they were read.
 *
 * Leaf module: imports nothing.
 *
 * @module lib/detection/option-recommendation
 */

/** What one option's title says about being recommended. */
export type OptionRecommendation = true | false | 'unknown';

/**
 * A marker at the very end of a title, standing on its own: what precedes it
 * is the start of the title, white space, or anything but an ASCII letter or
 * digit (`dispatch (Recommended)`, `する（推奨）`), never a word it is glued
 * to (`Not(Recommended)`). Case as the tools write it. Anchored, no nested
 * quantifiers (ReDoS-safe).
 */
const RECOMMENDATION_MARKER_PATTERN = /(?:^|[^A-Za-z0-9])(?:\(Recommended\)|（推奨）|\(推奨\))$/;

/**
 * Whether a title — the option's whole title, wrapped rows joined — ends in a
 * recommendation marker.
 *
 * @param title - The option's title, without its number or cursor
 */
export function isRecommendedTitle(title: string): boolean {
  return RECOMMENDATION_MARKER_PATTERN.test(title.trim());
}

/** The markers, as a row holding nothing else spells them. */
const RECOMMENDATION_MARKERS: ReadonlySet<string> = new Set(['(Recommended)', '（推奨）', '(推奨)']);

/**
 * Whether a row holds a marker and nothing else — the tail of a title that
 * wrapped right before its marker (`❯ 1. 整えた状態で続行` / `(Recommended)`).
 */
export function isRecommendationMarker(row: string): boolean {
  return RECOMMENDATION_MARKERS.has(row.trim());
}

/** One code point that occupies no terminal column. */
const COMBINING_MARK = /^\p{M}$/u;

/**
 * An UPPER bound on the columns a row occupies: printable ASCII is one
 * column, a combining mark none, and anything else is counted as two (East
 * Asian wide characters are two; no other code point is wider). Used with a
 * LOWER bound on the pane width, so "it would have fit" is never claimed for
 * a row that might not have.
 */
export function upperBoundColumns(text: string): number {
  let columns = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code < 0x7f) columns += 1;
    else if (!COMBINING_MARK.test(char)) columns += 2;
  }
  return columns;
}

/**
 * A LOWER bound on the pane width: the widest row of the frame, counting one
 * column per code point (combining marks none). A row the pane drew is never
 * wider than the pane.
 */
export function lowerBoundPaneColumns(rows: readonly string[]): number {
  let widest = 0;
  for (const row of rows) {
    let columns = 0;
    for (const char of row.trimEnd()) {
      if (!COMBINING_MARK.test(char)) columns += 1;
    }
    if (columns > widest) widest = columns;
  }
  return widest;
}

/**
 * Whether `next` cannot be the wrapped tail of `row` — the pane would have
 * kept `next`'s first word on `row`.
 *
 * Terminals word-wrap a title: a row ends early only when the following word
 * would not fit. So when `row` plus a space plus that word fits inside the
 * pane, `row` did not wrap there and `next` begins something else (the
 * option's description). Judged with an upper bound on what the row and the
 * word occupy and a lower bound on the pane, so a `true` is never a guess; a
 * `false` only says the row MAY have wrapped.
 *
 * @param row - The option's row, as drawn (indent and number included)
 * @param next - The row under it
 * @param paneColumns - {@link lowerBoundPaneColumns} of the frame
 */
export function cannotBeWrapOf(row: string, next: string, paneColumns: number): boolean {
  const firstWord = next.trim().split(/\s+/, 1)[0] ?? '';
  if (firstWord === '') return false;
  return upperBoundColumns(row.trimEnd()) + 1 + upperBoundColumns(firstWord) <= paneColumns;
}
