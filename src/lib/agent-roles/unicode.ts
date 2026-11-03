/**
 * Whether a string holds a lone surrogate: UTF-16 no UTF-8 can spell, so it would not
 * come back out of a file or a database byte for byte.
 *
 * With the `u` flag the pattern sees code points, so the two halves of a proper pair
 * are one code point outside the range and only a lone half matches. This is
 * `!value.isWellFormed()`, which the server build's `lib` does not have.
 *
 * @module lib/agent-roles/unicode
 */
export function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDFFF]/u.test(value);
}
