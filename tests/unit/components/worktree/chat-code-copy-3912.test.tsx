/**
 * Chat's code blocks carry their own copy button (Issue #3912).
 *
 * Every surface that draws an agent's answer through `ChatMarkdownBody` — the
 * saved bubble, the live bubble, the settling bubble — wraps each fenced or
 * indented code block in the shared `CodeBlockWithCopy`, exactly as the file
 * preview does. A fence drawn as a diagram is the one exception.
 *
 * Rendered through the real ReactMarkdown, the real search plugin
 * (`rehypeSearchRawText`) and the real `CodeBlockWithCopy`. The clipboard write
 * is the only stand-in, plus (for the diagram cases only) the dynamically
 * imported `MermaidDiagram`, which jsdom cannot draw.
 *
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { opencodeTurnRequestId } from '@/types/agent-transcript';

const fake = vi.hoisted(() => ({ state: 'rendered' as 'rendered' | 'error' }));

vi.mock('next/dynamic', () => ({
  default: () => {
    function FakeMermaidDiagram({
      onRenderStateChange,
    }: {
      code: string;
      onRenderStateChange?: (state: 'rendered' | 'error') => void;
    }) {
      useEffect(() => {
        onRenderStateChange?.(fake.state);
      }, [onRenderStateChange]);
      return fake.state === 'error' ? (
        <div data-testid="mermaid-error">Parse error</div>
      ) : (
        <div data-testid="mermaid-container">
          <svg>
            <text>diagram label</text>
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
  CHAT_THINKING_TOGGLE_TESTID,
  CHAT_TOOL_LOG_TOGGLE_TESTID,
  ChatMarkdownBody,
  ChatMessageBubble,
} from '@/components/worktree/ChatMessageBubble';
import { ChatTranscript, type ChatTranscriptLiveTurn } from '@/components/worktree/ChatTranscript';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { MERMAID_BLOCK_TESTID, MERMAID_SOURCE_TESTID } from '@/components/worktree/MermaidCodeBlock';
import { CodeBlockWithCopy } from '@/components/common/CodeBlockWithCopy';
import { collectTextNodes, SEARCH_SKIP_ATTR } from '@/lib/terminal-highlight-dom';
import { separateTurnBody } from '@/lib/hooks/sources/turn-body';
import { installVirtualLayout } from '@tests/helpers/virtual-layout';
import type { ConversationPair } from '@/types/conversation';

const COPY_BLOCK = '[data-testid="code-block-with-copy"]';

const MARKDOWN_ID = opencodeTurnRequestId('msg_3912');

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a-3912',
    worktreeId: 'wt-3912',
    role: 'assistant',
    content: '',
    timestamp: new Date(Date.UTC(2026, 9, 25, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: MARKDOWN_ID,
    ...overrides,
  };
}

const USER = message({ id: 'u-3912', role: 'user', content: 'show me', requestId: undefined });

/** Every copy block's button (one each, `Copy` or `Copied`), in document order. */
function copyButtons(scope: ParentNode = document): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(COPY_BLOCK)).map((block) => {
    const buttons = within(block).getAllByRole('button', { name: /^Cop(y|ied)$/ });
    expect(buttons).toHaveLength(1);
    return buttons[0] as HTMLButtonElement;
  });
}

async function pressAndRead(button: HTMLElement): Promise<string> {
  copyToClipboardMock.mockClear();
  await act(async () => {
    fireEvent.click(button);
  });
  expect(copyToClipboardMock).toHaveBeenCalledTimes(1);
  return copyToClipboardMock.mock.calls[0][0];
}

// The answer holds four code blocks that must each copy only themselves, plus
// an empty and a whitespace-only fence that must get no button at all.
const BASH = 'echo "a & b" <tag> \'q\' $HOME\n  indented\tline\n\nafter blank';
const PROSE = [
  'Run this:',
  '',
  '```bash',
  BASH,
  '```',
  '',
  'Then `inline` code, and a plain block:',
  '',
  '```',
  'plain block',
  '```',
  '',
  '    indented code',
  '',
  '```js',
  '```',
  '',
  '```',
  '   ',
  '```',
].join('\n');
const REASONING = ['Thinking in code:', '', '```py', "print('think')", '```'].join('\n');
const TOOL = ['```sh', 'tool-output --flag', '```'].join('\n');
const TURN = separateTurnBody([
  { kind: 'prose', text: PROSE },
  { kind: 'reasoning', text: REASONING },
  { kind: 'tool', text: TOOL },
]).body;

beforeEach(() => {
  fake.state = 'rendered';
  copyToClipboardMock.mockClear();
});

