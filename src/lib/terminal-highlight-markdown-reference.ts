/**
 * terminal-highlight-markdown-reference.ts
 * Character references (`&lt;`, `&#10;`, `&NewLine;`) in the raw message, and
 * what Markdown draws for them (Issue #3698: split out of
 * terminal-highlight-markdown.ts).
 */

const CHARACTER_REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/y;

export const isWhitespace = (unit: string): boolean => /\s/.test(unit);

/**
 * What a numeric reference draws, as micromark decodes it: a code point that
 * is not a character to draw (a control, a surrogate, a noncharacter, past
 * U+10FFFF) draws U+FFFD.
 */
function drawnByNumber(code: number): string {
  if (
    code < 9 ||
    code === 11 ||
    (code > 13 && code < 32) ||
    (code > 126 && code < 160) ||
    (code > 55295 && code < 57344) ||
    (code > 64975 && code < 65008) ||
    (code & 65535) === 65535 ||
    (code & 65535) === 65534 ||
    code > 1114111
  ) {
    return '\uFFFD';
  }
  return String.fromCodePoint(code);
}

const drawnByName = new Map<string, string | null>();

/**
 * What a named reference draws, or `null` for a name Markdown does not know
 * (it is then drawn as written). Read through the DOM's HTML decoder, which
 * knows the same HTML names micromark does; the search runs where there is a
 * DOM. Without one, every name is taken as drawn as written.
 */
function drawnByNamed(reference: string): string | null {
  const known = drawnByName.get(reference);
  if (known !== undefined) return known;
  let drawn: string | null = null;
  if (typeof DOMParser !== 'undefined') {
    // `reference` is `&name;` and nothing else (CHARACTER_REFERENCE): no markup
    // of its own. Inside an element, so a reference that draws whitespace is
    // not dropped as whitespace before the body.
    const decoded = new DOMParser().parseFromString(`<b>${reference}</b>`, 'text/html').body.textContent ?? '';
    drawn = decoded !== reference && decoded !== '' ? decoded : null;
  }
  drawnByName.set(reference, drawn);
  return drawn;
}

/**
 * [Issue #3661] The character reference (`&lt;`, `&#10;`, `&NewLine;`,
 * `&fjlig;`) that starts at `at` in `raw`: where it ends, and what it draws —
 * one or more UTF-16 units (`&fjlig;` draws `fj`, `&Afr;` a surrogate pair).
 * `null` when none starts there, or the name is not one Markdown knows.
 */
export function referenceAt(raw: string, at: number): { end: number; drawn: string } | null {
  CHARACTER_REFERENCE.lastIndex = at;
  const match = CHARACTER_REFERENCE.exec(raw);
  if (!match) return null;
  const end = at + match[0].length;
  const drawn =
    match[3] !== undefined
      ? drawnByNamed(match[0])
      : drawnByNumber(Number.parseInt(match[1] ?? match[2], match[1] !== undefined ? 10 : 16));
  return drawn === null ? null : { end, drawn };
}
