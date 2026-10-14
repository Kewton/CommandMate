/**
 * Search highlighting across several message containers, and the edge inputs
 * the #3554 review found in placing hits through Markdown's raw ranges
 * (Issue #3661).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import type { Element as HastElement, Root } from 'hast';
import { collectTextNodes } from '@/lib/terminal-highlight-dom';
import { mapMarkdownPositionsToDom, rehypeSearchRawText, SEARCH_RAW_ATTR } from '@/lib/terminal-highlight-markdown';
import { mapDerivedLines, type RawOffsetMapper } from '@/lib/terminal-highlight-offsets';
import {
  applyHistoryHighlights,
  applyTerminalHighlights,
  clearHistoryHighlights,
  makeHistoryNamespace,
} from '@/lib/terminal-highlight';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

let registry: Map<string, FakeHighlight>;
let originalCSS: PropertyDescriptor | undefined;
let originalHighlight: PropertyDescriptor | undefined;
let originalRangeRect: PropertyDescriptor | undefined;
const NAMESPACE = makeHistoryNamespace(3);

beforeEach(() => {
  registry = new Map();
  originalCSS = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
  originalHighlight = Object.getOwnPropertyDescriptor(globalThis, 'Highlight');
  originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  Object.defineProperty(globalThis, 'CSS', { value: { highlights: registry }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Highlight', { value: FakeHighlight, configurable: true, writable: true });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value: () => ({ top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  clearHistoryHighlights(NAMESPACE);
  document.body.innerHTML = '';
  if (originalRangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeRect);
  else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  if (originalCSS) Object.defineProperty(globalThis, 'CSS', originalCSS);
  else delete (globalThis as { CSS?: unknown }).CSS;
  if (originalHighlight) Object.defineProperty(globalThis, 'Highlight', originalHighlight);
  else delete (globalThis as { Highlight?: unknown }).Highlight;
});

function mounted(text: string): HTMLElement {
  const el = document.createElement('div');
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

function hitsOf(raw: string, needle: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let k = raw.indexOf(needle); k !== -1; k = raw.indexOf(needle, k + 1)) out.push({ start: k, end: k + needle.length });
  return out;
}

const marked = (name = NAMESPACE.highlightName): string[] =>
  (registry.get(name)?.ranges ?? []).map((range) => range.toString());

const overlay = (): HTMLElement | null => document.getElementById(NAMESPACE.fallbackOverlayId);

describe('[#3661] several containers under one namespace', () => {
  it('marks the hits of every container, not only the last one called', () => {
    const first = mounted('one alpha');
    const second = mounted('two beta');
    applyHistoryHighlights(first, [{ start: 4, end: 9 }], -1, NAMESPACE);
    applyHistoryHighlights(second, [{ start: 4, end: 8 }], -1, NAMESPACE);
    expect(marked()).toEqual(['alpha', 'beta']);
  });

  it('the overlay stays on the container that holds the current hit when another is called after it', () => {
    const first = mounted('one alpha');
    const second = mounted('two beta');
    applyHistoryHighlights(first, [{ start: 4, end: 9 }], 0, NAMESPACE);
    applyHistoryHighlights(second, [{ start: 4, end: 8 }], -1, NAMESPACE);
    expect(first.contains(overlay())).toBe(true);
    expect(marked()).toEqual(['beta']);
  });

  it('the overlay moves into the container that now holds the current hit', () => {
    const first = mounted('one alpha');
    const second = mounted('two beta');
    applyHistoryHighlights(first, [{ start: 4, end: 9 }], 0, NAMESPACE);
    applyHistoryHighlights(second, [{ start: 4, end: 8 }], 0, NAMESPACE);
    applyHistoryHighlights(first, [{ start: 4, end: 9 }], -1, NAMESPACE);
    expect(second.contains(overlay())).toBe(true);
    expect(document.querySelectorAll(`#${NAMESPACE.fallbackOverlayId}`)).toHaveLength(1);
    expect(marked()).toEqual(['alpha']);
  });

  it('a container called again replaces only its own marks; with no hits it drops only its own', () => {
    const first = mounted('one alpha alpha');
    const second = mounted('two beta');
    applyHistoryHighlights(first, [{ start: 4, end: 9 }, { start: 10, end: 15 }], -1, NAMESPACE);
    applyHistoryHighlights(second, [{ start: 4, end: 8 }], -1, NAMESPACE);
    applyHistoryHighlights(first, [{ start: 10, end: 15 }], -1, NAMESPACE);
    expect(marked()).toEqual(['alpha', 'beta']);
    applyHistoryHighlights(first, [], -1, NAMESPACE);
    expect(marked()).toEqual(['beta']);
  });

  it('a container no longer in the document is dropped', () => {
    const first = mounted('one alpha');
    const second = mounted('two beta');
    applyHistoryHighlights(first, [{ start: 4, end: 9 }], -1, NAMESPACE);
    first.remove();
    applyHistoryHighlights(second, [{ start: 4, end: 8 }], -1, NAMESPACE);
    expect(marked()).toEqual(['beta']);
  });

  it('clearing the namespace forgets every container', () => {
    const first = mounted('one alpha');
    const second = mounted('two beta');
    applyHistoryHighlights(first, [{ start: 4, end: 9 }], -1, NAMESPACE);
    clearHistoryHighlights(NAMESPACE);
    expect(registry.has(NAMESPACE.highlightName)).toBe(false);
    applyHistoryHighlights(second, [{ start: 4, end: 8 }], -1, NAMESPACE);
    expect(marked()).toEqual(['beta']);
  });

  it('negative control: namespaces stay apart, and one terminal container is replaced as before', () => {
    const history = mounted('one alpha');
    const terminal = mounted('three gamma delta');
    applyHistoryHighlights(history, [{ start: 4, end: 9 }], -1, NAMESPACE);
    applyTerminalHighlights(terminal, [{ start: 6, end: 11 }, { start: 12, end: 17 }], 0);
    applyTerminalHighlights(terminal, [{ start: 6, end: 11 }, { start: 12, end: 17 }], 1);
    expect(marked()).toEqual(['alpha']);
    expect(marked('terminal-search')).toEqual(['gamma']);
    applyTerminalHighlights(terminal, [], 0);
    expect(registry.has('terminal-search')).toBe(false);
  });
});

/** The paragraph of `markdown` rendered with its raw marks, as the DOM. */
function rendered(markdown: string, toRaw?: RawOffsetMapper): HTMLElement {
  const processor = unified().use(remarkParse).use(remarkRehype);
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  rehypeSearchRawText(toRaw ? { toRaw, source: markdown } : undefined)(tree, { value: markdown });
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

describe('[#3661] edge 1: a `&NewLine;` in a paragraph', () => {
  it('does not take the next raw line break: the text after it is placed on its line', () => {
    const raw = 'alpha&NewLine;beta\nsentinel gamma';
    const el = rendered(raw);
    expect(el.textContent).toBe('alpha\nbeta\nsentinel gamma');
    const [pos] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, hitsOf(raw, 'sentinel'))!;
    expect(el.textContent!.slice(pos!.start, pos!.end)).toBe('sentinel');
  });

  it('a letter of the reference’s name is not a place for the text after it', () => {
    const raw = 'alpha&NewLine;exit\nmore';
    const el = rendered(raw);
    const [pos] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, hitsOf(raw, 'exit'))!;
    expect(el.textContent!.slice(pos!.start, pos!.end)).toBe('exit');
  });

  it('a reference that draws a character is placed on its `&`', () => {
    const raw = 'a &lt; b sentinel';
    const el = rendered(raw);
    const [lt, hit] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, [...hitsOf(raw, '&lt;'), ...hitsOf(raw, 'sentinel')])!;
    expect(lt).toBeNull(); // its last character is not drawn
    expect(el.textContent!.slice(hit!.start, hit!.end)).toBe('sentinel');
  });

  it('a reference drawing two characters places both on its `&`, and the words after it', () => {
    const raw = '&fjlig; sentinel sentinel';
    const el = rendered(raw);
    expect(el.textContent).toBe('fj sentinel sentinel');
    const positions = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, hitsOf(raw, 'sentinel'))!;
    expect(positions.map((pos) => el.textContent!.slice(pos!.start, pos!.end))).toEqual(['sentinel', 'sentinel']);
    // A hit on the reference's `&` alone (raw 0..1) is placed on the first
    // character it drew (DOM 0..1). A hit on its whole is in
    // `terminal-highlight-reference-3671.test.ts`.
    const [whole] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, [{ start: 0, end: 1 }])!;
    expect(whole).toEqual({ start: 0, end: 1 });
  });

  it('a reference drawing a surrogate pair places both units, and the words after it', () => {
    const raw = '&Afr; sentinel sentinel';
    const el = rendered(raw);
    expect(el.textContent).toBe('\u{1D504} sentinel sentinel');
    const positions = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, hitsOf(raw, 'sentinel'))!;
    expect(positions.map((pos) => el.textContent!.slice(pos!.start, pos!.end))).toEqual(['sentinel', 'sentinel']);
  });

  it('a numeric reference drawing a surrogate pair places both units, and the words after it', () => {
    const raw = '&#x1F600; sentinel';
    const el = rendered(raw);
    expect(el.textContent).toBe('\u{1F600} sentinel');
    const [pos] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, hitsOf(raw, 'sentinel'))!;
    expect(el.textContent!.slice(pos!.start, pos!.end)).toBe('sentinel');
  });

  it('negative control: a name Markdown does not know is drawn as written and placed as written', () => {
    const raw = 'an &unknownname; then sentinel';
    const el = rendered(raw);
    expect(el.textContent).toBe(raw);
    const [name, hit] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, [...hitsOf(raw, 'unknownname'), ...hitsOf(raw, 'sentinel')])!;
    expect(el.textContent!.slice(name!.start, name!.end)).toBe('unknownname');
    expect(el.textContent!.slice(hit!.start, hit!.end)).toBe('sentinel');
  });

  it('negative control: `&fjlig;` in inline code is drawn as written and placed as written', () => {
    const raw = 'use `&fjlig;` then sentinel';
    const el = rendered(raw);
    expect(el.textContent).toBe('use &fjlig; then sentinel');
    const [ref, hit] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, [...hitsOf(raw, '&fjlig;'), ...hitsOf(raw, 'sentinel')])!;
    expect(el.textContent!.slice(ref!.start, ref!.end)).toBe('&fjlig;');
    expect(el.textContent!.slice(hit!.start, hit!.end)).toBe('sentinel');
  });

  it('negative control: a reference in inline code is drawn as written and placed as written', () => {
    const raw = 'use `&amp;` then sentinel';
    const el = rendered(raw);
    const [amp, hit] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, [...hitsOf(raw, '&amp;'), ...hitsOf(raw, 'sentinel')])!;
    expect(el.textContent!.slice(amp!.start, amp!.end)).toBe('&amp;');
    expect(el.textContent!.slice(hit!.start, hit!.end)).toBe('sentinel');
  });

  it('negative control: plain line breaks still map line by line', () => {
    const raw = 'alpha\nbeta\nsentinel gamma';
    const el = rendered(raw);
    const [pos] = mapMarkdownPositionsToDom(el, collectTextNodes(el), raw, hitsOf(raw, 'sentinel'))!;
    expect(el.textContent!.slice(pos!.start, pos!.end)).toBe('sentinel');
  });
});

