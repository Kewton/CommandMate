/**
 * Search pairs a hit with the diagram Markdown actually drew (Issue #3525).
 *
 * #3503 found ```mermaid fences in the raw text with a line pattern and paired
 * them with the folded sources by body. That disagreed with the renderer for
 * fences in nested lists, behind tabs and inside the quoted tool log (never
 * highlighted), and for `text\n2. ```mermaid` (paragraph text to Markdown, a
 * fence to the pattern — the later real diagram's hit went nowhere and the
 * paragraph's hit landed on the diagram). The mermaid source now names the raw
 * range of its fence (react-markdown's `node.position`), and search pairs by
 * that.
 *
 * Both surfaces are rendered from their parents (ChatTranscript, HistoryPane)
 * through the real Markdown pipelines; only the dynamically imported
 * `MermaidDiagram` is a stand-in (as in `chat-mermaid-3503.test.tsx`).
 *
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import { TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

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
import { MarkdownPreview } from '@/components/worktree/MarkdownPreview';
import { MERMAID_RAW_START_ATTR, MERMAID_SOURCE_ATTR } from '@/lib/terminal-highlight';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-3525',
    worktreeId: 'wt-3525',
    role: 'assistant',
    content: '',
    timestamp: new Date(Date.UTC(2026, 9, 10, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: opencodeTurnRequestId('msg_3525'),
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
    render(<ChatTranscript messages={messages} worktreeId="wt-3525" cliToolId="opencode" onFilePathClick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), { target: { value: query } });
  } else {
    render(<HistoryPane messages={messages} worktreeId="wt-3525" onFilePathClick={vi.fn()} splitIndex={2} />);
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: query } });
  }
}

function sources(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${MERMAID_SOURCE_ATTR}]`));
}

/** The one hit is the current one: scrolled to from its diagram's source, which opens. */
async function expectOnlyHitOpensTheSource(body: string): Promise<void> {
  await waitFor(() => {
    const [source, ...rest] = sources();
    expect(rest).toHaveLength(0);
    expect(source.textContent).toBe(body);
    expect(scrollTargets).toContain(source);
    expect((source.closest('details') as HTMLDetailsElement).open).toBe(true);
  });
}

// A fence in a list nested in a list: indented 4 — past what the line pattern reads.
const NESTED = ['The answer.', '', '- outer', '  - inner', '    ```mermaid', '    graph TD', '    A[sentinel]', '    ```'].join(
  '\n',
);
// A list item opened by a tab, its lines indented by tabs.
const TABBED = ['The answer.', '', '-\t```mermaid', '\tgraph TD', '\tA[sentinel]', '\t```'].join('\n');
// The tool log: a quoted list whose entry holds a nested list holding the diagram.
const TOOL_LOG = [
  'The answer.',
  '',
  `> **${TURN_TOOL_LOG_LABEL} (1)**`,
  '>',
  '> - `Read` — notes.md',
  '>   - result:',
  '>     ```mermaid',
  '>     graph TD',
  '>     A[sentinel]',
  '>     ```',
].join('\n');

describe.each(SURFACES)('[#3525] %s: hits in diagrams the line pattern could not read', (surface) => {
  it('a nested list', async () => {
    searchOn(surface, NESTED);
    await expectOnlyHitOpensTheSource('graph TD\nA[sentinel]');
  });

  it('tab indentation', async () => {
    searchOn(surface, TABBED);
    await expectOnlyHitOpensTheSource('graph TD\nA[sentinel]');
  });

  it('a list inside the tool log', async () => {
    searchOn(surface, TOOL_LOG);
    await expectOnlyHitOpensTheSource('graph TD\nA[sentinel]');
  });
});

// Markdown reads `2. ```mermaid` after a paragraph line as paragraph text (only
// a list starting at 1 interrupts a paragraph); the real diagram comes after.
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

describe.each(SURFACES)('[#3525] %s: `2. ```mermaid` after a paragraph is not a fence', (surface, name) => {
  it('the paragraph’s hit stays in the paragraph; the diagram’s hit opens the diagram', async () => {
    searchOn(surface, PARAGRAPH_THEN_TWO);
    await waitFor(() => {
      const [source, ...rest] = sources();
      expect(rest).toHaveLength(0);
      expect(source.textContent).toBe('graph TD\nA[sentinel]');
      // Non-current = the 2nd raw hit, in the real fence → that diagram's source.
      const marked = registry.get(name)?.ranges ?? [];
      expect(marked).toHaveLength(1);
      expect(marked[0].toString()).toBe('sentinel');
      expect(source.contains(marked[0].startContainer)).toBe(true);
      expect((source.closest('details') as HTMLDetailsElement).open).toBe(true);
      // Current = the 1st raw hit, in the paragraph → scrolled to from the paragraph.
      expect(scrollTargets.some((el) => el.closest('p')?.textContent?.includes('Intro line'))).toBe(true);
      expect(scrollTargets).not.toContain(source);
    });
  });
});

describe('[#3525] the file preview is drawn as before', () => {
  it('only the raw-range attributes are added to the source', () => {
    const { container } = render(<MarkdownPreview content={['Intro', '', '```mermaid', 'graph TD', '```'].join('\n')} />);
    const [source] = Array.from(container.querySelectorAll(`[${MERMAID_SOURCE_ATTR}]`));
    expect(source.textContent).toBe('graph TD');
    expect(source.getAttribute(MERMAID_RAW_START_ATTR)).toBe('7');
  });
});
