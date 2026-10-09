/**
 * ```mermaid fences are drawn as diagrams on chat (settled rows), History and
 * the file preview — and only there (Issue #3503).
 *
 * Runs the real Markdown pipelines (`SHARED_REMARK_PLUGINS` → sanitize →
 * highlight) and the real `MermaidCodeBlock`; only the dynamically imported
 * `MermaidDiagram` is replaced (by `next/dynamic`'s mock) with a stand-in that
 * draws an SVG carrying the query word and reports a render state — the real
 * mermaid runtime is exercised in `MermaidDiagram-real-3503.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import type { ConversationPair } from '@/types/conversation';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import { TURN_REASONING_LABEL, TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';

const fake = vi.hoisted(() => ({
  state: 'rendered' as 'rendered' | 'error',
  codes: [] as string[],
}));

vi.mock('next/dynamic', () => ({
  default: () => {
    function FakeMermaidDiagram({
      code,
      onRenderStateChange,
    }: {
      code: string;
      onRenderStateChange?: (state: 'rendered' | 'error') => void;
    }) {
      useEffect(() => {
        fake.codes.push(code);
        onRenderStateChange?.(fake.state);
      }, [code, onRenderStateChange]);
      return fake.state === 'error' ? (
        <div data-testid="mermaid-error">Parse error sentinel</div>
      ) : (
        <div data-testid="mermaid-container">
          <svg>
            <style>{'#m .node { fill: sentinel; }'}</style>
            <text>sentinel label</text>
          </svg>
        </div>
      );
    }
    return FakeMermaidDiagram;
  },
}));

const copyToClipboardMock = vi.fn(async (_text: string) => {});
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (text: string) => copyToClipboardMock(text),
}));

import {
  CHAT_THINKING_BODY_TESTID,
  CHAT_THINKING_TOGGLE_TESTID,
  CHAT_TOOL_LOG_BODY_TESTID,
  CHAT_TOOL_LOG_TOGGLE_TESTID,
  ChatMarkdownBody,
  ChatMessageBubble,
} from '@/components/worktree/ChatMessageBubble';
import { ChatTranscript, type ChatTranscriptLiveTurn } from '@/components/worktree/ChatTranscript';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { MarkdownPreview } from '@/components/worktree/MarkdownPreview';
import { HistoryPane } from '@/components/worktree/HistoryPane';
import { MERMAID_BLOCK_TESTID, MERMAID_SOURCE_TESTID } from '@/components/worktree/MermaidCodeBlock';
import { MERMAID_BLOCK_SETTLED_EVENT, MERMAID_SOURCE_ATTR, SEARCH_SKIP_ATTR } from '@/lib/terminal-highlight';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';

const DIAGRAM = 'graph TD\nA[sentinel start] --> B[end]';
const FENCE = ['```mermaid', DIAGRAM, '```'].join('\n');
const ANSWER = ['Before the diagram.', '', FENCE, '', 'After the sentinel diagram, `inline`.', '', '```js', 'const x = 1;', '```'].join('\n');

const MARKDOWN_ID = opencodeTurnRequestId('msg_3503');

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-3503',
    worktreeId: 'wt-3503',
    role: 'assistant',
    content: ANSWER,
    timestamp: new Date(Date.UTC(2026, 9, 10, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: MARKDOWN_ID,
    ...overrides,
  };
}

function frames(scope: ParentNode = document): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="${MERMAID_BLOCK_TESTID}"]`));
}

/** The diagram + folded-source contract every surface shares. */
function expectDiagramFrame(frame: HTMLElement, body: string): void {
  // Not inside a <pre>: the surfaces' `pre` rules paint the dark code canvas.
  expect(frame.closest('pre')).toBeNull();
  expect(within(frame).getByTestId('mermaid-container')).toBeInTheDocument();
  const fold = within(frame).getByTestId(MERMAID_SOURCE_TESTID) as HTMLDetailsElement;
  expect(fold.tagName).toBe('DETAILS');
  expect(fold.open).toBe(false);
  const source = fold.querySelector(`[${MERMAID_SOURCE_ATTR}]`) as HTMLElement;
  expect(source.textContent).toBe(body);
  // Text, never HTML.
  expect(source.children).toHaveLength(0);
  expect(fold.querySelector('summary')?.textContent).toBe('worktree.mermaid.source');
  expect(fold.querySelector('summary')?.hasAttribute(SEARCH_SKIP_ATTR)).toBe(true);
  expect(frame.querySelector('svg')?.closest(`[${SEARCH_SKIP_ATTR}]`)).not.toBeNull();
}

