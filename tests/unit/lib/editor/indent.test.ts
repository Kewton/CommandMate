/**
 * Tests for the indent/outdent pure functions (Issue #1518).
 */

import { describe, it, expect } from 'vitest';
import { applyIndent, applyOutdent, type IndentEdit } from '@/lib/editor/indent';
import { INDENT_UNIT } from '@/types/markdown-editor';

/** Apply an edit the way the editor does, so `value` and the slice agree. */
function applied(value: string, edit: IndentEdit): string {
  return value.slice(0, edit.replaceStart) + edit.replacement + value.slice(edit.replaceEnd);
}

describe('applyIndent', () => {
  it('inserts a full unit at the start of a line', () => {
    const edit = applyIndent('hello', 0, 0, INDENT_UNIT);
    expect(edit.value).toBe('  hello');
    expect(edit.replacement).toBe('  ');
    expect(edit.selectionStart).toBe(2);
    expect(edit.selectionEnd).toBe(2);
  });

  it('aligns to the next tab stop from an odd column', () => {
    // caret after "h" (column 1) -> only 1 space to reach column 2
    const edit = applyIndent('hello', 1, 1, INDENT_UNIT);
    expect(edit.value).toBe('h ello');
    expect(edit.replacement).toBe(' ');
    expect(edit.selectionStart).toBe(2);
  });

  it('computes the column from the current line, not the document start', () => {
    const value = 'ab\ncdef';
    // caret after "cde" -> column 3 -> 1 space
    const edit = applyIndent(value, 6, 6, INDENT_UNIT);
    expect(edit.replacement).toBe(' ');
    expect(edit.value).toBe('ab\ncde f');
  });

  it('replaces a single-line selection with the indent', () => {
    const edit = applyIndent('abcd', 1, 3, INDENT_UNIT);
    expect(edit.value).toBe('a d');
    expect(edit.selectionStart).toBe(2);
    expect(edit.selectionEnd).toBe(2);
  });

  it('indents every line of a multi-line selection and keeps the block selected', () => {
    const value = 'one\ntwo\nthree';
    const edit = applyIndent(value, 0, value.length, INDENT_UNIT);
    expect(edit.value).toBe('  one\n  two\n  three');
    expect(edit.selectionStart).toBe(0);
    expect(edit.selectionEnd).toBe(edit.value.length);
  });

  it('expands a partial multi-line selection to whole lines', () => {
    const value = 'one\ntwo\nthree';
    // from inside "one" to inside "two"
    const edit = applyIndent(value, 2, 5, INDENT_UNIT);
    expect(edit.value).toBe('  one\n  two\nthree');
    expect(edit.replaceStart).toBe(0);
  });

  it('does not pull in the next line when the selection ends at a line start', () => {
    const value = 'one\ntwo\nthree';
    const edit = applyIndent(value, 0, 4, INDENT_UNIT);
    expect(edit.value).toBe('  one\ntwo\nthree');
  });

  it('skips blank lines so Markdown hard breaks are not created', () => {
    const value = 'one\n\ntwo';
    const edit = applyIndent(value, 0, value.length, INDENT_UNIT);
    expect(edit.value).toBe('  one\n\n  two');
  });

  it('preserves CRLF line endings', () => {
    const value = 'one\r\ntwo\r\n';
    const edit = applyIndent(value, 0, value.length, INDENT_UNIT);
    expect(edit.value).toBe('  one\r\n  two\r\n');
  });

  it('never inserts a tab character', () => {
    const edit = applyIndent('x\ny', 0, 3, INDENT_UNIT);
    expect(edit.replacement).not.toContain('\t');
  });

  it('produces a value consistent with its replacement range', () => {
    const value = 'alpha\nbeta';
    const edit = applyIndent(value, 0, value.length, INDENT_UNIT);
    expect(applied(value, edit)).toBe(edit.value);
  });
});

describe('applyOutdent', () => {
  it('removes one unit from the caret line', () => {
    const edit = applyOutdent('    deep', 6, 6, INDENT_UNIT);
    expect(edit?.value).toBe('  deep');
    expect(edit?.selectionStart).toBe(4);
  });

  it('removes only the available spaces when fewer than a unit', () => {
    const edit = applyOutdent(' x', 2, 2, INDENT_UNIT);
    expect(edit?.value).toBe('x');
    expect(edit?.selectionStart).toBe(1);
  });

  it('clamps the caret to the line start when it sits inside the removed run', () => {
    const edit = applyOutdent('    deep', 1, 1, INDENT_UNIT);
    expect(edit?.value).toBe('  deep');
    expect(edit?.selectionStart).toBe(0);
  });

  it('removes a leading tab as a single unit', () => {
    const edit = applyOutdent('\tdeep', 5, 5, INDENT_UNIT);
    expect(edit?.value).toBe('deep');
  });

  it('returns null with no selection and nothing to remove (keyboard escape hatch)', () => {
    expect(applyOutdent('flush', 3, 3, INDENT_UNIT)).toBeNull();
  });

  it('outdents each line of a multi-line selection and keeps the block selected', () => {
    const value = '  one\n  two';
    const edit = applyOutdent(value, 0, value.length, INDENT_UNIT);
    expect(edit?.value).toBe('one\ntwo');
    expect(edit?.selectionStart).toBe(0);
    expect(edit?.selectionEnd).toBe('one\ntwo'.length);
  });

  it('skips lines without leading whitespace instead of failing the block', () => {
    const value = '  one\ntwo\n  three';
    const edit = applyOutdent(value, 0, value.length, INDENT_UNIT);
    expect(edit?.value).toBe('one\ntwo\nthree');
  });

  it('handles mixed tab and space indentation in one block', () => {
    const value = '\tone\n    two';
    const edit = applyOutdent(value, 0, value.length, INDENT_UNIT);
    expect(edit?.value).toBe('one\n  two');
  });

  it('preserves CRLF line endings', () => {
    const value = '  one\r\n  two\r\n';
    const edit = applyOutdent(value, 0, value.length, INDENT_UNIT);
    expect(edit?.value).toBe('one\r\ntwo\r\n');
  });

  it('returns a no-op edit (not null) when a selection has nothing to remove', () => {
    const value = 'one\ntwo';
    const edit = applyOutdent(value, 0, value.length, INDENT_UNIT);
    expect(edit).not.toBeNull();
    expect(edit?.value).toBe(value);
  });

  it('produces a value consistent with its replacement range', () => {
    const value = '    alpha\n    beta';
    const edit = applyOutdent(value, 0, value.length, INDENT_UNIT)!;
    expect(applied(value, edit)).toBe(edit.value);
  });
});
