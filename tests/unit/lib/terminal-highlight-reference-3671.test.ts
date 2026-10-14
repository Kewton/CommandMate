/**
 * A hit on the whole of a character reference that draws two UTF-16 units
 * (`&fjlig;` draws `fj`, `&Afr;` a surrogate pair) marks every unit it drew
 * (Issue #3671).
 *
 * Before, the raw-to-DOM map kept one DOM unit per raw offset — the first one
 * a reference drew, on its `&` — and nothing on the reference's last raw
 * character (`;`), so a hit ending there was not placed at all.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import type { Element as HastElement, Root } from 'hast';
import { collectTextNodes } from '@/lib/terminal-highlight-dom';
import { mapMarkdownPositionsToDom, rehypeSearchRawText, SEARCH_RAW_ATTR } from '@/lib/terminal-highlight-markdown';

afterEach(() => {
  document.body.innerHTML = '';
});

function rendered(markdown: string): HTMLElement {
  const processor = unified().use(remarkParse).use(remarkRehype);
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  rehypeSearchRawText()(tree, { value: markdown });
  const el = document.createElement('div');
  const toHtml = (node: Root | HastElement | Root['children'][number]): string => {
    if (node.type === 'text') return node.value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (node.type === 'root') return node.children.map(toHtml).join('');
    if (node.type !== 'element') return '';
    const raw = node.properties.dataSearchRaw;
    const attr = typeof raw === 'string' ? ` ${SEARCH_RAW_ATTR}="${raw}"` : '';
    return `<${node.tagName}${attr}>${node.children.map(toHtml).join('')}</${node.tagName}>`;
  };
  el.innerHTML = toHtml(tree);
  document.body.appendChild(el);
  return el;
}

function hitsOf(raw: string, needle: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let k = raw.indexOf(needle); k !== -1; k = raw.indexOf(needle, k + 1)) out.push({ start: k, end: k + needle.length });
  return out;
}

function placed(raw: string, positions: Array<{ start: number; end: number }>): Array<string | null> {
  const el = rendered(raw);
  return mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, positions)!.map((pos) =>
    pos ? el.textContent!.slice(pos.start, pos.end) : null,
  );
}

describe('[#3671] a hit on the whole of a reference drawing two units', () => {
  it('`&fjlig;`: both characters it drew are marked', () => {
    const raw = 'a &fjlig; b sentinel';
    expect(placed(raw, hitsOf(raw, '&fjlig;'))).toEqual(['fj']);
  });

  it('`&fjlig;` at the start of the text: both characters, and the word after it', () => {
    const raw = '&fjlig; sentinel';
    expect(placed(raw, [...hitsOf(raw, '&fjlig;'), ...hitsOf(raw, 'sentinel')])).toEqual(['fj', 'sentinel']);
  });

  it('`&Afr;`: both units of the surrogate pair it drew are marked', () => {
    const raw = 'x &Afr; y';
    expect(placed(raw, hitsOf(raw, '&Afr;'))).toEqual(['\u{1D504}']);
  });
});

describe('[#3671] negative controls: what was placed before is placed as before', () => {
  it('the word after the reference is still marked', () => {
    const raw = '&fjlig; sentinel';
    expect(placed(raw, hitsOf(raw, 'sentinel'))).toEqual(['sentinel']);
  });

  it('a hit from the reference through the word after it covers both, as before', () => {
    const raw = '&fjlig; sentinel';
    expect(placed(raw, hitsOf(raw, '&fjlig; sentinel'))).toEqual(['fj sentinel']);
  });

  it('a hit on the `&` alone still marks only the first character it drew', () => {
    expect(placed('&fjlig; sentinel', [{ start: 0, end: 1 }])).toEqual(['f']);
  });

  it('a hit ending inside the reference’s name is still not placed', () => {
    expect(placed('&fjlig; sentinel', [{ start: 0, end: 3 }])).toEqual([null]);
  });

  it('a reference drawing one character is still not placed by a hit on its whole', () => {
    // As `terminal-highlight-3661.test.ts` keeps it: `&lt;`'s last raw
    // character is not drawn. Only a run of units on one `&` reaches `;`.
    const raw = 'a &lt; b';
    expect(placed(raw, hitsOf(raw, '&lt;'))).toEqual([null]);
  });

  it('`&fjlig;` in inline code is still placed as written', () => {
    const raw = 'use `&fjlig;` then';
    expect(placed(raw, hitsOf(raw, '&fjlig;'))).toEqual(['&fjlig;']);
  });
});
