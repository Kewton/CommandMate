/**
 * Placing drawn text on the raw message, split out of
 * terminal-highlight-markdown.ts (Issue #3698).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { collectTextNodes } from '@/lib/terminal-highlight-dom';
import { alignSubsequence, mapMarkdownPositionsToDom, SEARCH_RAW_ATTR } from '@/lib/terminal-highlight-markdown-align';
import * as markdown from '@/lib/terminal-highlight-markdown';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('[#3698] alignSubsequence', () => {
  it('text written as drawn is placed offset for offset', () => {
    expect(alignSubsequence('abc', 'xxabcxx', [{ start: 2, end: 5 }])).toEqual([2, 3, 4]);
  });

  it('skips what Markdown did not draw', () => {
    const raw = '**bold** x';
    expect(alignSubsequence('bold x', raw, [{ start: 0, end: raw.length }])).toEqual([2, 3, 4, 5, 8, 9]);
  });

  it('every unit a reference drew is on its `&`', () => {
    const raw = 'a&fjlig;b';
    expect(alignSubsequence('afjb', raw, [{ start: 0, end: raw.length }])).toEqual([0, 1, 1, 8]);
  });

  it('whitespace with no raw whitespace between its neighbours is left unplaced', () => {
    expect(alignSubsequence('a b', 'ab', [{ start: 0, end: 2 }])).toEqual([0, -1, 1]);
  });

  it('never places a character in the gap between two spans', () => {
    const raw = 'ab\nXX\ncd';
    expect(alignSubsequence('abcd', raw, [{ start: 0, end: 3 }, { start: 6, end: 8 }])).toEqual([0, 1, 6, 7]);
    expect(alignSubsequence('aXd', raw, [{ start: 0, end: 3 }, { start: 6, end: 8 }])).toBeNull();
  });

  it('null when a character is not in the raw text', () => {
    expect(alignSubsequence('az', 'abc', [{ start: 0, end: 3 }])).toBeNull();
  });
});

describe('[#3698] mapMarkdownPositionsToDom', () => {
  function container(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  it('null when nothing is marked (plain offsets stay with the caller)', () => {
    const el = container('<p>plain</p>');
    expect(mapMarkdownPositionsToDom(el, collectTextNodes(el), 'plain', [{ start: 0, end: 5 }])).toBeNull();
  });

  it('places a hit through the marks, past markers Markdown did not draw', () => {
    const raw = 'a **word** b';
    const el = container(`<p ${SEARCH_RAW_ATTR}="0,12;0,2,2"><strong ${SEARCH_RAW_ATTR}="2,10;4,8,4">word</strong></p>`);
    const [pos] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, [{ start: 4, end: 8 }])!;
    expect(pos && el.textContent!.slice(pos.start, pos.end)).toBe('word');
  });

  it('an element whose text does not add up places nothing', () => {
    const raw = 'word';
    const el = container(`<p ${SEARCH_RAW_ATTR}="0,4;0,4,9">word</p>`);
    expect(mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, [{ start: 0, end: 4 }])).toEqual([null]);
  });

  it('is what terminal-highlight-markdown exports', () => {
    expect(markdown.mapMarkdownPositionsToDom).toBe(mapMarkdownPositionsToDom);
    expect(markdown.SEARCH_RAW_ATTR).toBe(SEARCH_RAW_ATTR);
  });
});
