/**
 * The three Markdown surfaces share one remark list (Issue #2459).
 *
 * `src/lib/markdown` holds the repair and
 * `tests/unit/lib/markdown/japanese-url-boundary-2459.test.ts` holds its rules.
 * What is asserted here is the wiring: that a body carrying the Issue's
 * `**https://example.com/issue/2454**（注記）` comes out as `strong > a` on
 * every screen that draws agent-authored Markdown, and not only on the one
 * where the defect was first noticed.
 *
 * Four renders, because Chat is three of them. `ChatMarkdownBody` splits a turn
 * into the answer, the `Thinking` chip (#2272) and the `Tool calls` chip
 * (#2284) and hands each to its own `<ReactMarkdown>`; a plugin list threaded
 * into the first and forgotten on the other two would leave the repair working
 * in the bubble and broken the moment a reader opens a chip. Both chips are
 * opened here for that reason.
 *
 * Every case pairs its assertion with a positive control on the SOURCE string —
 * the fixture really does hold the broken shape — so no assertion can pass
 * because the input never had the defect.
 *
 * jsdom performs no layout, so `ChatTranscript`'s #1123 fallback list is what
 * renders, as in every other transcript suite.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import {
  CHAT_THINKING_BODY_TESTID,
  CHAT_THINKING_TOGGLE_TESTID,
  CHAT_TOOL_LOG_BODY_TESTID,
  CHAT_TOOL_LOG_TOGGLE_TESTID,
  ChatMessageBubble,
} from '@/components/worktree/ChatMessageBubble';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { MarkdownPreview } from '@/components/worktree/MarkdownPreview';
import { TURN_REASONING_LABEL, TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import type { ConversationPair } from '@/types/conversation';
import type { ChatMessage } from '@/types/models';

// The diagram renderer pulls in mermaid; the Markdown pipeline under test does
// not need it. Same stub `MarkdownPreview`'s own suite uses.
vi.mock('@/components/worktree/MermaidCodeBlock', () => ({
  MermaidCodeBlock: ({ children }: { children?: React.ReactNode }) => (
    <pre data-testid="mermaid-block">{children}</pre>
  ),
}));

/** The URL the Issue reports. */
const U = 'https://example.com/issue/2454';
/** The line as it was written, verbatim. */
const REPORTED = `**${U}**（注記）`;
/** `（注記）` percent-encoded — what the broken `href` used to carry. */
const ENCODED_NOTE = '%EF%BC%88%E6%B3%A8%E8%A8%98%EF%BC%89';

const MARKDOWN_ID = opencodeTurnRequestId('msg_2459');

/**
 * One turn in the shape `separateTurnBody` writes: prose, then the reasoning
 * section, then the tool log. The reported line appears in all three, so each
 * of Chat's three renders is asked the same question.
 */
const TURN = [
  `再現手順は ${REPORTED} を参照。`,
  '',
  `> **${TURN_REASONING_LABEL} (1)**`,
  '>',
  `> 参照した issue は ${REPORTED}`,
  '',
  `> **${TURN_TOOL_LOG_LABEL} (1)**`,
  '>',
  `> - \`WebFetch\` — ${REPORTED}`,
].join('\n');

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-2459',
    worktreeId: 'wt-2459',
    role: 'assistant',
    content: TURN,
    timestamp: new Date(Date.UTC(2026, 8, 11, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    // #2041's distinction: only a row carrying a requestId is parsed as Markdown.
    requestId: MARKDOWN_ID,
    ...overrides,
  };
}

/**
 * The repaired shape, asserted on whatever element the surface put it in:
 * every anchor points at the URL alone, sits inside a `<strong>`, and the note
 * is text beside it rather than percent-encoded into the destination.
 */
function expectRepaired(scope: HTMLElement): void {
  const anchors = Array.from(scope.querySelectorAll('a'));
  expect(anchors.length).toBeGreaterThan(0);

  for (const anchor of anchors) {
    expect(anchor.getAttribute('href')).toBe(U);
    expect(anchor.textContent).toBe(U);
    // The bold closed: the link is inside the emphasis, not beside a raw `**`.
    expect(anchor.closest('strong')).not.toBeNull();
  }

  const text = scope.textContent ?? '';
  expect(text).toContain('（注記）');
  expect(text).not.toContain('**');
  expect(scope.innerHTML).not.toContain(ENCODED_NOTE);
}

