/**
 * The fallback reads fences the way Markdown does (Issue #3544).
 *
 * `findMermaidFences` — used when a region's mermaid sources name no raw range
 * — found fences with a line pattern. It took `text\n  more\n2. ```mermaid` for
 * a list item holding a fence (an indented line before a marker read as a list
 * item's continuation), while Markdown draws it as paragraph text: only a list
 * starting at 1 interrupts a paragraph. The fake fence then took the real
 * diagram's source, and the real diagram's hit was never marked. A line now
 * opens a fence only where remark (the renderers' parser) opens one.
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

const NAMESPACE = makeHistoryNamespace(7);
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
  Object.defineProperty(globalThis, 'Highlight', { value: FakeHighlight, configurable: true, writable: true });
});

afterEach(() => {
  if (originalCSS) Object.defineProperty(globalThis, 'CSS', originalCSS);
  else delete (globalThis as { CSS?: unknown }).CSS;
  if (originalHighlight) Object.defineProperty(globalThis, 'Highlight', originalHighlight);
  else delete (globalThis as { Highlight?: unknown }).Highlight;
  document.body.innerHTML = '';
});

function hitsOf(text: string, query: string): MatchPosition[] {
  const out: MatchPosition[] = [];
  let cursor = 0;
  while (true) {
    const idx = text.indexOf(query, cursor);
    if (idx === -1) return out;
    out.push({ start: idx, end: idx + query.length });
    cursor = idx + 1;
  }
}

/** The DOM `MermaidCodeBlock` renders when its part has no raw offsets (no range named). */
function block(source: string): string {
  return (
    `<div class="mermaid-block"><div ${SEARCH_SKIP_ATTR}="true"><svg><text>svg</text></svg></div>` +
    `<details class="mermaid-source"><summary ${SEARCH_SKIP_ATTR}="true">Source</summary>` +
    `<pre><code ${MERMAID_SOURCE_ATTR}="true">${source}</code></pre></details></div>`
  );
}

function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

const BODY = 'graph TD\nA[sentinel]';

// The Issue's shape: a paragraph with an indented continuation line, then
// `2. ```mermaid` (paragraph text to Markdown), then the real diagram.
const INDENTED_CONTINUATION_THEN_TWO = [
  'Intro line',
  '  indented continuation',
  '2. ```mermaid',
  '   graph TD',
  '   A[sentinel]',
  '```mermaid',
  'graph TD',
  'A[sentinel]',
  '```',
].join('\n');

describe('[#3544] findMermaidFences: `2. ```mermaid` after an indented paragraph line', () => {
  it('reads only the real fence (positive control: the line pattern read the `2.` line as a fence too)', () => {
    const fences = findMermaidFences(INDENTED_CONTINUATION_THEN_TWO);
    expect(fences.map((f) => [f.fenceStart, f.body])).toEqual([
      [INDENTED_CONTINUATION_THEN_TWO.indexOf('```mermaid\ngraph'), BODY],
    ]);
  });

  it.each([
    ['a list item’s indented continuation', ['1. first', '   continued', '2. ```mermaid', '   graph TD', '   ```']],
    ['a list item’s lazy continuation', ['1. first', 'lazy line', '2. ```mermaid', '   graph TD', '   ```']],
    ['a quoted list item’s continuation', ['> 1. first', '>    continued', '> 2. ```mermaid', '>    graph TD', '>    ```']],
    ['an item indented under a paragraph (still a list item to Markdown)', ['Intro line', '  more', '- ```mermaid', '  graph TD', '  ```']],
  ])('negative control: `2. ```mermaid` after %s is still a fence', (_label, lines) => {
    expect(findMermaidFences(lines.join('\n')).map((f) => f.body)).toEqual(['graph TD']);
  });

  it('negative control: a line Markdown does not open claims no lines — a real fence right under it is read', () => {
    const raw = ['Intro line', '2. ```mermaid', '   ```mermaid', '   graph TD', '   ```'].join('\n');
    // Markdown: a paragraph, interrupted by the indented fence on line 3.
    const fences = findMermaidFences(raw);
    expect(fences.map((f) => [f.fenceStart, f.body])).toEqual([[raw.indexOf('   ```mermaid'), 'graph TD']]);
  });
});

describe('[#3544] applyHistoryHighlights: the fallback pairs the real diagram', () => {
  it('the paragraph’s hit stays in the paragraph; the diagram’s hit is marked in its source', () => {
    const container = mount(
      `<p>Intro line\nindented continuation\n2. \`\`\`mermaid\ngraph TD\nA[sentinel]</p>` + block(BODY),
    );
    applyHistoryHighlights(container, hitsOf(INDENTED_CONTINUATION_THEN_TWO, 'sentinel'), -1, NAMESPACE, {
      sourceText: INDENTED_CONTINUATION_THEN_TWO,
      sections: [],
    });
    const ranges = registry.get(NAMESPACE.highlightName)?.ranges ?? [];
    expect(ranges.map((r) => r.toString())).toEqual(['sentinel', 'sentinel']);
    expect(ranges[0].startContainer.parentElement?.tagName).toBe('P');
    expect(ranges[1].startContainer.parentElement?.hasAttribute(MERMAID_SOURCE_ATTR)).toBe(true);
    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });
});