describe('[#3912] the copied value', () => {
  it('each block in the answer, the reasoning and the tool log copies exactly itself', async () => {
    render(<ChatMarkdownBody content={TURN} onFilePathClick={vi.fn()} />);

    // Answer: fenced with a language, fenced without, indented. The empty and
    // the whitespace-only fences have no button.
    const answer = copyButtons();
    expect(answer).toHaveLength(3);
    expect(await pressAndRead(answer[0])).toBe(`${BASH}\n`);
    expect(await pressAndRead(answer[1])).toBe('plain block\n');
    expect(await pressAndRead(answer[2])).toBe('indented code\n');
    expect(document.querySelectorAll('pre')).toHaveLength(5);

    fireEvent.click(screen.getByTestId(CHAT_THINKING_TOGGLE_TESTID));
    const withReasoning = copyButtons();
    expect(withReasoning).toHaveLength(4);
    expect(await pressAndRead(withReasoning[3])).toBe("print('think')\n");

    fireEvent.click(screen.getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID));
    const all = copyButtons();
    expect(all).toHaveLength(5);
    expect(await pressAndRead(all[4])).toBe('tool-output --flag\n');
  });

  it('pressing a block’s button opens or shuts no fold', async () => {
    render(<ChatMarkdownBody content={TURN} onFilePathClick={vi.fn()} />);
    const thinking = screen.getByTestId(CHAT_THINKING_TOGGLE_TESTID);
    const tools = screen.getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID);
    fireEvent.click(thinking);
    expect(thinking).toHaveAttribute('aria-expanded', 'true');
    expect(tools).toHaveAttribute('aria-expanded', 'false');

    for (const button of copyButtons()) await pressAndRead(button);
    expect(thinking).toHaveAttribute('aria-expanded', 'true');
    expect(tools).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the attributes react-markdown and search put on the <pre>, and leaks no `node`', () => {
    render(<ChatMarkdownBody content={'```js\nconst x = 1;\n```'} onFilePathClick={vi.fn()} />);
    const pre = document.querySelector('pre') as HTMLElement;
    expect(pre.parentElement?.matches(COPY_BLOCK)).toBe(true);
    expect(pre.hasAttribute('node')).toBe(false);
    expect(pre.hasAttribute('data-search-raw')).toBe(true);
    expect(pre.querySelector('code.language-js.hljs')).not.toBeNull();
    // The button sits beside the scrolling <pre>, never inside it.
    expect(pre.querySelector('button')).toBeNull();
  });
});

