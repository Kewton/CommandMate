/**
 * A paragraph of chat's answer with a `> **Thinking**` section folded out from
 * between two of its lines is placed line by line (Issue #3554).
 *
 * `'intro\n> **Thinking**\n> sentinel\nsentinel  '`: Markdown draws the
 * answer `intro\nsentinel` as one paragraph — one text node whose raw range
 * spans the folded quote. The highlight pass (`rehypeSearchRawText`) named only
 * that range's two ends, and the search re-matched the node's text from the
 * front of it: the answer's `sentinel` took the reasoning's, so the
 * reasoning's hit was marked in the answer and the answer's own hit went
 * astray. The pass now keeps each drawn line in the raw line it came from.
 * Both chat bubbles (saved: `ChatMessageBubble`; generating:
 * `ChatLiveTurnBubble`) draw through it; History draws the message as written.
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
            <text>sentinel label</text>
          </svg>
        </div>
      );
    }
    return FakeMermaidDiagram;
  },
}));

import { ChatTranscript, type ChatTranscriptLiveTurn } from '@/components/worktree/ChatTranscript';
import { chatSearchSections } from '@/components/worktree/chat-search-sections';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { applyHistoryHighlights, makeHistoryNamespace, SEARCH_RAW_ATTR } from '@/lib/terminal-highlight';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-3554',
    worktreeId: 'wt-3554',
    role: 'assistant',
    content: '',
    timestamp: new Date(Date.UTC(2026, 9, 10, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: opencodeTurnRequestId('msg_3554'),
    ...overrides,
  };
}

const USER = message({ id: 'u-1', role: 'user', content: 'draw', requestId: undefined });

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

let registry: Map<string, FakeHighlight>;
let originalCSS: PropertyDescriptor | undefined;
let originalHighlight: PropertyDescriptor | undefined;
let restoreLayout: () => void;
let scrollTargets: Element[];
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

function searchOn(surface: Surface, content: string, query = 'sentinel'): void {
  const messages = [USER, message({ content })];
  if (surface === 'ChatTranscript') {
    render(<ChatTranscript messages={messages} worktreeId="wt-3554" cliToolId="opencode" onFilePathClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), { target: { value: query } });
  } else {
    render(<HistoryPane messages={messages} worktreeId="wt-3554" onFilePathClick={vi.fn()} splitIndex={2} />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: query } });
  }
}

function marked(name: string): Range[] {
  return registry.get(name)?.ranges ?? [];
}

const INTERLEAVED = 'intro\n> **Thinking**\n> sentinel\nsentinel  ';
const BODY_HIT = INTERLEAVED.lastIndexOf('sentinel');

/** The answer's paragraph (`intro\nsentinel`) and the reasoning's in `root`. */
function paragraphs(root: ParentNode = document): { answer: HTMLElement; reasoning: HTMLElement | undefined } {
  const all = Array.from(root.querySelectorAll<HTMLElement>('p'));
  const answer = all.find((p) => p.textContent === 'intro\nsentinel')!;
  return { answer, reasoning: all.find((p) => p !== answer && p.textContent === 'sentinel') };
}

describe('[#3554] ChatTranscript: a Thinking section folded out of the middle of a paragraph', () => {
  it('the answer’s hit is marked on the answer’s word; the reasoning’s hit is not marked in the answer', async () => {
    searchOn('ChatTranscript', INTERLEAVED);
    await waitFor(() => {
      const { answer, reasoning } = paragraphs();
      expect(reasoning).toBeDefined();
      // Non-current = the 2nd raw hit, the answer's.
      const [hit, ...rest] = marked('chat-search');
      expect(rest).toHaveLength(0);
      expect(hit.toString()).toBe('sentinel');
      expect(answer.contains(hit.startContainer)).toBe(true);
      expect(hit.startOffset).toBe('intro\n'.length);
      // Current = the 1st raw hit, the reasoning's: scrolled to from the reasoning, not the answer.
      expect(scrollTargets.some((el) => reasoning!.contains(el))).toBe(true);
      expect(scrollTargets.some((el) => answer.contains(el))).toBe(false);
    });
  });
});

