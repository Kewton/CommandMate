/**
 * Terminal COLUMNS, as distinct from UTF-16 units (Issue #2112).
 *
 * Extracted verbatim from `opencode-pane-obstruction.ts`, where Issue #2095
 * introduced it as a private helper, because #2112 reads a second geometry off
 * the same frames — a rectangle's left and right edges rather than a box's right
 * edge — and needs the identical answer to "which character sits at column N".
 * Two copies of a column-counting rule is how the two readings would come to
 * disagree about the same frame while both claiming to measure columns; the
 * repository already makes that argument for `excerpt.ts` and for
 * `status-evidence.ts`.
 *
 * A leaf module by design: it imports nothing, so the detector modules, the
 * payload builder and the client components can all share it.
 *
 * @module lib/detection/terminal-columns
 */

/** One code point that occupies no terminal column. See {@link indexAtColumn}. */
const COMBINING_MARK = /^\p{M}$/u;

/**
 * The UTF-16 index at which terminal column `column` begins.
 *
 * `String.prototype.slice` counts UTF-16 units and this rule is about terminal
 * COLUMNS. The two disagree in two ways, and only one of them can invent a
 * column that is not there:
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
 *    can only shorten an excerpt or miss a second column — never invent one.
 *    It is also exactly what a plain `slice` already did, so nothing regresses.
 *    Carrying a wcwidth table to buy back a few characters of excerpt would put
 *    a second source of truth about character widths in the repository for no
 *    verdict's benefit.
 *
 * Iterates code points, never UTF-16 units, so a surrogate pair is one step.
 */
export function indexAtColumn(line: string, column: number): number {
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

/**
 * The text occupying terminal columns `[left, right)` of one already-stripped
 * row.
 *
 * Both edges go through {@link indexAtColumn}, so the same undercounting applies
 * to both and a slice can only be SHORTER than the true column range — never
 * wider than the rectangle a caller asked about.
 */
export function sliceColumns(line: string, left: number, right: number): string {
  return line.slice(indexAtColumn(line, left), indexAtColumn(line, right));
}

/**
 * How many terminal columns an already-stripped row occupies.
 *
 * Counted with the same rule {@link indexAtColumn} walks, so "column
 * `visibleWidth(line)`" is always one past the row's last cell and never lands
 * inside it.
 */
export function visibleWidth(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (!COMBINING_MARK.test(char)) columns += 1;
  }
  return columns;
}
