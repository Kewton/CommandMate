/**
 * Search highlights around and inside mermaid diagrams (Issue #3503).
 *
 * A ```mermaid fence in a Markdown body is drawn as a diagram with its source
 * folded underneath (`MermaidCodeBlock`). The raw text search runs on and the
 * DOM the highlighter marks no longer line up there, so `applyHistoryHighlights`
 * takes the raw text (`sourceText`) and places each hit:
 *
 * - inside a fence → the same place in the folded source, which it opens;
 * - between / after fences → the same occurrence of the word in that stretch;
 * - the diagram's SVG text and the "Source" label are never counted.
 *
 * The fixture DOM is the structure `MermaidCodeBlock` renders (the component
 * tests render the real one).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyHistoryHighlights,
  findMermaidFences,
  makeHistoryNamespace,
  MERMAID_SOURCE_ATTR,
  SEARCH_SKIP_ATTR,
  type MatchPosition,
} from '@/lib/terminal-highlight';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const NAMESPACE = makeHistoryNamespace(3);
let registry: Map<string, FakeHighlight>;
let originalCSS: PropertyDescriptor | undefined;
let originalHighlight: PropertyDescriptor | undefined;

beforeEach(() => {
  registry = new Map();
  originalCSS = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
  originalHighlight = Object.getOwnPropertyDescriptor(globalThis, 'Highlight');
  Object.defineProperty(globalThis, 'CSS', {
    value: { highlights: registry, escape: (s: string) => s },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'Highlight', {
    value: FakeHighlight,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (originalCSS) Object.defineProperty(globalThis, 'CSS', originalCSS);
  else delete (globalThis as { CSS?: unknown }).CSS;
  if (originalHighlight) Object.defineProperty(globalThis, 'Highlight', originalHighlight);
  else delete (globalThis as { Highlight?: unknown }).Highlight;
  document.body.innerHTML = '';
});

/** `findMatches`' scan: every (overlapping) case-insensitive hit. */
function hitsOf(text: string, query: string): MatchPosition[] {
  const out: MatchPosition[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let cursor = 0;
  while (true) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) return out;
    out.push({ start: idx, end: idx + q.length });
    cursor = idx + 1;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The DOM `MermaidCodeBlock` renders for one fence, with a drawn SVG. */
function block(source: string, svgLabel: string): string {
  return (
    `<div class="mermaid-block">` +
    `<div ${SEARCH_SKIP_ATTR}="true" class="mermaid-figure">` +
    `<div class="mermaid-container"><svg><style>#m .node{fill:${svgLabel}}</style><g><text>${svgLabel}</text></g></svg></div>` +
    `</div>` +
    `<details class="mermaid-source"><summary ${SEARCH_SKIP_ATTR}="true">Source</summary>` +
    `<pre><code ${MERMAID_SOURCE_ATTR}="true">${escapeHtml(source)}</code></pre></details>` +
    `</div>`
  );
}

function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.setAttribute('data-message-id', 'm1');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

function marked(): Range[] {
  return registry.get(NAMESPACE.highlightName)?.ranges ?? [];
}

function insideSource(range: Range): boolean {
  const el = range.startContainer.parentElement;
  return Boolean(el?.closest(`[${MERMAID_SOURCE_ATTR}]`));
}

const BODY_1 = 'graph TD\nA[alpha] --> B[beta alpha]';
const BODY_2 = 'graph LR\nX[alpha] --> Y';

/** Raw message: text, diagram, text, diagram, text — `alpha` everywhere. */
const RAW = [
  '前の alpha と **alpha**',
  '',
  '```mermaid',
  BODY_1,
  '```',
  '',
  '間の `alpha`',
  '',
  '```mermaid',
  BODY_2,
  '```',
  '',
  '後ろの alpha',
].join('\n');

/** What react-markdown renders for {@link RAW}, block by block. */
const RENDERED =
  `<p>前の alpha と <strong>alpha</strong></p>\n` +
  block(BODY_1, 'alpha svg') +
  `\n<p>間の <code>alpha</code></p>\n` +
  block(BODY_2, 'alpha svg') +
  `\n<p>後ろの alpha</p>`;

describe('[#3503] findMermaidFences', () => {
  it('finds each ```mermaid fence body by offset', () => {
    const fences = findMermaidFences(RAW);
    expect(fences.map((f) => f.body)).toEqual([BODY_1, BODY_2]);
    for (const fence of fences) {
      expect(RAW.slice(fence.bodyStart, fence.bodyEnd)).toBe(fence.body);
      expect(RAW.slice(fence.fenceStart, fence.bodyStart)).toBe('```mermaid\n');
      expect(RAW.slice(fence.bodyEnd, fence.fenceEnd)).toBe('\n```');
    }
  });

  it('ignores other fences and a ```mermaid line inside one', () => {
    const raw = '````md\n```mermaid\ngraph TD\n```\n````\n\n```js\nx\n```';
    expect(findMermaidFences(raw)).toEqual([]);
  });

  it('runs an unclosed fence to the end, as Markdown does', () => {
    const raw = 'a\n```mermaid\ngraph TD\nA-->B';
    expect(findMermaidFences(raw).map((f) => f.body)).toEqual(['graph TD\nA-->B']);
  });
});

describe('[#3503] applyHistoryHighlights with mermaid diagrams', () => {
  it('marks every hit on its own word: before, in both diagrams, between and after', () => {
    const container = mount(RENDERED);
    const hits = hitsOf(RAW, 'alpha');
    // 2 before, 2 in the first diagram, 1 between, 1 in the second, 1 after.
    expect(hits).toHaveLength(7);

    applyHistoryHighlights(container, hits, -1, NAMESPACE, { sourceText: RAW });

    const ranges = marked();
    expect(ranges.map((r) => r.toString())).toEqual(Array(7).fill('alpha'));
    expect(ranges.map(insideSource)).toEqual([false, false, true, true, false, true, false]);
    // The between-diagrams hit is the inline code, not a diagram source.
    expect(ranges[4].startContainer.parentElement?.tagName).toBe('CODE');
    expect(ranges[4].startContainer.parentElement?.hasAttribute(MERMAID_SOURCE_ATTR)).toBe(false);
    // The stretch after the diagrams lands on the last paragraph.
    expect(ranges[6].startContainer.parentElement?.textContent).toBe('後ろの alpha');
  });

  it('never marks text inside the SVG or the "Source" label', () => {
    const container = mount(RENDERED);
    applyHistoryHighlights(container, hitsOf(RAW, 'alpha'), -1, NAMESPACE, { sourceText: RAW });
    for (const range of marked()) {
      expect(range.startContainer.parentElement?.closest(`[${SEARCH_SKIP_ATTR}]`)).toBeNull();
    }
  });

  it('the SVG text in front of a source does not shift the offsets (no sourceText needed)', () => {
    // The diagram draws `graph` in its label before the source starts. With the
    // SVG skipped, DOM offset 0 is the source's own first character.
    const container = mount(block('graph TD', 'graph label'));
    applyHistoryHighlights(container, [{ start: 0, end: 5 }], -1, NAMESPACE);
    const [range] = marked();
    expect(range.toString()).toBe('graph');
    expect(insideSource(range)).toBe(true);
  });

  it('opens the folded source holding a hit, and only that one', () => {
    const raw = ['```mermaid', 'graph TD\nA[gamma]', '```', '', '```mermaid', 'graph TD\nB[delta]', '```'].join('\n');
    const container = mount(block('graph TD\nA[gamma]', 'x') + '\n' + block('graph TD\nB[delta]', 'y'));
    const folds = container.querySelectorAll('details');
    expect(Array.from(folds).map((d) => d.open)).toEqual([false, false]);

    applyHistoryHighlights(container, hitsOf(raw, 'delta'), 0, NAMESPACE, { sourceText: raw });

    expect(Array.from(folds).map((d) => d.open)).toEqual([false, true]);
  });

  it('scrolls the current hit inside a diagram into view from its source', () => {
    const container = mount(RENDERED);
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      // Current = the 6th hit, the one inside the second diagram.
      applyHistoryHighlights(container, hitsOf(RAW, 'alpha'), 5, NAMESPACE, { sourceText: RAW });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].hasAttribute(MERMAID_SOURCE_ATTR)).toBe(true);
    expect(scrolled[0].textContent).toBe(BODY_2);
    // The current hit is drawn by the overlay, so the registry holds the other 6.
    expect(marked()).toHaveLength(6);
  });

  it('two diagrams with the same source each get their own hits', () => {
    const body = 'graph TD\nA[same] --> B';
    const raw = ['```mermaid', body, '```', '', '```mermaid', body, '```'].join('\n');
    const container = mount(block(body, 'same') + '\n' + block(body, 'same'));
    applyHistoryHighlights(container, hitsOf(raw, 'same'), -1, NAMESPACE, { sourceText: raw });
    const ranges = marked();
    expect(ranges).toHaveLength(2);
    expect(ranges[0].startContainer).not.toBe(ranges[1].startContainer);
    const sources = container.querySelectorAll(`[${MERMAID_SOURCE_ATTR}]`);
    expect(sources[0].contains(ranges[0].startContainer)).toBe(true);
    expect(sources[1].contains(ranges[1].startContainer)).toBe(true);
  });

  it('a hit on the fence line itself (```mermaid) is not drawn anywhere', () => {
    const raw = '```mermaid\ngraph TD\nA-->B\n```';
    const container = mount(block('graph TD\nA-->B', 'mermaid'));
    applyHistoryHighlights(container, hitsOf(raw, 'mermaid'), -1, NAMESPACE, { sourceText: raw });
    expect(marked()).toEqual([]);
  });

  it('positive control: without the raw text the same hits land on the wrong words', () => {
    const container = mount(RENDERED);
    applyHistoryHighlights(container, hitsOf(RAW, 'alpha'), -1, NAMESPACE);
    const texts = marked().map((r) => r.toString());
    expect(texts).not.toEqual(Array(7).fill('alpha'));
  });
});