describe('[#3661] edge 2: a code block across a made-up line', () => {
  // Two reasoning sections, joined by a blank line no raw line holds, whose
  // fence opens in the first and closes in the second.
  const RAW = ['> ```', '> alpha sentinel', '', '> beta sentinel', '> ```'].join('\n');
  const DERIVED = ['```', 'alpha sentinel', '', 'beta sentinel', '```'].join('\n');
  const toRaw = mapDerivedLines(DERIVED, [
    { text: '```', rawStart: 2 },
    { text: 'alpha sentinel', rawStart: 8 },
    { text: '', rawStart: null },
    { text: 'beta sentinel', rawStart: 26 },
    { text: '```', rawStart: 42 },
  ])!;

  it('marks the code block with each line’s span, the made-up line left out', () => {
    expect(RAW.slice(26, 39)).toBe('beta sentinel');
    const processor = unified().use(remarkParse).use(remarkRehype);
    const tree = processor.runSync(processor.parse(DERIVED)) as Root;
    rehypeSearchRawText({ toRaw, source: DERIVED })(tree);
    const pre = tree.children.find((node) => node.type === 'element' && node.tagName === 'pre') as HastElement;
    expect(pre.properties.dataSearchRaw).toBe('2,6,8,23,26,40,42,45');
  });

  it('places the hits on both sides of the made-up line', () => {
    const el = rendered(DERIVED, toRaw);
    const positions = mapMarkdownPositionsToDom(el, collectTextNodes(el), RAW, hitsOf(RAW, 'sentinel'))!;
    expect(positions.map((pos) => el.textContent!.slice(pos!.start, pos!.end))).toEqual(['sentinel', 'sentinel']);
    expect(positions[1]!.start).toBe(el.textContent!.indexOf('beta sentinel') + 'beta '.length);
  });
});

