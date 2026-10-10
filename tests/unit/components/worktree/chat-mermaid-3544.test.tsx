/**
 * The search fallback in both surfaces (Issue #3544).
 *
 * A chat answer whose lines cannot be lined up with the message (here: a
 * folded `> **Thinking**` quote and a trailing hard break, which the split
 * trims off) draws its diagram's source without a raw range, so search reads
 * the fences itself (`findMermaidFences`). It used to take
 * `text\n  more\n2. ```mermaid` — paragraph text to Markdown — for a fence,
 * which took the real diagram's source; the real diagram's hit went unmarked.
 * History draws the message as written (raw ranges named) and is the
 * structural control. Both surfaces go through `findMermaidFences` only via
 * `applyHistoryHighlights`; the spy pins which one reaches it.
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

import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { MERMAID_RAW_START_ATTR, MERMAID_SOURCE_ATTR } from '@/lib/terminal-highlight';
import * as fences from '@/lib/terminal-highlight-fences';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-3544',
    worktreeId: 'wt-3544',
    role: 'assistant',
    content: '',
    timestamp: new Date(Date.UTC(2026, 9, 10, 11, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: opencodeTurnRequestId('msg_3544'),
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
    render(<ChatTranscript messages={messages} worktreeId="wt-3544" cliToolId="opencode" onFilePathClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), { target: { value: query } });
  } else {
    render(<HistoryPane messages={messages} worktreeId="wt-3544" onFilePathClick={vi.fn()} splitIndex={2} />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: query } });
  }
}

function sources(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${MERMAID_SOURCE_ATTR}]`));
}

const CONTENT = [
  '> **Thinking**',
  '> pondering',
  '',
  'Intro line',
  '  indented continuation',
  '2. ```mermaid',
  '   graph TD',
  '   A[sentinel]',
  '```mermaid',
  'graph TD',
  'A[sentinel]',
  '```',
  'Done.  ',
].join('\n');

describe.each(SURFACES)('[#3544] %s: `2. ```mermaid` after an indented paragraph line', (surface, name) => {
  afterEach(() => vi.restoreAllMocks());

  it('the paragraph’s hit stays in the paragraph; the real diagram’s hit is marked in its source', async () => {
    const fallback = vi.spyOn(fences, 'findMermaidFences');
    searchOn(surface, CONTENT);
    await waitFor(() => {
      const [source, ...rest] = sources();
      expect(rest).toHaveLength(0);
      expect(source.textContent).toBe('graph TD\nA[sentinel]');
      const marked = registry.get(name)?.ranges ?? [];
      expect(marked).toHaveLength(1);
      expect(marked[0].toString()).toBe('sentinel');
      expect(source.contains(marked[0].startContainer)).toBe(true);
      expect((source.closest('details') as HTMLDetailsElement).open).toBe(true);
      expect(scrollTargets.some((el) => el.closest('p')?.textContent?.includes('Intro line'))).toBe(true);
      expect(scrollTargets).not.toContain(source);
    });
    // Chat could not line the answer up (no raw range → the fallback); History
    // draws the message as written (the range → no fallback).
    const [source] = sources();
    if (surface === 'ChatTranscript') {
      expect(source.hasAttribute(MERMAID_RAW_START_ATTR)).toBe(false);
      expect(fallback).toHaveBeenCalledWith(CONTENT);
    } else {
      expect(source.getAttribute(MERMAID_RAW_START_ATTR)).toBe(String(CONTENT.indexOf('```mermaid\ngraph')));
      expect(fallback).not.toHaveBeenCalled();
    }
  });
});
