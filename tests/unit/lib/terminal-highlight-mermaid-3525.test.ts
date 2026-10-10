/**
 * Pairing hits with mermaid sources by the fence Markdown drew (Issue #3525).
 *
 * - `findMermaidFences` (the fallback) no longer reads `text\n2. ```mermaid` as
 *   a list item holding a fence: only a list starting at 1 interrupts a
 *   paragraph (CommonMark).
 * - `fenceFromRawRange` reads a fence back from the raw range react-markdown's
 *   `node.position` gave (nested lists, tabs, quotes).
 * - `alignDerivedText` maps offsets in chat's folded parts back to the message.
 * - `applyHistoryHighlights` pairs a source naming its raw range with that
 *   fence, and falls back to pairing by body when the range does not read back.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  alignDerivedText,
  applyHistoryHighlights,
  fenceFromRawRange,
  findMermaidFences,
  makeHistoryNamespace,
  MERMAID_RAW_END_ATTR,
  MERMAID_RAW_START_ATTR,
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

const NAMESPACE = makeHistoryNamespace(5);
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The DOM `MermaidCodeBlock` renders, optionally naming the fence's raw range. */
function block(source: string, range?: { start: number; end: number }): string {
  const attrs = range ? ` ${MERMAID_RAW_START_ATTR}="${range.start}" ${MERMAID_RAW_END_ATTR}="${range.end}"` : '';
  return (
    `<div class="mermaid-block"><div ${SEARCH_SKIP_ATTR}="true"><svg><text>svg</text></svg></div>` +
    `<details class="mermaid-source"><summary ${SEARCH_SKIP_ATTR}="true">Source</summary>` +
    `<pre><code ${MERMAID_SOURCE_ATTR}="true"${attrs}>${escapeHtml(source)}</code></pre></details></div>`
  );
}

function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

/** Every marked range, current one included (current = index -1 → none skipped). */
function marked(): Range[] {
  return registry.get(NAMESPACE.highlightName)?.ranges ?? [];
}

const PARAGRAPH_THEN_TWO = [
  'Intro line',
  '2. ```mermaid',
  '   graph TD',
  '   A[sentinel]',
  '```mermaid',
  'graph TD',
  'A[sentinel]',
  '```',
].join('\n');

describe('[#3525] findMermaidFences: `2.` after a paragraph is paragraph text', () => {
  it('reads only the real fence (positive control: #3516 read the `2.` line as a fence too)', () => {
    const fences = findMermaidFences(PARAGRAPH_THEN_TWO);
    expect(fences).toHaveLength(1);
    expect(fences[0].fenceStart).toBe(PARAGRAPH_THEN_TWO.indexOf('```mermaid\ngraph'));
    expect(fences[0].body).toBe('graph TD\nA[sentinel]');
  });

  it.each([
    ['`1.` interrupts a paragraph', ['Intro line', '1. ```mermaid', '   graph TD', '   ```']],
    ['`2.` after a blank line', ['Intro line', '', '2. ```mermaid', '   graph TD', '   ```']],
    ['`2.` after the list’s first item', ['1. first', '2. ```mermaid', '   graph TD', '   ```']],
    ['`2.` at the start of the text', ['2. ```mermaid', '   graph TD', '   ```']],
    ['`-` interrupts a paragraph', ['Intro line', '- ```mermaid', '  graph TD', '  ```']],
  ])('negative control: %s is still a list item holding a fence', (_label, lines) => {
    expect(findMermaidFences(lines.join('\n')).map((f) => f.body)).toEqual(['graph TD']);
  });
});

describe('[#3525] findMermaidFences: a list item’s paragraph is not a top-level paragraph', () => {
  it.each([
    ['after an item and its indented continuation', ['1. first', '   continued', '2. ```mermaid', '   graph TD', '   ```']],
    ['after an item and a lazy continuation', ['1. first', 'lazy line', '2. ```mermaid', '   graph TD', '   ```']],
    ['after a quoted item and its continuation', ['> 1. first', '>    continued', '> 2. ```mermaid', '>    graph TD', '>    ```']],
  ])('`2. ```mermaid` %s is the list’s next item holding a fence (positive control)', (_label, lines) => {
    expect(findMermaidFences(lines.join('\n')).map((f) => f.body)).toEqual(['graph TD']);
  });

  it.each([
    ['right after a paragraph line', ['Intro line', '2. ```mermaid', '   graph TD', '   ```']],
    ['after a two-line paragraph', ['Intro line', 'more intro', '2. ```mermaid', '   graph TD', '   ```']],
    ['after a paragraph that follows a closed list', ['1. first', '', 'Intro line', '2. ```mermaid', '   graph TD', '   ```']],
  ])('negative control: `2. ```mermaid` %s is still paragraph text', (_label, lines) => {
    expect(findMermaidFences(lines.join('\n'))).toEqual([]);
  });
});

