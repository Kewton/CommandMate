/**
 * Hits outside a mermaid diagram when Markdown left no raw marks (Issue #3692).
 *
 * In a message holding a diagram, `placeRawPositions` places a hit on a
 * diagram's source with the mermaid placer, and a hit outside the diagrams
 * with Markdown's marks (`mapMarkdownPositionsToDom`, Issue #3671). When the
 * container holds no marked element, Markdown returns `null`, and the mermaid
 * placer's result is kept whole: outside the diagrams it pairs the n-th time
 * the raw text occurs in a stretch with the n-th time it occurs on screen.
 *
 * Step 1 of #3692 keeps that (conclusion (b)); these tests pin it:
 *
 * - no marks: a hit on a source lands where it did, a plain word outside lands
 *   on its own word, and a hit whose raw text is not on screen is not marked;
 * - with marks (contrast): the hit outside is Markdown's, not the ordinal's.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyHistoryHighlights,
  makeHistoryNamespace,
  MERMAID_SOURCE_ATTR,
  SEARCH_RAW_ATTR,
  SEARCH_SKIP_ATTR,
  type MatchPosition,
} from '@/lib/terminal-highlight';

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const NAMESPACE = makeHistoryNamespace(3692);
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
function block(source: string): string {
  return (
    `<div class="mermaid-block">` +
    `<div ${SEARCH_SKIP_ATTR}="true" class="mermaid-figure"><svg><g><text>svg</text></g></svg></div>` +
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
  return Boolean(range.startContainer.parentElement?.closest(`[${MERMAID_SOURCE_ATTR}]`));
}

const BODY = 'graph TD\nA[alpha] --> B';

describe('[#3692] no Markdown marks: the mermaid placer is kept whole', () => {
  const raw = ['前の alpha', '', '```mermaid', BODY, '```', '', '後ろの alpha'].join('\n');
  const rendered = `<p>前の alpha</p>\n` + block(BODY) + `\n<p>後ろの alpha</p>`;

  it('positive: a hit on the source lands in the source, as before', () => {
    const container = mount(rendered);
    expect(container.querySelector(`[${SEARCH_RAW_ATTR}]`)).toBeNull();
    const hits = hitsOf(raw, 'alpha');
    expect(hits).toHaveLength(3);

    applyHistoryHighlights(container, hits, -1, NAMESPACE, { sourceText: raw });

    const ranges = marked();
    expect(ranges.map((r) => r.toString())).toEqual(['alpha', 'alpha', 'alpha']);
    expect(ranges.map(insideSource)).toEqual([false, true, false]);
  });

  it('positive: a plain word outside the diagram lands on its own word in its own stretch', () => {
    const container = mount(rendered);
    applyHistoryHighlights(container, hitsOf(raw, 'alpha'), -1, NAMESPACE, { sourceText: raw });
    const ranges = marked();
    expect(ranges[0].startContainer.parentElement?.textContent).toBe('前の alpha');
    expect(ranges[2].startContainer.parentElement?.textContent).toBe('後ろの alpha');
  });

  it('negative: a hit outside whose raw text is not on screen is not marked; the source hit still is', () => {
    // `**alpha**` is drawn `alpha`: `*alpha` is not on screen outside the diagram.
    const body = 'graph TD\nA[*alpha] --> B';
    const text = ['**alpha** 前', '', '```mermaid', body, '```'].join('\n');
    const container = mount(`<p><strong>alpha</strong> 前</p>\n` + block(body));
    const hits = hitsOf(text, '*alpha');
    // One in `**alpha**`, one in the diagram.
    expect(hits).toHaveLength(2);

    applyHistoryHighlights(container, hits, -1, NAMESPACE, { sourceText: text });

    const ranges = marked();
    expect(ranges.map((r) => r.toString())).toEqual(['*alpha']);
    expect(ranges.map(insideSource)).toEqual([true]);
  });
});

describe('[#3692] with Markdown marks (contrast): the hit outside is Markdown’s', () => {
  // `&#97;lpha` draws `alpha` but is not a raw `alpha`: the one raw hit outside
  // is the second word. Counting occurrences would put it on the first.
  const before = '&#97;lpha alpha';
  const raw = [before, '', '```mermaid', BODY, '```'].join('\n');
  const mark = `0,${before.length};0,${before.length},${'alpha alpha'.length}`;
  const rendered = `<p ${SEARCH_RAW_ATTR}="${mark}">alpha alpha</p>\n` + block(BODY);

  it('places the outside hit on the word that is the raw hit, and the source hit in the source', () => {
    const container = mount(rendered);
    const hits = hitsOf(raw, 'alpha');
    expect(hits).toHaveLength(2);

    applyHistoryHighlights(container, hits, -1, NAMESPACE, { sourceText: raw });

    const ranges = marked();
    expect(ranges.map((r) => r.toString())).toEqual(['alpha', 'alpha']);
    expect(ranges.map(insideSource)).toEqual([false, true]);
    expect(ranges[0].startOffset).toBe('alpha '.length);
  });

  it('the limit (b) keeps: without the mark the same hit is paired by occurrence, onto the first word', () => {
    const container = mount(`<p>alpha alpha</p>\n` + block(BODY));
    applyHistoryHighlights(container, hitsOf(raw, 'alpha'), -1, NAMESPACE, { sourceText: raw });
    const ranges = marked();
    expect(ranges.map(insideSource)).toEqual([false, true]);
    expect(ranges[0].startOffset).toBe(0);
  });
});