describe('[#3554] ChatTranscript: the generating turn draws the same paragraph line by line', () => {
  it('ChatLiveTurnBubble places the answer’s hit on the answer’s word', () => {
    const live: ChatTranscriptLiveTurn = { turnKey: 'live-3554', version: 1, body: INTERLEAVED, partial: false, isThinking: false };
    render(<ChatTranscript messages={[USER]} worktreeId="wt-3554" cliToolId="opencode" liveTurn={live} onFilePathClick={vi.fn()} />);
    const body = screen.getByTestId('chat-live-turn-body');
    const { answer } = paragraphs(body);
    // The paragraph names both raw spans it is made of, and so does each line.
    expect(answer.getAttribute(SEARCH_RAW_ATTR)).toBe(`0,6,${BODY_HIT},${BODY_HIT + 8};0,6,6;${BODY_HIT},${BODY_HIT + 8},8`);
    const namespace = makeHistoryNamespace(7);
    applyHistoryHighlights(body, [{ start: BODY_HIT, end: BODY_HIT + 8 }, { start: 0, end: 5 }], 1, namespace, {
      sourceText: INTERLEAVED,
      sections: chatSearchSections(INTERLEAVED),
    });
    const [hit, ...rest] = marked(namespace.highlightName);
    expect(rest).toHaveLength(0);
    expect(hit.toString()).toBe('sentinel');
    expect(answer.contains(hit.startContainer)).toBe(true);
    expect(hit.startOffset).toBe('intro\n'.length);
  });
});

describe('[#3554] HistoryPane: the same message, drawn as written', () => {
  it('is marked as before (the quote’s lazy continuation holds both)', async () => {
    searchOn('HistoryPane', INTERLEAVED);
    await waitFor(() => {
      expect(marked('history-search-2').map((range) => range.toString())).toEqual(['sentinel']);
    });
  });
});

// Negative controls: a paragraph whose lines are next to each other in the raw
// text is placed by its whole range, as before.
const UNCHANGED: Array<[string, string]> = [
  ['no section inside the paragraph', '> **Thinking**\n> pondering\n\n**Bold** sentinel here\nmore\n\n**Bold** sentinel again'],
  [
    'the new shape, between paragraphs',
    '> **Thinking**\n>\n> pondering\n\n**Bold** sentinel here\n\n> **Thinking**\n>\n> more\n\n**Bold** sentinel again',
  ],
  ['a diagram', '> **Thinking**\n> pondering\n\n**Bold** sentinel here\n\n```mermaid\ngraph TD\nA[sentinel]\n```'],
];

describe.each(SURFACES)('[#3554] %s: negative controls for the line-by-line placement', (surface, name) => {
  it.each(UNCHANGED)('%s', async (_label, content) => {
    searchOn(surface, content);
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel']);
    });
    for (const p of Array.from(document.querySelectorAll('p[data-search-raw]'))) {
      // One segment per text child, as before: no paragraph here was split.
      const segments = (p.getAttribute(SEARCH_RAW_ATTR) ?? '').split(';').slice(1);
      expect(segments.length).toBeLessThanOrEqual(p.childNodes.length);
    }
  });
});

// [#3554] The drawn text's line breaks need not be the source's: `&NewLine;`
// adds one, inline code turns one into a space. The folded quote's text is
// still no candidate for the answer's.
const MISMATCHED: Array<[string, string, string]> = [
  ['a `&NewLine;` adds a line break', 'intro&NewLine;\n> **Thinking**\n> sentinel\nsentinel  ', 'P'],
  ['inline code turns one into a space', 'Run `intro\n> **Thinking**\n> sentinel\nsentinel` now  ', 'CODE'],
];

