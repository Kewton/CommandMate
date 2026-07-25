/**
 * Textarea indent / outdent computation (Issue #1518)
 *
 * Pure functions: they take the current textarea value plus the selection and
 * return the edit to apply. Keeping them free of DOM access lets the editor
 * apply the result through `document.execCommand('insertText')` (so a single
 * Ctrl+Z undoes it) and fall back to React state where that is unavailable.
 *
 * @module lib/editor/indent
 */

/** A computed replacement plus the selection to restore afterwards. */
export interface IndentEdit {
  /** Start offset of the range to replace in the original value. */
  replaceStart: number;
  /** End offset of the range to replace in the original value. */
  replaceEnd: number;
  /** Text to write over `[replaceStart, replaceEnd)`. */
  replacement: string;
  /** Selection start to restore after applying. */
  selectionStart: number;
  /** Selection end to restore after applying. */
  selectionEnd: number;
  /** The full value after applying the replacement. */
  value: string;
}

/** Offset of the first character of the line containing `offset`. */
function lineStartAt(value: string, offset: number): number {
  return value.lastIndexOf('\n', offset - 1) + 1;
}

/** Offset just past the last character of the line containing `offset`. */
function lineEndAt(value: string, offset: number): number {
  const next = value.indexOf('\n', offset);
  return next === -1 ? value.length : next;
}

/**
 * The line range a selection acts on. A selection that ends exactly at a line
 * start (the usual result of selecting whole lines) does not drag the following
 * line into the operation.
 */
function blockRange(
  value: string,
  selStart: number,
  selEnd: number
): { start: number; end: number } {
  const effectiveEnd =
    selEnd > selStart && selEnd > 0 && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
  return { start: lineStartAt(value, selStart), end: lineEndAt(value, effectiveEnd) };
}

function buildEdit(
  value: string,
  replaceStart: number,
  replaceEnd: number,
  replacement: string,
  selectionStart: number,
  selectionEnd: number
): IndentEdit {
  return {
    replaceStart,
    replaceEnd,
    replacement,
    selectionStart,
    selectionEnd,
    value: value.slice(0, replaceStart) + replacement + value.slice(replaceEnd),
  };
}

/** True for a line with no content — `''`, or `'\r'` on a CRLF file. */
function isBlankLine(line: string): boolean {
  return line === '' || line === '\r';
}

/**
 * Indent the selection by one `unit`.
 *
 * A selection spanning several lines prefixes every non-blank line in the range
 * and keeps the whole block selected. Otherwise `unit`-aligned spaces are
 * inserted at the caret (replacing any selection), so pressing Tab mid-word
 * lands on the next tab stop rather than always adding `unit.length` spaces.
 *
 * Blank lines are skipped: in Markdown a line holding only spaces is a hard
 * line break, so padding them would change how the document renders.
 */
export function applyIndent(
  value: string,
  selStart: number,
  selEnd: number,
  unit: string
): IndentEdit {
  const isMultiLine = selEnd > selStart && value.slice(selStart, selEnd).includes('\n');

  if (!isMultiLine) {
    const column = selStart - lineStartAt(value, selStart);
    const spaces = unit.length - (column % unit.length);
    const replacement = ' '.repeat(spaces);
    const caret = selStart + replacement.length;
    return buildEdit(value, selStart, selEnd, replacement, caret, caret);
  }

  const { start, end } = blockRange(value, selStart, selEnd);
  const replacement = value
    .slice(start, end)
    .split('\n')
    .map((line) => (isBlankLine(line) ? line : unit + line))
    .join('\n');

  return buildEdit(value, start, end, replacement, start, start + replacement.length);
}

/**
 * Remove up to one `unit` of leading whitespace from the start of `line`.
 * A leading tab counts as one unit so that files already indented with tabs can
 * still be outdented, even though we only ever insert spaces.
 */
function outdentLine(line: string, unit: string): string {
  if (line.startsWith('\t')) return line.slice(1);

  let removed = 0;
  while (removed < unit.length && line[removed] === ' ') {
    removed += 1;
  }
  return line.slice(removed);
}

/**
 * Outdent the selection by one `unit`.
 *
 * Returns `null` when there is nothing to remove and no selection — the caller
 * then lets the browser's default Shift+Tab run, which is the escape hatch out
 * of the textarea required by WCAG 2.1.2 (No Keyboard Trap).
 *
 * Lines without leading whitespace are left alone rather than skipping the
 * whole operation, so outdenting a mixed block does not fail on one flush line.
 */
export function applyOutdent(
  value: string,
  selStart: number,
  selEnd: number,
  unit: string
): IndentEdit | null {
  const { start, end } = blockRange(value, selStart, selEnd);
  const original = value.slice(start, end);
  const replacement = original
    .split('\n')
    .map((line) => outdentLine(line, unit))
    .join('\n');

  if (replacement === original) {
    return selStart === selEnd ? null : buildEdit(value, start, end, replacement, selStart, selEnd);
  }

  if (selStart === selEnd) {
    const removedBeforeCaret = Math.min(
      original.length - replacement.length,
      Math.max(0, selStart - start)
    );
    const caret = selStart - removedBeforeCaret;
    return buildEdit(value, start, end, replacement, caret, caret);
  }

  return buildEdit(value, start, end, replacement, start, start + replacement.length);
}