/** A non-mermaid fence and inline code, as react-markdown has always drawn them. */
function expectOrdinaryCode(scope: HTMLElement): void {
  const js = scope.querySelector('code.language-js') as HTMLElement;
  expect(js).not.toBeNull();
  expect(js.parentElement?.tagName).toBe('PRE');
  expect(js.className).toContain('hljs');
  const inline = Array.from(scope.querySelectorAll('p code')).find((c) => c.textContent === 'inline');
  expect(inline).toBeDefined();
  expect(inline?.closest('pre')).toBeNull();
}

beforeEach(() => {
  fake.state = 'rendered';
  fake.codes = [];
  copyToClipboardMock.mockClear();
});

describe('[#3503] settled chat rows draw diagrams', () => {
  it('draws the answer’s mermaid fence, with the source folded under it', () => {
    render(<ChatMessageBubble message={message()} showHeader onFilePathClick={vi.fn()} />);
    const body = document.querySelector('[data-message-id="msg-3503"]') as HTMLElement;
    const [frame, ...rest] = frames(body);
    expect(rest).toHaveLength(0);
    expectDiagramFrame(frame, DIAGRAM);
    // The real pipeline delivered `language-mermaid`, with hast's trailing newline.
    expect(fake.codes).toEqual([`${DIAGRAM}\n`]);
    expectOrdinaryCode(body);
  });

  it('draws diagrams in the reasoning chip and the tool log chip', () => {
    const quoted = (lines: string[]) => lines.map((l) => (l ? `> ${l}` : '>'));
    const content = [
      'The answer.',
      '',
      `> **${TURN_REASONING_LABEL} (1)**`,
      '>',
      ...quoted(['```mermaid', 'graph TD', 'R[reason]', '```']),
      '',
      `> **${TURN_TOOL_LOG_LABEL} (1)**`,
      '>',
      ...quoted(['```mermaid', 'graph TD', 'T[tool]', '```']),
    ].join('\n');
    render(<ChatMessageBubble message={message({ content })} showHeader onFilePathClick={vi.fn()} />);

    fireEvent.click(screen.getByTestId(CHAT_THINKING_TOGGLE_TESTID));
    const [thinking] = frames(screen.getByTestId(CHAT_THINKING_BODY_TESTID));
    expectDiagramFrame(thinking, 'graph TD\nR[reason]');

    fireEvent.click(screen.getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID));
    const [tool] = frames(screen.getByTestId(CHAT_TOOL_LOG_BODY_TESTID));
    expectDiagramFrame(tool, 'graph TD\nT[tool]');
  });

  it('opens the source and shows the error when the diagram fails', async () => {
    fake.state = 'error';
    render(<ChatMessageBubble message={message()} showHeader onFilePathClick={vi.fn()} />);
    const [frame] = frames();
    expect(within(frame).getByTestId('mermaid-error')).toBeInTheDocument();
    const fold = within(frame).getByTestId(MERMAID_SOURCE_TESTID) as HTMLDetailsElement;
    await waitFor(() => expect(fold.open).toBe(true));
    expect(fold.querySelector(`[${MERMAID_SOURCE_ATTR}]`)?.textContent).toBe(DIAGRAM);
  });

  it('copies the message as written — no SVG text, no "Source" label', () => {
    render(
      <ChatMessageBubble
        message={message()}
        showHeader
        onFilePathClick={vi.fn()}
        onCopy={(text: string) => copyToClipboardMock(text)}
      />,
    );
    fireEvent.click(screen.getByTestId('chat-copy-message'));
    const copied = copyToClipboardMock.mock.calls[0][0];
    expect(copied).toBe(ANSWER);
    expect(copied).not.toContain('sentinel label');
    expect(copied).not.toContain('worktree.mermaid.source');
  });

  it('negative control: without mermaid, renderDiagrams changes nothing', () => {
    const plain = ['Text with `inline`.', '', '```js', 'const x = 1;', '```', '', '```', 'bare', '```'].join('\n');
    const on = render(<ChatMarkdownBody content={plain} onFilePathClick={vi.fn()} renderDiagrams />);
    const htmlOn = on.container.innerHTML;
    on.unmount();
    const off = render(<ChatMarkdownBody content={plain} onFilePathClick={vi.fn()} />);
    expect(htmlOn).toBe(off.container.innerHTML);
  });
});