describe('[#2459] the shared remark list on every Markdown surface', () => {
  it('the fixture really carries the broken line (positive control)', () => {
    expect(TURN).toContain(`**${U}**（注記）`);
    expect(TURN.split(`**${U}**（注記）`)).toHaveLength(4);
  });

  it('expectRepaired rejects the unrepaired render (mutation injection)', () => {
    // The control for every assertion in this file: the same reported line
    // through the same pipeline with #2459's plugin taken back out. If
    // `expectRepaired` passed here, it would be proving nothing about the four
    // surfaces below.
    const { container } = render(
      React.createElement(ReactMarkdown as never, {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeSanitize, rehypeHighlight],
        children: `再現手順は ${REPORTED} を参照。`,
      } as never),
    );
    const paragraph = container.querySelector('p') as HTMLElement;
    expect(paragraph.querySelector('a')).not.toBeNull();
    expect(() => expectRepaired(paragraph)).toThrow();
  });

  // -------------------------------------------------------------------------
  // 1-3. Chat: the answer and both chips
  // -------------------------------------------------------------------------

  describe('the chat bubble', () => {
    function renderBubble() {
      return render(
        <ChatMessageBubble message={message()} showHeader onFilePathClick={vi.fn()} />,
      );
    }

    function bodyOf(): HTMLElement {
      const node = document.querySelector('[data-message-id="msg-2459"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    }

    it('repairs the answer', () => {
      renderBubble();
      const paragraph = bodyOf().querySelector('p');
      expect(paragraph).not.toBeNull();
      expectRepaired(paragraph as HTMLElement);
      expect(paragraph?.textContent).toContain('再現手順は');
    });

    it('repairs the reasoning chip, which is a second ReactMarkdown', () => {
      renderBubble();
      // Shut, the chip's Markdown is an element and never reaches the DOM.
      expect(screen.queryByTestId(CHAT_THINKING_BODY_TESTID)).toBeNull();

      fireEvent.click(screen.getByTestId(CHAT_THINKING_TOGGLE_TESTID));
      const opened = screen.getByTestId(CHAT_THINKING_BODY_TESTID);
      expect(opened.textContent).toContain('参照した issue は');
      expectRepaired(opened);
    });

    it('repairs the tool log chip, which is a third ReactMarkdown', () => {
      renderBubble();
      fireEvent.click(screen.getByTestId(CHAT_TOOL_LOG_TOGGLE_TESTID));
      const opened = screen.getByTestId(CHAT_TOOL_LOG_BODY_TESTID);
      expect(opened.textContent).toContain('WebFetch');
      expectRepaired(opened);
    });
  });

  // -------------------------------------------------------------------------
  // 4. History
  // -------------------------------------------------------------------------

  describe('the History card', () => {
    function pair(): ConversationPair {
      return {
        id: 'pair-2459',
        userMessage: message({
          id: 'user-2459',
          role: 'user',
          content: 'issue を見て',
          requestId: undefined,
        }),
        assistantMessages: [message()],
        status: 'completed',
      };
    }

    it('repairs the same body the bubble does', () => {
      const { container } = render(
        <ConversationPairCard pair={pair()} onFilePathClick={vi.fn()} isExpanded />,
      );
      const paragraph = container.querySelector('p a')?.closest('p');
      expect(paragraph).not.toBeNull();
      expectRepaired(paragraph as HTMLElement);
    });
  });

  // -------------------------------------------------------------------------
  // 5. The file preview
  // -------------------------------------------------------------------------

  describe('the Markdown file preview', () => {
    it('repairs a file a human wrote, keeping its own link handling', () => {
      const onOpenFile = vi.fn();
      const { container } = render(
        <MarkdownPreview
          content={`再現手順は ${REPORTED} を参照。`}
          onOpenFile={onOpenFile}
          currentFilePath="docs/index.md"
        />,
      );

      const paragraph = container.querySelector('p');
      expect(paragraph).not.toBeNull();
      expectRepaired(paragraph as HTMLElement);
    });

    it('still renders a heading, a fence and an explicit link unchanged', () => {
      // The remark half changed; nothing else about this component did.
      const { container } = render(
        <MarkdownPreview
          content={['# 見出し', '', '```js', 'const a = 1;', '```', '', '[label](./readme.md)'].join('\n')}
          onOpenFile={vi.fn()}
          currentFilePath="docs/index.md"
        />,
      );

      expect(container.querySelector('h1')?.textContent).toBe('見出し');
      expect(container.querySelector('pre')?.textContent).toContain('const a = 1;');
      expect(container.querySelector('a')?.getAttribute('href')).toBe('./readme.md');
    });
  });
});