describe('[#3912] what gets no button', () => {
  const DIAGRAM = ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n');

  it.each(['rendered', 'error'] as const)('a fence drawn as a diagram (%s), its source unfolded too', (state) => {
    fake.state = state;
    render(<ChatMessageBubble message={message({ content: DIAGRAM })} showHeader onFilePathClick={vi.fn()} />);
    const frame = screen.getByTestId(MERMAID_BLOCK_TESTID);
    const fold = within(frame).getByTestId(MERMAID_SOURCE_TESTID) as HTMLDetailsElement;
    // An error leaves the source open already; a drawn diagram folds it.
    if (!fold.open) fireEvent.click(fold.querySelector('summary') as HTMLElement);
    expect(fold.open).toBe(true);
    expect(document.querySelector(COPY_BLOCK)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('a mermaid fence with diagrams off is code, and gets the button', async () => {
    render(<ChatMarkdownBody content={DIAGRAM} onFilePathClick={vi.fn()} />);
    expect(screen.queryByTestId(MERMAID_BLOCK_TESTID)).toBeNull();
    const [button, ...rest] = copyButtons();
    expect(rest).toHaveLength(0);
    expect(await pressAndRead(button)).toBe('graph TD\nA --> B\n');
  });

  it('inline code, a user’s body and a terminal scrape', () => {
    render(
      <>
        <ChatMarkdownBody content={'Use `ls -la` here.'} onFilePathClick={vi.fn()} />
        <ChatMessageBubble
          message={message({ id: 'u-1', role: 'user', content: '```\nuser fence\n```', requestId: undefined })}
          showHeader
          onFilePathClick={vi.fn()}
        />
        <ChatMessageBubble
          message={message({ id: 'p-1', content: '```\nscraped fence\n```', requestId: 'req_scrape' })}
          showHeader
          onFilePathClick={vi.fn()}
        />
      </>,
    );
    expect(screen.getByText('ls -la').closest(COPY_BLOCK)).toBeNull();
    expect(document.querySelector(COPY_BLOCK)).toBeNull();
  });

  it('History’s conversation card', () => {
    const pair: ConversationPair = {
      id: 'pair-3912',
      userMessage: USER,
      assistantMessages: [message({ content: '```js\nconst x = 1;\n```' })],
      status: 'completed',
    };
    render(<ConversationPairCard pair={pair} onFilePathClick={vi.fn()} isExpanded />);
    expect(document.querySelector('code.language-js')).not.toBeNull();
    expect(document.querySelector(COPY_BLOCK)).toBeNull();
  });
});

describe('[#3912] every path that draws an answer', () => {
  function transcript(messages: ChatMessage[], liveTurn?: ChatTranscriptLiveTurn) {
    return (
      <ChatTranscript
        messages={messages}
        worktreeId="wt-3912"
        cliToolId="opencode"
        liveTurn={liveTurn}
        onFilePathClick={vi.fn()}
      />
    );
  }
  const live = (body: string, extra: Partial<ChatTranscriptLiveTurn> = {}): ChatTranscriptLiveTurn => ({
    turnKey: MARKDOWN_ID,
    version: 1,
    body,
    partial: false,
    isThinking: false,
    ...extra,
  });

  let restoreLayout: () => void;
  beforeEach(() => {
    restoreLayout = installVirtualLayout();
  });
  afterEach(() => restoreLayout());

  it('the saved bubble', async () => {
    render(transcript([USER, message({ content: '```\nsaved\n```' })]));
    expect(await pressAndRead(copyButtons()[0])).toBe('saved\n');
  });

  it('the live bubble copies what it shows now, after more has been written', async () => {
    const { rerender } = render(transcript([USER], live('```sh\nstep one\n```')));
    const body = screen.getByTestId('chat-live-turn-body');
    expect(await pressAndRead(copyButtons(body)[0])).toBe('step one\n');

    rerender(transcript([USER], live('```sh\nstep one\nstep two\n```', { version: 2 })));
    expect(await pressAndRead(copyButtons(screen.getByTestId('chat-live-turn-body'))[0])).toBe(
      'step one\nstep two\n',
    );
  });

  it('a fence the live bubble has not closed yet is code up to the end of what is written', async () => {
    render(transcript([USER], live('Working:\n\n```sh\nhalf written\nmore')));
    const [button, ...rest] = copyButtons(screen.getByTestId('chat-live-turn-body'));
    expect(rest).toHaveLength(0);
    expect(await pressAndRead(button)).toBe('half written\nmore\n');
  });

  it('the settling bubble', async () => {
    render(transcript([USER], live('```\nsettling\n```', { settling: true })));
    const turn = screen.getByTestId('chat-live-turn');
    expect(turn).toHaveAttribute('data-settling', 'true');
    expect(await pressAndRead(copyButtons(turn)[0])).toBe('settling\n');
  });
});

describe('[#3912] the bubble’s own actions are unchanged', () => {
  it('copy the answer, copy all, and insert still hand over what they did', () => {
    const onCopy = vi.fn();
    const onInsert = vi.fn();
    render(
      <>
        <ChatMessageBubble message={message({ content: TURN })} showHeader onFilePathClick={vi.fn()} onCopy={onCopy} />
        <ChatMessageBubble
          message={message({ id: 'u-2', role: 'user', content: 'user text', requestId: undefined })}
          showHeader
          onFilePathClick={vi.fn()}
          onInsertToMessage={onInsert}
        />
      </>,
    );
    fireEvent.click(screen.getByTestId('chat-copy-message'));
    expect(onCopy).toHaveBeenLastCalledWith(PROSE);
    fireEvent.click(screen.getByTestId('chat-copy-full-message'));
    expect(onCopy).toHaveBeenLastCalledWith(TURN);
    fireEvent.click(screen.getByTestId('chat-insert-user-message'));
    expect(onInsert).toHaveBeenLastCalledWith('user text');
    expect(copyToClipboardMock).not.toHaveBeenCalled();
  });
});

describe('[#3912] the button stays out of search and selection', () => {
  it('marks the button, not the code’s wrapper or the code', () => {
    render(<ChatMarkdownBody content={'```\ncode\n```'} onFilePathClick={vi.fn()} />);
    const block = document.querySelector(COPY_BLOCK) as HTMLElement;
    const button = within(block).getByRole('button', { name: 'Copy' });
    expect(button).toHaveAttribute(SEARCH_SKIP_ATTR, 'true');
    expect(button).toHaveClass('select-none');
    expect(block.hasAttribute(SEARCH_SKIP_ATTR)).toBe(false);
    expect(block).not.toHaveClass('select-none');
    const pre = block.querySelector('pre') as HTMLElement;
    expect(pre.closest(`[${SEARCH_SKIP_ATTR}]`)).toBeNull();
    expect(pre.closest('.select-none')).toBeNull();
    // Shown at any width on a device without hover (globals.css).
    expect(button).toHaveClass('code-copy-button');
  });

  it('search’s text collection reads the code and never the caption, before, during and after "Copied"', async () => {
    vi.useFakeTimers();
    try {
      const { container } = render(
        <CodeBlockWithCopy>
          <pre>
            <code>npm test</code>
          </pre>
        </CodeBlockWithCopy>,
      );
      const read = () => collectTextNodes(container).map((entry) => entry.node.data).join('');
      expect(read()).toBe('npm test');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      });
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      expect(read()).toBe('npm test');
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
      expect(read()).toBe('npm test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('globals.css shows the button on hover-less devices and pads the <pre> for it', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.code-copy-button \{\s*opacity: 1;/);
    expect(css).toMatch(/\.code-block-with-copy > pre \{\s*padding-right: [\d.]+rem;/);
  });
});

// ============================================================================
// Search over a transcript holding code blocks
// ============================================================================

class FakeHighlight {
  readonly ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

describe('[#3912] search over code blocks', () => {
  let registry: Map<string, FakeHighlight>;
  let originalCSS: PropertyDescriptor | undefined;
  let originalHighlight: PropertyDescriptor | undefined;
  let originalRangeRect: PropertyDescriptor | undefined;
  let originalScroll: typeof Element.prototype.scrollIntoView;
  let restoreLayout: () => void;
  /** Ranges the current hit's overlay was measured from, in order. */
  let measured: Range[];

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

  function search(content: string, query: string): void {
    render(
      <ChatTranscript
        messages={[USER, message({ content })]}
        worktreeId="wt-3912"
        cliToolId="opencode"
        onFilePathClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), { target: { value: query } });
  }

  function count(): string | null {
    return screen.getByRole('search').querySelector('[role="status"]')?.textContent ?? null;
  }

  /** Every placed hit — the current one's overlay first, then the marked rest. */
  function placed(): Range[] {
    const current = measured[measured.length - 1];
    return [...(current ? [current] : []), ...(registry.get('chat-search')?.ranges ?? [])];
  }

  function where(range: Range): string {
    const node = range.startContainer;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    if (element?.closest('button')) return 'button';
    if (element?.closest('pre')) return `pre:${element.closest('pre')?.textContent}`;
    if (element?.closest('li')) return `li:${element.closest('li')?.textContent}`;
    return `p:${element?.closest('p')?.textContent}`;
  }

  it('negative: with no Copy in the message, "copy" finds nothing even with buttons on screen', async () => {
    search(['Before.', '', '```sh', 'npm test', '```', '', 'After.'].join('\n'), 'copy');
    expect(copyButtons()).toHaveLength(1);
    await waitFor(() => expect(count()).toBe('0/0'));
    expect(registry.get('chat-search')?.ranges ?? []).toHaveLength(0);
  });

  it('positive: Copy before, inside and after the code and in a list is counted and marked where it is', async () => {
    const content = [
      'Copy before the code.',
      '',
      '```sh',
      'cp a b # Copy inside',
      '```',
      '',
      '- Copy in a list',
      '',
      'Copy after the code.',
    ].join('\n');
    search(content, 'copy');
    await waitFor(() => {
      expect(count()).toBe('1/4');
      expect(placed().map((range) => range.toString())).toEqual(['Copy', 'Copy', 'Copy', 'Copy']);
      expect(placed().map(where)).toEqual([
        'p:Copy before the code.',
        'pre:cp a b # Copy inside\n',
        'li:Copy in a list',
        'p:Copy after the code.',
      ]);
    });
  });

  it('positive: the same sentence in the answer, the reasoning and the tool log', async () => {
    const content = separateTurnBody([
      { kind: 'prose', text: ['```', 'Copied here', '```'].join('\n') },
      { kind: 'reasoning', text: 'Copied here' },
      { kind: 'tool', text: '- Copied here' },
    ]).body;
    search(content, 'copied');
    await waitFor(() => {
      expect(count()).toBe('1/3');
      const ranges = placed();
      expect(ranges.map((range) => range.toString())).toEqual(['Copied', 'Copied', 'Copied']);
      expect(ranges.map(where)).toEqual(['pre:Copied here\n', 'p:Copied here', 'li:Copied here']);
    });
  });

  it('the marks stay on the code before pressing, while "Copied" shows and after it reverts', async () => {
    search(['```sh', 'Copy one', '```', '', '```sh', 'Copy two', '```'].join('\n'), 'copy');
    const expectOnCode = () =>
      waitFor(() => {
        expect(count()).toBe('1/2');
        const marked = registry.get('chat-search')?.ranges ?? [];
        expect(marked.map(where)).toEqual(['pre:Copy two\n']);
      });
    await expectOnCode();

    const [first] = copyButtons();
    await act(async () => {
      fireEvent.click(first);
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await expectOnCode();

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull(), { timeout: 3000 });
    await expectOnCode();
  });
});
