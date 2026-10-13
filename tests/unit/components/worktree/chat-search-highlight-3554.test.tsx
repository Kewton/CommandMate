/**
 * Search hits in chat's folded answer and reasoning land on the word, on both
 * surfaces, where the split trimmed the answer or joined two reasoning
 * sections (Issue #3554).
 *
 * Before, `chatMarkdownRawOffsets` could not line those parts up with the
 * message and answered null: the answer's elements carried no raw offsets
 * (#3523), so a hit after a Markdown marker landed that many characters late,
 * and a diagram's source named no fence (#3525). Both surfaces are rendered
 * from their parents through the real Markdown pipelines; only the dynamically
 * imported `MermaidDiagram` is a stand-in (as in `chat-mermaid-3525.test.tsx`).
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
import { MERMAID_SOURCE_ATTR } from '@/lib/terminal-highlight';
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

const LEGACY = ['> **Thinking**', '> pondering', ''];

// Each hit appears twice so one is non-current (registered in CSS.highlights).
const ANSWERS: Array<[string, string]> = [
  ['trailing spaces on the last line', [...LEGACY, '**Bold** sentinel here', '', '**Bold** sentinel again  '].join('\n')],
  ['a trailing tab', [...LEGACY, '**Bold** sentinel here', '', '**Bold** sentinel again\t'].join('\n')],
  ['a mixed CRLF last line', [...LEGACY, '**Bold** sentinel here\r', '\r', '**Bold** sentinel again\r'].join('\n')],
  ['a full-width space in front', [...LEGACY, '\u3000**Bold** sentinel here', '', '**Bold** sentinel again'].join('\n')],
];

describe.each(SURFACES)('[#3554] %s: a trimmed answer', (surface, name) => {
  it.each(ANSWERS)('%s: the hit after the marker lands on the word', async (_label, content) => {
    searchOn(surface, content);
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel']);
    });
  });
});

describe.each(SURFACES)('[#3554] %s: two legacy reasoning sections', (surface, name) => {
  it('hits in both sections and the answer land on the word', async () => {
    const content = [
      '> **Thinking**',
      '> First **thought** sentinel',
      '',
      'The **answer** sentinel.',
      '',
      '> **Thinking**',
      '> Second **thought** sentinel',
    ].join('\n');
    searchOn(surface, content);
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel', 'sentinel']);
    });
  });
});

// The diagram's fence sits in a nested list, where the line pattern search
// falls back to (`findMermaidFences`) does not read it: only the raw range the
// source names pairs it, and the answer has to map for the source to name one.
const DIAGRAM_CASES: Array<[string, string[]]> = [
  ['a nested-list fence', ['- outer', '  - inner', '    ```mermaid', '    graph TD', '    A[sentinel]', '    ```  ']],
  // Negative control: a top-level fence the line pattern reads as well.
  ['a top-level fence', ['```mermaid', 'graph TD', 'A[sentinel]', '```  ']],
];

describe.each(SURFACES)('[#3554] %s: the same text in a trimmed answer and in a diagram', (surface, name) => {
  it.each(DIAGRAM_CASES)('%s: the answer’s hit stays in the paragraph, the diagram’s opens the diagram', async (_label, diagram) => {
    const content = [...LEGACY, 'Then **A[sentinel]** again', '', 'Then **A[sentinel]** again', '', ...diagram].join('\n');
    searchOn(surface, content);
    await waitFor(() => {
      const [source, ...rest] = Array.from(document.querySelectorAll<HTMLElement>(`[${MERMAID_SOURCE_ATTR}]`));
      expect(rest).toHaveLength(0);
      expect(source.textContent).toBe('graph TD\nA[sentinel]');
      const ranges = marked(name);
      expect(ranges.map((range) => range.toString())).toEqual(['sentinel', 'sentinel']);
      // Non-current: the 2nd paragraph's hit (the 1st is current), then the diagram's.
      const paragraphs = Array.from(document.querySelectorAll('p')).filter((p) => p.textContent?.startsWith('Then'));
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[1].contains(ranges[0].startContainer)).toBe(true);
      expect(source.contains(ranges[1].startContainer)).toBe(true);
      expect((source.closest('details') as HTMLDetailsElement).open).toBe(true);
    });
  });
});

describe.each(SURFACES)('[#3554] %s: negative controls', (surface, name) => {
  it('an answer with nothing folded, hard break and all', async () => {
    searchOn(surface, '**Bold** sentinel here  \n**Bold** sentinel again  ');
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel']);
    });
  });

  it('a hard break in the middle of a folded answer', async () => {
    searchOn(surface, [...LEGACY, '**Bold** sentinel here  ', '**Bold** sentinel again'].join('\n'));
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel']);
    });
  });

  it('two reasoning sections in the new shape', async () => {
    const content = [
      '> **Thinking**',
      '>',
      '> First **thought** sentinel',
      '',
      'The **answer** sentinel.',
      '',
      '> **Thinking**',
      '>',
      '> Second **thought** sentinel',
    ].join('\n');
    searchOn(surface, content);
    await waitFor(() => {
      expect(marked(name).map((range) => range.toString())).toEqual(['sentinel', 'sentinel']);
    });
  });
});
