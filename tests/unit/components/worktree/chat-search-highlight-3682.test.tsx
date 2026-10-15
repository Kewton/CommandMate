/**
 * A search hit on the whole of a reference drawing one character
 * (`&lt;` → `<`) or whitespace (`&ThickSpace;` → U+205F U+200A) is marked on
 * what it drew — on both surfaces (Issue #3682). Before, the hit was counted
 * but not placed, so nothing was marked.
 *
 * Both surfaces are rendered from their parents through the real Markdown
 * pipelines (as in `chat-search-highlight-3671.test.tsx`).
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
    id: `msg-3682-${sequence}`,
    worktreeId: 'wt-3682',
    role: 'assistant',
    content: '',
    timestamp: new Date(Date.UTC(2026, 9, 13, 10, 0, sequence)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: opencodeTurnRequestId(`msg_3682_${sequence}`),
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
    render(<ChatTranscript messages={messages} worktreeId="wt-3682" cliToolId="opencode" onFilePathClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), { target: { value: query } });
  } else {
    render(<HistoryPane messages={messages} worktreeId="wt-3682" onFilePathClick={vi.fn()} splitIndex={2} />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: query } });
  }
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

describe.each(SURFACES)('[#3682] %s: a hit on the whole of a one-unit or whitespace reference', (surface, name, overlayId) => {
  it('`&lt;`: marks the `<` it drew, and the current one has its overlay', async () => {
    // Two hits: the current one gets the overlay, the other is marked.
    searchOn(surface, conversation(['a &lt; b and c &lt; d']), '&lt;');
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['<']);
      expect(overlayReply(overlayId)).toBe(0);
    });
  });

  it('`&ThickSpace;`: marks the whitespace it drew, and the current one has its overlay', async () => {
    searchOn(surface, conversation(['a&ThickSpace;b and c&ThickSpace;d']), '&ThickSpace;');
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['  ']);
      expect(overlayReply(overlayId)).toBe(0);
    });
  });

  it('negative control: the word after the references is marked as before', async () => {
    searchOn(surface, conversation(['a&ThickSpace;b &lt; sentinel and sentinel']));
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel']);
      expect(overlayReply(overlayId)).toBe(0);
    });
  });
});
