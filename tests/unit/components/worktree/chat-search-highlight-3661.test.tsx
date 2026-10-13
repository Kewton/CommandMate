/**
 * Search marks every reply that has a hit, and the current hit's overlay
 * follows it to whichever reply holds it — on both surfaces (Issue #3661).
 *
 * Before, each surface called `applyHistoryHighlights` once per reply, and
 * every call replaced the namespace's `CSS.highlights` entry and removed the
 * overlay when that reply did not hold the current hit: only the last reply's
 * hits stayed marked, and a current hit in any other reply had no overlay.
 *
 * Also here, from the review of #3554: a `&NewLine;` that took the paragraph's
 * next raw line break, a code block made of two reasoning sections, and a hit
 * that could not be placed falling back to its raw offset as a DOM offset.
 *
 * Both surfaces are rendered from their parents through the real Markdown
 * pipelines (as in `chat-search-highlight-3554.test.tsx`).
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
      return <div data-testid="mermaid-container" />;
    }
    return FakeMermaidDiagram;
  },
}));

import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

let sequence = 0;

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  sequence += 1;
  return {
    id: `msg-3661-${sequence}`,
    worktreeId: 'wt-3661',
    role: 'assistant',
    content: '',
    timestamp: new Date(Date.UTC(2026, 9, 13, 10, 0, sequence)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: opencodeTurnRequestId(`msg_3661_${sequence}`),
    ...overrides,
  };
}

function conversation(replies: string[]): ChatMessage[] {
  return replies.flatMap((content, k) => [
    message({ id: `u-${k}`, role: 'user', content: `ask ${k}`, requestId: undefined }),
    message({ id: `a-${k}`, content }),
  ]);
}

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
let originalScroll: typeof Element.prototype.scrollIntoView;

beforeEach(() => {
  sequence = 0;
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
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value: () => ({ top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) }),
    configurable: true,
    writable: true,
  });
  restoreLayout = installVirtualLayout();
  originalScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () {};
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
const SURFACES: Array<[Surface, string, string]> = [
  ['ChatTranscript', 'chat-search', 'chat-search-fallback-overlay'],
  ['HistoryPane', 'history-search-2', 'history-search-fallback-overlay-2'],
];

function searchOn(surface: Surface, messages: ChatMessage[], query = 'sentinel'): void {
  if (surface === 'ChatTranscript') {
    render(<ChatTranscript messages={messages} worktreeId="wt-3661" cliToolId="opencode" onFilePathClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), { target: { value: query } });
  } else {
    render(<HistoryPane messages={messages} worktreeId="wt-3661" onFilePathClick={vi.fn()} splitIndex={2} />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: query } });
  }
}

function next(): void {
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
}

function marked(name: string): Range[] {
  return registry.get(name)?.ranges ?? [];
}

/** The element of the reply `a-<k>` a node is drawn in, as its index. */
function replyOf(node: Node): number {
  const holder = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest(
    '[data-message-id^="a-"]',
  );
  return holder ? Number(holder.getAttribute('data-message-id')!.slice(2)) : -1;
}

function overlayReply(id: string): number {
  const overlay = document.getElementById(id);
  return overlay ? replyOf(overlay) : -1;
}

const TWO_REPLIES = ['First sentinel, then **another** sentinel.', 'Second sentinel, then **more** sentinel.'];

describe.each(SURFACES)('[#3661] %s: two replies with hits', (surface, name, overlayId) => {
  it('marks the hits of every reply, and the overlay sits on the first reply’s current hit', async () => {
    searchOn(surface, conversation(TWO_REPLIES));
    await waitFor(() => {
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['sentinel', 'sentinel', 'sentinel']);
      expect(ranges.map((range) => replyOf(range.startContainer)).sort()).toEqual([0, 1, 1]);
      expect(overlayReply(overlayId)).toBe(0);
    });
  });

  it('the overlay follows the current hit into the other reply, and the first reply stays marked', async () => {
    searchOn(surface, conversation(TWO_REPLIES));
    await waitFor(() => expect(marked(name)).toHaveLength(3));
    // 1/4 → 2/4 → 3/4: the current hit is the 2nd reply's first.
    next();
    next();
    await waitFor(() => {
      const ranges = marked(name);
      expect(ranges.map((range) => replyOf(range.startContainer)).sort()).toEqual([0, 0, 1]);
      expect(overlayReply(overlayId)).toBe(1);
      expect(document.querySelectorAll(`#${overlayId}`)).toHaveLength(1);
    });
  });

  it('six replies: every mounted reply’s hits but the current one are marked at 1/13', async () => {
    const replies = Array.from({ length: 6 }, (_, k) =>
      k === 5 ? 'Last sentinel, sentinel and **sentinel**.' : `Reply ${k} sentinel and sentinel.`,
    );
    searchOn(surface, conversation(replies));
    await waitFor(() => {
      // A virtualized surface mounts only the rows near the current hit; a row
      // scrolled in later is marked on its mount.
      const mounted = Array.from(document.querySelectorAll('[data-message-id^="a-"]')).map((el) =>
        Number(el.getAttribute('data-message-id')!.slice(2)),
      );
      expect(mounted.length).toBeGreaterThan(2);
      expect(mounted).toContain(0);
      const hitsOn = (reply: number): number => (reply === 5 ? 3 : 2);
      const ranges = marked(name);
      expect(ranges).toHaveLength(mounted.reduce((sum, reply) => sum + hitsOn(reply), 0) - 1);
      expect(ranges.every((range) => range.toString() === 'sentinel')).toBe(true);
      expect(new Set(ranges.map((range) => replyOf(range.startContainer)))).toEqual(new Set(mounted));
      expect(overlayReply(overlayId)).toBe(0);
    });
  });
});