describe('[#3661] edge 3: a hit that cannot be placed', () => {
  it('is not marked; the placed hits are', () => {
    // `&lt;` draws `<`: a hit on `lt` inside it has nothing on screen.
    const raw = 'first &lt; then lt here';
    const el = rendered(raw);
    applyHistoryHighlights(el, hitsOf(raw, 'lt'), -1, NAMESPACE, { sourceText: raw });
    expect(marked()).toEqual(['lt']);
  });

  it('a hit ending on a marker Markdown did not draw is not marked at its raw offset', () => {
    // `Bold**` ends on a `*`: before, it fell back to raw 2..8 as a DOM
    // offset and marked `ld tex`.
    const raw = '**Bold** text and Bold';
    const el = rendered(raw);
    applyHistoryHighlights(el, [...hitsOf(raw, 'Bold**'), ...hitsOf(raw, 'and')], -1, NAMESPACE, { sourceText: raw });
    expect(marked()).toEqual(['and']);
  });

  it('as the current hit, it draws no overlay', () => {
    const raw = 'first &lt; then lt here';
    const el = rendered(raw);
    applyHistoryHighlights(el, hitsOf(raw, 'lt'), 0, NAMESPACE, { sourceText: raw });
    expect(overlay()).toBeNull();
    expect(marked()).toEqual(['lt']);
  });

  it('negative control: without `sourceText` offsets are DOM offsets, as before', () => {
    const el = mounted('first < then lt here');
    applyHistoryHighlights(el, [{ start: 13, end: 15 }], -1, NAMESPACE);
    expect(marked()).toEqual(['lt']);
  });
});