describe('[#3503] messages without a drawn diagram are unchanged (negative control)', () => {
  it('offsets stay DOM offsets when the container shows no mermaid source', () => {
    const container = mount('<p>one sentinel, two sentinel</p>');
    const raw = 'one sentinel, two sentinel';
    const hits = hitsOf(raw, 'sentinel');

    applyHistoryHighlights(container, hits, -1, NAMESPACE, { sourceText: raw });
    const withSource = marked().map((r) => [r.startOffset, r.endOffset]);
    registry.clear();
    applyHistoryHighlights(container, hits, -1, NAMESPACE);
    const without = marked().map((r) => [r.startOffset, r.endOffset]);

    expect(withSource).toEqual(without);
    expect(without).toEqual([
      [4, 12],
      [18, 26],
    ]);
  });

  it('a mermaid fence shown as plain code (live / pending bubble) is placed as before', () => {
    // No `data-mermaid-source`: the fence is a normal <pre><code>.
    const raw = 'zeta\n\n```mermaid\ngraph TD\nA[zeta]\n```';
    const container = mount('<p>zeta</p>\n<pre><code class="language-mermaid">graph TD\nA[zeta]\n</code></pre>');
    const hits = hitsOf(raw, 'zeta');

    applyHistoryHighlights(container, hits, -1, NAMESPACE, { sourceText: raw });
    const withSource = marked().map((r) => r.toString());
    registry.clear();
    applyHistoryHighlights(container, hits, -1, NAMESPACE);
    expect(withSource).toEqual(marked().map((r) => r.toString()));
  });
});