/** The answer's element holding `sentinel` (not the reasoning's paragraph). */
function answerHolder(root: ParentNode, tag: string): HTMLElement {
  return Array.from(root.querySelectorAll<HTMLElement>(tag.toLowerCase())).find(
    (el) => el.textContent !== 'sentinel' && el.textContent?.includes('sentinel'),
  )!;
}

describe('[#3554] ChatTranscript: line breaks that are not the source’s, across a folded section', () => {
  it.each(MISMATCHED)('%s: the answer’s hit is on the answer’s word, the reasoning’s is not', async (_label, content, tag) => {
    searchOn('ChatTranscript', content);
    const bodyHit = content.lastIndexOf('sentinel');
    await waitFor(() => {
      const holder = answerHolder(document, tag);
      const reasoning = Array.from(document.querySelectorAll('p')).find((p) => p.textContent === 'sentinel');
      expect(reasoning).toBeDefined();
      const [hit, ...rest] = marked('chat-search');
      expect(rest).toHaveLength(0);
      expect(hit.toString()).toBe('sentinel');
      expect(holder.contains(hit.startContainer)).toBe(true);
      expect(scrollTargets.some((el) => reasoning!.contains(el))).toBe(true);
      expect(scrollTargets.some((el) => holder.contains(el))).toBe(false);
      expect(bodyHit).toBeGreaterThan(content.indexOf('sentinel'));
    });
  });

  it.each(MISMATCHED)('%s: ChatLiveTurnBubble places the answer’s hit on the answer’s word', (_label, content, tag) => {
    const live: ChatTranscriptLiveTurn = { turnKey: 'live-3554', version: 1, body: content, partial: false, isThinking: false };
    render(<ChatTranscript messages={[USER]} worktreeId="wt-3554" cliToolId="opencode" liveTurn={live} onFilePathClick={vi.fn()} />);
    const body = screen.getByTestId('chat-live-turn-body');
    const holder = answerHolder(body, tag);
    const bodyHit = content.lastIndexOf('sentinel');
    const thinkingHit = content.indexOf('sentinel');
    const namespace = makeHistoryNamespace(7);
    applyHistoryHighlights(
      body,
      [
        { start: thinkingHit, end: thinkingHit + 8 },
        { start: bodyHit, end: bodyHit + 8 },
      ],
      -1,
      namespace,
      { sourceText: content, sections: chatSearchSections(content) },
    );
    const ranges = marked(namespace.highlightName);
    const inAnswer = ranges.filter((range) => holder.contains(range.startContainer));
    expect(inAnswer.map((range) => range.toString())).toEqual(['sentinel']);
    // The reasoning's hit is the reasoning's: it is not the one in the answer.
    // [#3661] The live bubble does not draw the folded reasoning, so its hit
    // has no place and is not marked — it used to fall back to its raw offset
    // as a DOM offset and mark part of the chip's label.
    expect(ranges).toHaveLength(1);
    expect(holder.contains(ranges[0].startContainer)).toBe(true);
  });
});

describe('[#3554] HistoryPane: the `&NewLine;` message, drawn as written', () => {
  it('is marked as before', async () => {
    searchOn('HistoryPane', MISMATCHED[0][1]);
    await waitFor(() => {
      expect(marked('history-search-2').map((range) => range.toString())).toEqual(['sentinel']);
    });
  });
});

// Negative controls: a character reference with no folded section around it,
// and with one but whose line breaks agree, are marked as before.
const REFERENCES: string[] = [
  '> **Thinking**\n> pondering\n\n**Bold** &amp; sentinel here\n\n**Bold** &amp; sentinel again',
  '> **Thinking**\n> pondering\n\n**Bold** sentinel&NewLine;here\n\n**Bold** sentinel again',
];

describe.each(SURFACES)('[#3554] %s: negative controls with character references', (surface, name) => {
  it.each(REFERENCES)('%s', async (content) => {
    searchOn(surface, content);
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel']);
    });
  });
});
