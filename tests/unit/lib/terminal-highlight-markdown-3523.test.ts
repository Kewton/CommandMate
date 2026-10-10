/**
 * The raw-range marks Markdown leaves on its elements, read back by search
 * (Issue #3523).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import type { Element as HastElement, Root } from 'hast';
import { collectTextNodes } from '@/lib/terminal-highlight-dom';
import {
  SEARCH_RAW_ATTR,
  mapMarkdownPositionsToDom,
  rehypeSearchRawText,
  searchRawProps,
} from '@/lib/terminal-highlight-markdown';

function hastOf(markdown: string, toRaw?: ((offset: number) => number | null) | null): Root {
  const processor = unified().use(remarkParse).use(remarkRehype);
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  rehypeSearchRawText(toRaw === undefined ? undefined : { toRaw })(tree);
  return tree;
}

function container(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function hitsOf(raw: string, needle: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let k = raw.indexOf(needle); k !== -1; k = raw.indexOf(needle, k + 1)) out.push({ start: k, end: k + needle.length });
  return out;
}

describe('[#3523] rehypeSearchRawText', () => {
  it('marks an element with its range and its own text children', () => {
    const tree = hastOf('**Bold** word');
    const p = tree.children[0] as HastElement;
    expect(p.properties.dataSearchRaw).toBe('0,13;8,13,5');
    expect((p.children[0] as HastElement).properties.dataSearchRaw).toBe('0,8;2,6,4');
  });

  it('marks nothing when the part cannot be mapped', () => {
    const tree = hastOf('**Bold** word', null);
    expect((tree.children[0] as HastElement).properties.dataSearchRaw).toBeUndefined();
  });

  it('searchRawProps passes only the mark on', () => {
    expect(searchRawProps({ [SEARCH_RAW_ATTR]: '0,1', className: 'x' })).toEqual({ [SEARCH_RAW_ATTR]: '0,1' });
    expect(searchRawProps({ className: 'x' })).toEqual({});
  });
});

describe('[#3523] mapMarkdownPositionsToDom', () => {
  it('is null for a container with no marks (terminal, plain-text rows)', () => {
    const el = container('<p>plain <b>sentinel</b></p>');
    expect(mapMarkdownPositionsToDom(el, collectTextNodes(el), 'plain **sentinel**', hitsOf('plain **sentinel**', 'sentinel'))).toBeNull();
  });

  it('places a hit after bold on its word', () => {
    const raw = '**Bold** sentinel';
    const el = container(`<p ${SEARCH_RAW_ATTR}="0,17;8,17,9"><strong ${SEARCH_RAW_ATTR}="0,8;2,6,4">Bold</strong> sentinel</p>`);
    const nodes = collectTextNodes(el);
    const [pos] = mapMarkdownPositionsToDom(el, nodes, raw, hitsOf(raw, 'sentinel'))!;
    expect(el.textContent!.slice(pos!.start, pos!.end)).toBe('sentinel');
  });

  it('places nothing for an element whose text does not add up to its marks', () => {
    const raw = '**Bold** sentinel';
    // An override drew extra text into the paragraph.
    const el = container(`<p ${SEARCH_RAW_ATTR}="0,17;8,17,9">Extra <strong ${SEARCH_RAW_ATTR}="0,8;2,6,4">Bold</strong> sentinel</p>`);
    expect(mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, hitsOf(raw, 'sentinel'))).toEqual([null]);
  });

  it('places a fenced block’s code after its fence line', () => {
    const raw = '```js\nj = js\n```';
    const el = container(`<pre ${SEARCH_RAW_ATTR}="0,16"><code ${SEARCH_RAW_ATTR}="0,16;,,7"><span>j</span> = js\n</code></pre>`);
    const nodes = collectTextNodes(el);
    const result = mapMarkdownPositionsToDom(el, nodes, raw, hitsOf(raw, 'js'))!;
    // The `js` of the fence line is not on screen; the body's is.
    expect(result[0]).toBeNull();
    expect(el.textContent!.slice(result[1]!.start, result[1]!.end)).toBe('js');
    expect(result[1]!.start).toBe(4);
  });
});