describe.each(SURFACES)('[#3661] %s: negative control — one reply', (surface, name, overlayId) => {
  it('marks its other hit and puts the overlay on the current one, as before', async () => {
    searchOn(surface, conversation([TWO_REPLIES[0]]));
    await waitFor(() => {
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['sentinel']);
      expect(replyOf(ranges[0].startContainer)).toBe(0);
      expect(overlayReply(overlayId)).toBe(0);
    });
    next();
    await waitFor(() => {
      const ranges = marked(name);
      expect(ranges).toHaveLength(1);
      // The other hit is now the marked one: the first word of the reply.
      expect(ranges[0].startOffset).toBe('First '.length);
      expect(overlayReply(overlayId)).toBe(0);
    });
  });
});

describe.each(SURFACES)('[#3661] %s: edge inputs from the #3554 review', (surface, name, overlayId) => {
  it.each([
    ['two characters', '&fjlig; sentinel sentinel'],
    ['a surrogate pair', '&Afr; sentinel sentinel'],
  ])('a reference drawing %s: the words after it are marked, and the current one has its overlay', async (_label, content) => {
    searchOn(surface, conversation([content]));
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel']);
      expect(overlayReply(overlayId)).toBe(0);
    });
  });

  it('negative control: the same reference in inline code is drawn and marked as written', async () => {
    searchOn(surface, conversation(['use `&fjlig;` and `&fjlig;` here']), '&fjlig;');
    await waitFor(() => {
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['&fjlig;']);
      expect(ranges[0].startContainer.parentElement?.closest('code')).not.toBeNull();
      expect(overlayReply(overlayId)).toBe(0);
    });
  });

  it('a `&NewLine;` does not take the paragraph’s next raw line break', async () => {
    // The entity draws a line break the raw text does not have; matched in
    // order, it took the raw one after `beta`, and the rest of the paragraph
    // was not placed.
    searchOn(surface, conversation(['alpha&NewLine;beta\nsentinel gamma sentinel']));
    await waitFor(() => {
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['sentinel']);
      expect(ranges[0].startContainer.nodeValue!.slice(ranges[0].startOffset)).toBe('sentinel');
    });
  });

  it('a hit that cannot be placed is not marked anywhere', async () => {
    // `&lt;` draws `<`: the hit on `lt` in the raw text has nothing on screen.
    // Before, it fell back to its raw offset as a DOM offset and marked
    // unrelated text.
    searchOn(surface, conversation(['first &lt; then sentinel and lt here']), 'lt');
    await waitFor(() => {
      const ranges = marked(name);
      // Hits: `lt` in `&lt;` (current, unplaceable) and `lt` in the last word.
      expect(ranges.map((range) => range.toString())).toEqual(['lt']);
    });
  });
});

describe('[#3661] ChatTranscript: a code block made of two reasoning sections', () => {
  it('places the hits in the code', async () => {
    const content = [
      '> **Thinking**',
      '> ```',
      '> alpha sentinel',
      '',
      '> **Thinking**',
      '> beta sentinel',
      '> ```',
      '',
      'The sentinel answer.',
    ].join('\n');
    searchOn('ChatTranscript', conversation([content]));
    await waitFor(() => {
      const ranges = marked('chat-search');
      expect(ranges.map((range) => range.toString())).toEqual(['sentinel', 'sentinel']);
      const inCode = ranges.filter((range) => range.startContainer.parentElement?.closest('pre'));
      expect(inCode).toHaveLength(1);
      expect(inCode[0].startContainer.parentElement!.closest('pre')!.textContent).toContain('beta sentinel');
    });
  });
});
