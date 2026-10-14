/**
 * A search hit on the whole of `&fjlig;` outside a diagram is marked on both
 * characters it drew in a message that also holds a mermaid fence — on both
 * surfaces (Issue #3671, review P2). Before, the mermaid placer handled every
 * hit of such a message: it looks for the raw text (`&fjlig;`) on screen, finds
 * none and leaves the hit unplaced, and its `[null]` was taken as the answer,
 * so the Markdown placer that #3671 fixed was never asked.
 *
 * Hits inside the diagram stay the mermaid placer's (negative controls).
 *
 * Both surfaces are rendered from their parents through the real Markdown
 * pipelines; only the dynamically imported `MermaidDiagram` is a stand-in (as
 * in `chat-mermaid-3525.test.tsx`).
 *
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { opencodeTurnRequestId } from '@/types/agent-transcript';

vi.mock('next/dynamic', () => ({
  default: () => {
    function FakeMermaidDiagram({
      onRenderStateChange,
    }: {
      code: string;
      onRenderStateChange?: (state: 'rendered' | 'error') => void;
    }) {
      useEffect(() => {
        onRenderStateChange?.('rendered');
      }, [onRenderStateChange]);
      return (
        <div data-testid="mermaid-container">
          <svg>
            <text>fj label</text>
          </svg>
        </div>
      );
    }
    return FakeMermaidDiagram;
  },
}));

import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { MERMAID_SOURCE_ATTR } from '@/lib/terminal-highlight';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a-0',
    worktreeId: 'wt-3671',
    role: 'assistant',
    content: '',
    timestamp: new Date(Date.UTC(2026, 9, 14, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: opencodeTurnRequestId('msg_3671_mermaid'),
    ...overrides,
  };
}

const USER = message({ id: 'u-0', role: 'user', content: 'draw', requestId: undefined });

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
let restoreLayout: () => void;
let scrollTargets: Element[];
/** Ranges the current hit's overlay was measured from, in order. */
let measured: Range[];
let originalScroll: typeof Element.prototype.scrollIntoView;

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
  // jsdom has no layout: give a Range a box so the current hit's overlay is drawn.
  originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  measured = [];
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value(this: Range) {
      measured.push(this);
      return { top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) };
    },
    configurable: true,
    writable: true,
  });
  restoreLayout = installVirtualLayout();
  scrollTargets = [];
  originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrollTargets.push(this);
  };
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScroll;
  restoreLayout();
  if (originalRangeRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', originalRangeRect);
  else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  if (originalCSS) Object.defineProperty(globalThis, 'CSS', originalCSS);
  else delete (globalThis as { CSS?: unknown }).CSS;
  if (originalHighlight) Object.defineProperty(globalThis, 'Highlight', originalHighlight);
  else delete (globalThis as { Highlight?: unknown }).Highlight;
});

type Surface = 'ChatTranscript' | 'HistoryPane';
const SURFACES: Array<[Surface, string]> = [
  ['ChatTranscript', 'chat-search'],
  ['HistoryPane', 'history-search-2'],
];

function searchOn(surface: Surface, content: string, query: string): void {
  const messages = [USER, message({ content })];
  if (surface === 'ChatTranscript') {
    render(<ChatTranscript messages={messages} worktreeId="wt-3671" cliToolId="opencode" onFilePathClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), { target: { value: query } });
  } else {
    render(<HistoryPane messages={messages} worktreeId="wt-3671" onFilePathClick={vi.fn()} splitIndex={2} />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: query } });
  }
}

function marked(name: string): Range[] {
  return registry.get(name)?.ranges ?? [];
}

function source(): HTMLElement {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[${MERMAID_SOURCE_ATTR}]`));
  expect(all).toHaveLength(1);
  return all[0];
}

/** The paragraph a range starts in. */
function paragraphOf(range: Range): string | undefined {
  const node = range.startContainer;
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  return element?.closest('p')?.textContent ?? undefined;
}

const DIAGRAM = ['```mermaid', 'graph TD', 'A[sentinel]', '```'];

describe.each(SURFACES)('[#3671] %s: a message holding a mermaid fence', (surface, name) => {
  it('marks both characters `&fjlig;` drew for a hit on its whole after the diagram', async () => {
    // Two hits around the diagram: the first is current, the second is marked.
    searchOn(surface, ['&fjlig; before', '', ...DIAGRAM, '', 'after &fjlig;'].join('\n'), '&fjlig;');
    await waitFor(() => {
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['fj']);
      expect(paragraphOf(ranges[0])).toBe('after fj');
      expect(source().contains(ranges[0].startContainer)).toBe(false);
      expect(scrollTargets.some((el) => el.closest('p')?.textContent === 'fj before')).toBe(true);
    });
  });

  it('places the current hit on the whole of `&fjlig;` before the diagram', async () => {
    // The first hit (current) is before the diagram; the second is inside it.
    searchOn(surface, ['&fjlig; before', '', '```mermaid', 'graph TD', 'A[&fjlig;]', '```'].join('\n'), '&fjlig;');
    await waitFor(() => {
      expect(scrollTargets.some((el) => el.closest('p')?.textContent === 'fj before')).toBe(true);
      // The one inside the diagram is still placed on its source, as before.
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['&fjlig;']);
      expect(source().contains(ranges[0].startContainer)).toBe(true);
    });
  });

  it('places a reference in prose and the same one in inline code apart before the diagram', async () => {
    // Raw: `&fjlig;` twice (prose, then code); on screen `fj` and `&fjlig;`.
    // The first (current) is the prose `fj`, the second the code's text.
    searchOn(surface, ['&fjlig; and `&fjlig;`', '', ...DIAGRAM].join('\n'), '&fjlig;');
    await waitFor(() => {
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['&fjlig;']);
      expect(ranges[0].startContainer.parentElement?.closest('code')).not.toBeNull();
      const current = measured[measured.length - 1];
      expect(current?.toString()).toBe('fj');
      expect(current.startContainer.parentElement?.closest('code')).toBeNull();
    });
  });

  it('negative control: hits inside the diagram mark its source text as before', async () => {
    searchOn(surface, ['before', '', '```mermaid', 'graph TD', 'A[&fjlig;] --> B[&fjlig;]', '```'].join('\n'), '&fjlig;');
    await waitFor(() => {
      const src = source();
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['&fjlig;']);
      expect(src.contains(ranges[0].startContainer)).toBe(true);
      expect(scrollTargets).toContain(src);
      expect((src.closest('details') as HTMLDetailsElement).open).toBe(true);
    });
  });

  it('negative control: a hit only inside the diagram is the diagram’s, never the drawn label', async () => {
    searchOn(surface, ['fj before', '', ...DIAGRAM].join('\n'), 'sentinel');
    await waitFor(() => {
      const src = source();
      expect(marked(name)).toHaveLength(0);
      expect(scrollTargets).toContain(src);
      expect((src.closest('details') as HTMLDetailsElement).open).toBe(true);
    });
  });
});
