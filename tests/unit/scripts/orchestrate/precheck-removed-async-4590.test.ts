/**
 * scripts/orchestrate/precheck.mjs `countRemovedTests` — Issue #4590.
 *
 * What this pins: a test whose name and call chain (`it` / `test` / `describe`
 * with `.skip` / `.only` / `.todo` / `.each(...)`) stay the same, with only the
 * function's shape changed (`() =>` → `async () =>`, `function () {` →
 * `async function () {`, `(n) =>` → `async (n) =>`, an added `{ timeout }`), is
 * not counted as removed. Renaming, deleting, or changing the call chain still
 * counts; a line whose name cannot be read is compared as the whole line.
 *
 * Out of scope: keeping a name and swapping the body for an empty one on
 * purpose — that is a review's call, not this check's.
 *
 * The inputs are diff strings; nothing outside os.tmpdir() is written.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { countRemovedTests } from '../../../../scripts/orchestrate/precheck.mjs';

const diff = (...parts: string[]) => parts.join('\n');

describe('countRemovedTests: a test kept while only its function shape changes (#4590)', () => {
  it('R1: does not count `() =>` replaced by `async () =>` under the same name', () => {
    expect(
      countRemovedTests(diff("-  it('parses the note', () => {", "+  it('parses the note', async () => {"))
    ).toEqual([]);
  });

  it('R2: does not count `function () {` replaced by `async function () {` under the same name', () => {
    expect(
      countRemovedTests(diff("-  it('parses the note', function () {", "+  it('parses the note', async function () {"))
    ).toEqual([]);
  });

  it('R3 (positive): counts a renamed test', () => {
    expect(countRemovedTests(diff("-  it('old name', () => {", "+  it('new name', () => {"))).toEqual([
      "it('old name', () => {",
    ]);
  });

  it('R4 (positive): counts a deleted test', () => {
    expect(countRemovedTests("-  it('gone', () => {")).toEqual(["it('gone', () => {"]);
  });

  it('R5 (positive): counts a changed call chain (.skip / .only / .todo)', () => {
    for (const [before, after] of [
      ["it('x', () => {", "it.skip('x', () => {"],
      ["it('x', () => {", "it.only('x', () => {"],
      ["test('x', () => {", "test.todo('x')"],
    ]) {
      expect(countRemovedTests(diff(`-  ${before}`, `+  ${after}`))).toEqual([before]);
    }
  });

  it('R6: compares a line without a readable name as the whole line', () => {
    expect(countRemovedTests(diff('-  it(', '+    it('))).toEqual([]);
    expect(countRemovedTests(diff('-  it(', '+  test('))).toEqual(['it(']);
    // The first argument is a variable, not a string literal: the whole line decides.
    expect(countRemovedTests(diff('-  it(name, () => {', '+  it(name, async () => {'))).toEqual([
      'it(name, () => {',
    ]);
  });

  it('R7: returns the removed line string, not the matching key', () => {
    expect(
      countRemovedTests(
        diff(
          "-  it('stable', () => {",
          "+  it('stable', async () => {",
          "-  it('renamed', () => {",
          "+  it('renamed!', () => {"
        )
      )
    ).toEqual(["it('renamed', () => {"]);
  });

  it('R8 (positive): ignores argument-shape changes but counts a changed .each', () => {
    expect(countRemovedTests(diff("-  it('adds', (n) => {", "+  it('adds', async (n) => {"))).toEqual([]);
    expect(countRemovedTests(diff("-  it('waits', () => {", "+  it('waits', { timeout: 5000 }, () => {"))).toEqual([]);
    expect(
      countRemovedTests(
        diff("-  it.each([1, 2])('case %i', (n) => {", "+  it.each([1, 2, 3])('case %i', (n) => {")
      )
    ).toEqual(["it.each([1, 2])('case %i', (n) => {"]);
  });
});

describe('countRemovedTests: only a literal standing as the whole first argument names a test (#4590 review)', () => {
  it('R9 (positive): counts a concatenated first argument (not a literal on its own)', () => {
    expect(
      countRemovedTests(diff("-  it('loads ' + FILE_A, () => {", "+  it('loads ' + FILE_B, () => {"))
    ).toEqual(["it('loads ' + FILE_A, () => {"]);
  });

  it('R10 (positive): counts a template literal with ${…} in the name', () => {
    expect(
      countRemovedTests(
        diff(
          '-  it(`a ${x ? `b` : `c`} one`, () => {',
          '+  it(`a ${x ? `b` : `c`} two`, () => {'
        )
      )
    ).toEqual(['it(`a ${x ? `b` : `c`} one`, () => {']);
  });

  it('R11: reads an escaped quote as part of the name, not as the end of the literal', () => {
    expect(countRemovedTests(diff("-  it('it\\'s ok', () => {", "+  it('it\\'s ok', async () => {"))).toEqual([]);
    expect(countRemovedTests(diff("-  it('it\\'s ok', () => {", "+  it('it\\'s bad', () => {"))).toEqual([
      "it('it\\'s ok', () => {",
    ]);
  });

  it('R12: compares a template literal with ${…} as the whole line (N3 side)', () => {
    expect(countRemovedTests(diff('-  it(`case ${n}`, () => {', '+  it(`case ${n}`, async () => {'))).toEqual([
      'it(`case ${n}`, () => {',
    ]);
  });
});