describe('[#3503] live and pending bodies keep the fence as code', () => {
  it('ChatMarkdownBody draws nothing by default (the live / pending call sites)', () => {
    const { container } = render(<ChatMarkdownBody content={ANSWER} onFilePathClick={vi.fn()} />);
    expect(frames(container)).toHaveLength(0);
    const code = container.querySelector('code.language-mermaid') as HTMLElement;
    expect(code.parentElement?.tagName).toBe('PRE');
    expect(code.textContent).toBe(`${DIAGRAM}\n`);
    expect(fake.codes).toEqual([]);
  });

  const LIVE: ChatTranscriptLiveTurn = {
    turnKey: MARKDOWN_ID,
    version: 1,
    body: ANSWER,
    partial: false,
    isThinking: false,
  };
  const user = message({ id: 'u-3503', role: 'user', content: 'draw it', requestId: undefined });

  function transcript(messages: ChatMessage[], liveTurn?: ChatTranscriptLiveTurn) {
    return (
      <ChatTranscript
        messages={messages}
        worktreeId="wt-3503"
        cliToolId="opencode"
        liveTurn={liveTurn}
        onFilePathClick={vi.fn()}
      />
    );
  }

  it('a generating turn shows the source; the saved row draws it', () => {
    const { rerender } = render(transcript([user], LIVE));
    expect(screen.getByTestId('chat-live-turn-body').querySelector('code.language-mermaid')).not.toBeNull();
    expect(frames()).toHaveLength(0);

    rerender(transcript([user, message()]));
    expect(screen.queryByTestId('chat-live-turn')).toBeNull();
    expect(frames()).toHaveLength(1);
  });

  it('a held (settling) turn shows the source too', () => {
    render(transcript([user], { ...LIVE, settling: true }));
    const live = screen.getByTestId('chat-live-turn');
    expect(live).toHaveAttribute('data-settling', 'true');
    expect(live.querySelector('code.language-mermaid')).not.toBeNull();
    expect(frames()).toHaveLength(0);
  });
});

