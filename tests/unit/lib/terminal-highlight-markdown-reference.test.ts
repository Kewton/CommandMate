/**
 * Character references split out of terminal-highlight-markdown.ts
 * (Issue #3698): what a reference starting at an offset draws, and where it ends.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { isWhitespace, referenceAt } from '@/lib/terminal-highlight-markdown-reference';
import * as markdown from '@/lib/terminal-highlight-markdown';

describe('[#3698] referenceAt', () => {
  it('a named reference Markdown knows draws its character', () => {
    expect(referenceAt('a &lt; b', 2)).toEqual({ end: 6, drawn: '<' });
  });

  it('a named reference can draw two units (`&fjlig;`) or a surrogate pair (`&Afr;`)', () => {
    expect(referenceAt('&fjlig;', 0)).toEqual({ end: 7, drawn: 'fj' });
    expect(referenceAt('&Afr;', 0)).toEqual({ end: 5, drawn: '\u{1D504}' });
  });

  it('a reference drawing whitespace (`&NewLine;`, `&ThickSpace;`)', () => {
    expect(referenceAt('&NewLine;', 0)).toEqual({ end: 9, drawn: '\n' });
    expect(referenceAt('&ThickSpace;', 0)?.drawn).toBe('  ');
  });

  it('decimal and hex references; one that is no character draws U+FFFD', () => {
    expect(referenceAt('&#10;', 0)).toEqual({ end: 5, drawn: '\n' });
    expect(referenceAt('&#x41;', 0)).toEqual({ end: 6, drawn: 'A' });
    expect(referenceAt('&#0;', 0)).toEqual({ end: 4, drawn: '�' });
    expect(referenceAt('&#xD800;', 0)).toEqual({ end: 8, drawn: '�' });
    expect(referenceAt('&#1114112;', 0)).toEqual({ end: 10, drawn: '�' });
  });

  it('no reference: not at `&`, an unknown name, no `;`', () => {
    expect(referenceAt('a &lt; b', 0)).toBeNull();
    expect(referenceAt('&zzqq;', 0)).toBeNull();
    expect(referenceAt('&lt b', 0)).toBeNull();
  });

  it('only a reference starting exactly at the offset', () => {
    expect(referenceAt('x&amp;', 0)).toBeNull();
    expect(referenceAt('x&amp;', 1)).toEqual({ end: 6, drawn: '&' });
  });
});

describe('[#3698] isWhitespace', () => {
  it('is true for whitespace units and false otherwise', () => {
    expect([' ', '\n', '\t', ' '].map(isWhitespace)).toEqual([true, true, true, true]);
    expect(['a', '&', ';'].map(isWhitespace)).toEqual([false, false, false]);
  });
});

describe('[#3698] the split module is internal', () => {
  it('terminal-highlight-markdown does not re-export the reference helpers', () => {
    expect('referenceAt' in markdown).toBe(false);
    expect('isWhitespace' in markdown).toBe(false);
  });
});