describe('[#3525] fenceFromRawRange', () => {
  it.each([
    ['a nested list', '- a\n  - b\n    ```mermaid\n    graph TD\n    A[x]\n    ```\n'],
    ['tabs', '-\t```mermaid\n\tgraph TD\n\tA[x]\n\t```\n'],
    ['a quoted list', '> - `Read`\n>   ```mermaid\n>   graph TD\n>   A[x]\n>   ```'],
  ])('reads back the fence in %s', (_label, text) => {
    const start = text.indexOf('```mermaid');
    const end = text.lastIndexOf('```') + 3;
    const fence = fenceFromRawRange(text, start, end, 'graph TD\nA[x]');
    expect(fence).not.toBeNull();
    expect(fence!.lines.map((l) => text.slice(l.rawStart, l.rawStart + l.length))).toEqual(['graph TD', 'A[x]']);
    expect(fence!.lines.map((l) => l.bodyOffset)).toEqual([0, 9]);
  });

  it('an unclosed fence ends with its last body line', () => {
    const text = '```mermaid\ngraph TD\nA[x]';
    expect(fenceFromRawRange(text, 0, text.length, 'graph TD\nA[x]')?.fenceEnd).toBe(text.length);
  });

  it.each([
    ['a range that does not open with a fence', 'xx```mermaid\ngraph TD\n```', 0],
    ['a body that is not what the range holds', '```mermaid\ngraph LR\n```', 0],
  ])('is null for %s', (_label, text, start) => {
    expect(fenceFromRawRange(text, start, text.length, 'graph TD')).toBeNull();
  });
});

describe('[#3525] alignDerivedText', () => {
  it('is the identity for the text itself', () => {
    expect(alignDerivedText('abc', 'abc')!(2)).toBe(2);
  });

  it('maps an unquoted part back behind its quote markers', () => {
    const raw = 'answer\n\n> **Tool calls (1)**\n>\n> - `Read`\n>   A[x]';
    const derived = '- `Read`\n  A[x]';
    const toRaw = alignDerivedText(derived, raw, [{ start: raw.indexOf('> **'), end: raw.length }])!;
    expect(raw.slice(toRaw(derived.indexOf('A[x]'))!, toRaw(derived.indexOf('A[x]'))! + 4)).toBe('A[x]');
    expect(toRaw(derived.length)).toBe(raw.length);
  });

  it('is null when a line of the part is not in the text', () => {
    expect(alignDerivedText('changed', 'original')).toBeNull();
  });
});

describe('[#3525] applyHistoryHighlights pairs by the raw range a source names', () => {
  // Rendered by Markdown: a paragraph (the `2.` lines are its text), then the
  // real diagram. The source names the real fence's range.
  const realStart = PARAGRAPH_THEN_TWO.indexOf('```mermaid\ngraph');
  const RENDERED =
    `<p>Intro line\n2. \`\`\`mermaid\ngraph TD\nA[sentinel]</p>` +
    block('graph TD\nA[sentinel]', { start: realStart, end: PARAGRAPH_THEN_TWO.length });

  it('the paragraph’s hit lands in the paragraph, the diagram’s in the source', () => {
    const container = mount(RENDERED);
    applyHistoryHighlights(container, hitsOf(PARAGRAPH_THEN_TWO, 'sentinel'), -1, NAMESPACE, {
      sourceText: PARAGRAPH_THEN_TWO,
    });
    const [first, second] = marked();
    expect(first.startContainer.parentElement?.tagName).toBe('P');
    expect(second.startContainer.parentElement?.hasAttribute(MERMAID_SOURCE_ATTR)).toBe(true);
    expect(second.toString()).toBe('sentinel');
    expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(true);
  });

  it('a nested-list diagram the line pattern cannot read is marked', () => {
    const raw = 'Intro\n\n- a\n  - b\n    ```mermaid\n    graph TD\n    A[sentinel]\n    ```';
    const start = raw.indexOf('```mermaid');
    const container = mount(
      `<p>Intro</p><ul><li>a<ul><li>b${block('graph TD\nA[sentinel]', { start, end: raw.length })}</li></ul></li></ul>`,
    );
    applyHistoryHighlights(container, hitsOf(raw, 'sentinel'), -1, NAMESPACE, { sourceText: raw });
    const [hit] = marked();
    expect(hit.toString()).toBe('sentinel');
    expect(hit.startContainer.parentElement?.hasAttribute(MERMAID_SOURCE_ATTR)).toBe(true);
  });

  it('negative control: a range that does not read back falls back to pairing by body', () => {
    const raw = 'Intro\n\n```mermaid\ngraph TD\nA[sentinel]\n```';
    const container = mount(`<p>Intro</p>${block('graph TD\nA[sentinel]', { start: 0, end: 5 })}`);
    applyHistoryHighlights(container, hitsOf(raw, 'sentinel'), -1, NAMESPACE, { sourceText: raw });
    const [hit] = marked();
    expect(hit.startContainer.parentElement?.hasAttribute(MERMAID_SOURCE_ATTR)).toBe(true);
  });
});