describe('[#3503] History and the file preview draw diagrams', () => {
  it('History’s conversation card', () => {
    const pair: ConversationPair = {
      id: 'pair-3503',
      userMessage: message({ id: 'user-3503', role: 'user', content: 'draw it', requestId: undefined }),
      assistantMessages: [message()],
      status: 'completed',
    };
    const { container } = render(
      <ConversationPairCard pair={pair} onFilePathClick={vi.fn()} isExpanded onToggleExpand={vi.fn()} />,
    );
    const body = container.querySelector('[data-message-id="msg-3503"]') as HTMLElement;
    const [frame] = frames(body);
    expectDiagramFrame(frame, DIAGRAM);
    expectOrdinaryCode(body);
  });

  it('the file preview, which keeps its copy button on other code only', () => {
    const { container } = render(<MarkdownPreview content={ANSWER} />);
    const [frame] = frames(container);
    expectDiagramFrame(frame, DIAGRAM);
    expect(frame.closest('[data-testid="code-block-with-copy"]')).toBeNull();
    expect(container.querySelector('code.language-js')?.closest('[data-testid="code-block-with-copy"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Search: ChatTranscript and HistoryPane both place hits on the folded source
// ---------------------------------------------------------------------------

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

describe('[#3503] search highlights reach the folded source', () => {
  let registry: Map<string, FakeHighlight>;
  let originalCSS: PropertyDescriptor | undefined;
  let originalHighlight: PropertyDescriptor | undefined;
  let restoreLayout: () => void;

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
  });

  afterEach(() => {
    restoreLayout();
    if (originalCSS) Object.defineProperty(globalThis, 'CSS', originalCSS);
    else delete (globalThis as { CSS?: unknown }).CSS;
    if (originalHighlight) Object.defineProperty(globalThis, 'Highlight', originalHighlight);
    else delete (globalThis as { Highlight?: unknown }).Highlight;
  });

  /** The text of every non-current marked range (the current one is the overlay). */
  function markedTexts(name: string): string[] {
    return (registry.get(name)?.ranges ?? []).map((r) => r.toString());
  }

  function expectSourceHit(name: string): void {
    const ranges = registry.get(name)?.ranges ?? [];
    // `sentinel` is in the diagram's source, in the text after it, and in the
    // stand-in SVG (twice) — which must not count.
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((r) => r.toString() === 'sentinel')).toBe(true);
    for (const range of ranges) {
      expect(range.startContainer.parentElement?.closest(`[${SEARCH_SKIP_ATTR}]`)).toBeNull();
    }
    const fold = document.querySelector(`[data-testid="${MERMAID_SOURCE_TESTID}"]`) as HTMLDetailsElement;
    expect(fold.open).toBe(true);
  }

  it('ChatTranscript', async () => {
    render(
      <ChatTranscript
        messages={[message({ id: 'u-1', role: 'user', content: 'draw', requestId: undefined }), message()]}
        worktreeId="wt-3503"
        cliToolId="opencode"
        onFilePathClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
      target: { value: 'sentinel' },
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1/2'));
    // The current hit (the one in the diagram) is the overlay; the other is the
    // text after the diagram.
    await waitFor(() => expect(markedTexts('chat-search')).toEqual(['sentinel']));
    expectSourceHit('chat-search');
    const [after] = registry.get('chat-search')!.ranges;
    expect(after.startContainer.parentElement?.closest(`[${MERMAID_SOURCE_ATTR}]`)).toBeNull();
  });

  it('HistoryPane', async () => {
    render(
      <HistoryPane
        messages={[message({ id: 'u-1', role: 'user', content: 'draw', requestId: undefined }), message()]}
        worktreeId="wt-3503"
        onFilePathClick={vi.fn()}
        splitIndex={2}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /search/i }));
    fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: 'sentinel' } });
    await waitFor(() => expect(markedTexts('history-search-2')).toEqual(['sentinel']));
    expectSourceHit('history-search-2');
  });

  it.each([
    ['ChatTranscript', 'chat-search'],
    ['HistoryPane', 'history-search-2'],
  ])('%s re-applies the marks when a diagram finishes drawing during a search', async (surface, name) => {
    const messages = [message({ id: 'u-1', role: 'user', content: 'draw', requestId: undefined }), message()];
    if (surface === 'ChatTranscript') {
      render(<ChatTranscript messages={messages} worktreeId="wt-3503" cliToolId="opencode" onFilePathClick={vi.fn()} />);
      fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
      fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
        target: { value: 'sentinel' },
      });
    } else {
      render(<HistoryPane messages={messages} worktreeId="wt-3503" onFilePathClick={vi.fn()} splitIndex={2} />);
      fireEvent.click(screen.getByRole('button', { name: /search/i }));
      fireEvent.change(screen.getByLabelText(/keyword/i), { target: { value: 'sentinel' } });
    }
    await waitFor(() => expect(markedTexts(name)).toEqual(['sentinel']));
    const before = registry.get(name);

    // A redraw (late load, theme switch) settles: the frame announces it.
    const [frame] = frames();
    fireEvent(frame, new CustomEvent(MERMAID_BLOCK_SETTLED_EVENT, { bubbles: true }));

    await waitFor(() => expect(registry.get(name)).not.toBe(before));
    expect(markedTexts(name)).toEqual(['sentinel']);
    expectSourceHit(name);
  });
});
