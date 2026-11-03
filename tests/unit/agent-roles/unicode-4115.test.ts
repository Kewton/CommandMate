/**
 * Issue #4115: the lone surrogate check, without `String.prototype.isWellFormed`,
 * which the server build's `lib` does not have.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { hasLoneSurrogate } from '@/lib/agent-roles/unicode';
import { normalizeRoleName, roleBodyProblem } from '@/lib/agent-roles/validation';
import { renderTomlBasicDocument, toTomlBasicString } from '@/lib/agent-roles/toml-basic';

const HIGH = '\uD83D';
const LOW = '\uDE00';
const PAIR = `${HIGH}${LOW}`; // 😀

describe('hasLoneSurrogate', () => {
  it.each([
    ['a high half alone', `a${HIGH}b`],
    ['a low half alone', `a${LOW}b`],
    ['a high half at the end', `a${HIGH}`],
    ['a low half at the start', `${LOW}a`],
    ['two high halves', `${HIGH}${HIGH}`],
    ['the halves in the wrong order', `${LOW}${HIGH}`],
    ['a pair and then a lone half', `${PAIR}${HIGH}`],
  ])('finds %s', (_name, value) => {
    expect(hasLoneSurrogate(value)).toBe(true);
  });

  it.each([
    ['nothing', ''],
    ['ASCII', 'abc'],
    ['Japanese', '日本語'],
    ['a proper pair', PAIR],
    ['pairs in a row', `${PAIR}${PAIR}`],
    ['the last code unit before the range', '퟿'],
    ['the first code unit after the range', ''],
    ['the highest code point', '\u{10FFFF}'],
  ])('leaves %s alone', (_name, value) => {
    expect(hasLoneSurrogate(value)).toBe(false);
  });

  it('answers the same as isWellFormed on every boundary, repeatedly', () => {
    // The `u` flag and no `g`: no state is carried from one call to the next.
    for (const value of [`a${HIGH}`, PAIR, 'x', `${LOW}`, `${PAIR}${LOW}`, '퟿']) {
      const wellFormed = (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
      expect(hasLoneSurrogate(value)).toBe(!wellFormed);
      expect(hasLoneSurrogate(value)).toBe(!wellFormed);
    }
  });
});

describe('the three places that refuse it', () => {
  it('a body', () => {
    expect(roleBodyProblem(`role ${HIGH}`)).toBe('body must be valid Unicode');
    expect(roleBodyProblem(`role ${PAIR}`)).toBeNull();
  });

  it('a name', () => {
    expect(normalizeRoleName(`role ${LOW}`)).toEqual({ ok: false, problem: 'name must be valid Unicode' });
    expect(normalizeRoleName(`role ${PAIR}`)).toEqual({ ok: true, name: `role ${PAIR}` });
  });

  it('a TOML string', () => {
    expect(() => toTomlBasicString(`x${HIGH}`)).toThrow('A lone surrogate has no TOML spelling');
    expect(toTomlBasicString(`x${PAIR}`)).toBe(`"x${PAIR}"`);
    expect(renderTomlBasicDocument({ a: PAIR })).toBe(`a = "${PAIR}"\n`);
  });
});
