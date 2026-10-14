/**
 * A hit on the whole of a character reference is marked on what it drew,
 * however many units that is (Issue #3682): one (`&lt;` → `<`), or whitespace
 * (`&ThickSpace;` → U+205F U+200A).
 *
 * Before, only a reference drawing two or more non-whitespace units
 * (`&fjlig;`, Issue #3671) could be ended on its `;`; a one-unit reference had
 * nothing there, and the whitespace one was placed nowhere (its units waited
 * for a raw whitespace that is not in the message).
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

describe('[#3682] a hit on the whole of a reference drawing one unit or whitespace', () => {
  it('`&lt;`: the `<` it drew is marked', () => {
    const raw = 'a &lt; b sentinel';
    expect(placed(raw, hitsOf(raw, '&lt;'))).toEqual(['<']);
  });

  it('`&amp;`: the `&` it drew is marked', () => {
    const raw = 'x &amp; y';
    expect(placed(raw, hitsOf(raw, '&amp;'))).toEqual(['&']);
  });

  it('`&ThickSpace;`: both whitespace units it drew are marked', () => {
    const raw = 'a&ThickSpace;b sentinel';
    expect(placed(raw, hitsOf(raw, '&ThickSpace;'))).toEqual(['  ']);
  });

  it('`&ThickSpace;` next to a raw space: the reference and the space are each where they are', () => {
    const raw = 'a &ThickSpace;b';
    expect(placed(raw, [...hitsOf(raw, '&ThickSpace;'), ...hitsOf(raw, ' &ThickSpace;b')])).toEqual([
      '  ',
      '   b',
    ]);
  });
});

describe('[#3682] negative controls: what was placed before is placed as before', () => {
  it('a hit ending inside the reference’s name is still not placed', () => {
    expect(placed('a &lt; b', [{ start: 2, end: 4 }])).toEqual([null]);
    expect(placed('a&ThickSpace;b', [{ start: 1, end: 6 }])).toEqual([null]);
  });

  it('a hit on the letters of the name alone is still not placed', () => {
    const raw = 'first &lt; then lt here';
    expect(placed(raw, [{ start: 7, end: 9 }])).toEqual([null]);
  });

  it('a hit on the `&` of `&lt;` alone still marks the `<` it drew', () => {
    expect(placed('a &lt; b', [{ start: 2, end: 3 }])).toEqual(['<']);
  });

  it('a hit from the reference through the word after it covers both, as before', () => {
    const raw = 'a &lt; sentinel';
    expect(placed(raw, hitsOf(raw, '&lt; sentinel'))).toEqual(['< sentinel']);
    const thick = 'a&ThickSpace;b sentinel';
    expect(placed(thick, hitsOf(thick, 'b sentinel'))).toEqual(['b sentinel']);
  });

  it('the words around the references are still marked', () => {
    const raw = 'x&ThickSpace;y &lt; sentinel';
    expect(placed(raw, [...hitsOf(raw, 'x'), ...hitsOf(raw, 'y'), ...hitsOf(raw, 'sentinel')])).toEqual([
      'x',
      'y',
      'sentinel',
    ]);
  });

  it('`&lt;` and `&amp;` in inline code are still placed as written', () => {
    const raw = 'use `&lt; &amp;` then';
    expect(placed(raw, [...hitsOf(raw, '&lt;'), ...hitsOf(raw, '&amp;')])).toEqual(['&lt;', '&amp;']);
  });
});
