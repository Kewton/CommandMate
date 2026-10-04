/** How many non-blank rows above the options may hold the question. */
const QUESTION_SCAN_ROWS = 4;

/**
 * The non-blank rows above `firstRow`, nearest first, joined by newlines.
 * Rows at or above `floorRow` are not read: pass -1 to read to the top of the
 * frame.
 */
export function readContextAbove(
  lines: readonly string[],
  firstRow: number,
  floorRow: number,
): string {
  const rows: string[] = [];
  for (let i = firstRow - 1; i > floorRow && rows.length < QUESTION_SCAN_ROWS; i--) {
    const row = lines[i].trim();
    if (row === '') continue;
    rows.push(row);
  }
  return rows.join('\n');
}
