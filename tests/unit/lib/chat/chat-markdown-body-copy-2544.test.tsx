/**
 * The screen and the clipboard read one function (Issue #2544).
 *
 * ## What was wrong
 *
 * `ChatMarkdownBody` drew the answer and folded the reasoning and the tool log
 * into chips; the copy button beside it handed over `message.content` whole. Two
 * code paths decided what "the reply" was, and they disagreed.
 *
 * ## What this file pins
 *
 *  1. **one function.** `splitChatMarkdownBody` is replaced here by a spy, and
 *     a sentinel answer it returns has to appear BOTH on screen and on the
 *     clipboard. A bubble that composed the splitters by hand on either side
 *     would show the real answer on that side and fail;
 *  2. **the same Markdown.** With the real function, the body the bubble draws
 *     — chips taken out — is exactly what rendering the copied text draws, so
 *     the clipboard holds the source of what the reader is looking at;
 *  3. **no answer, no copy.** A row the function leaves blank offers no button;
 *  4. **one path for every surface.** The PC chat pane, the phone's chat tab and
 *     the `/sessions` tile all mount `ChatSurface`, which is the only thing that
 *     mounts `ChatTranscript`, which is the only thing that mounts
 *     `ChatMessageBubble` and wires its copy — so the behaviour above is the
 *     behaviour of all three. Read from the source, because rendering three
 *     whole surfaces to click one button would test their providers, not this.
 *
 * @vitest-environment jsdom
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatMarkdownBodySplit } from '@/lib/chat/chat-markdown-body';
import type { ChatMessage } from '@/types/models';

const spy = vi.hoisted(() => ({
  /** When set, what the spied `splitChatMarkdownBody` answers instead. */
  override: null as ((content: string) => ChatMarkdownBodySplit) | null,
}));

vi.mock('@/lib/chat/chat-markdown-body', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/chat-markdown-body')>();
  return {
    ...actual,
    splitChatMarkdownBody: vi.fn(
      (content: string) => spy.override?.(content) ?? actual.splitChatMarkdownBody(content),
    ),
  };
});

import {
  CHAT_THINKING_GROUP_TESTID,
  CHAT_TOOL_LOG_GROUP_TESTID,
  ChatMarkdownBody,
  ChatMessageBubble,
} from '@/components/worktree/ChatMessageBubble';
import { splitChatMarkdownBody } from '@/lib/chat/chat-markdown-body';
import {
  separateTurnBody,
  TURN_REASONING_LABEL,
  TURN_TOOL_LOG_LABEL,
} from '@/lib/hooks/sources/turn-body';
import { claudeTurnRequestId } from '@/types/agent-transcript';

const MESSAGE_ID = 'msg-2544';

/** A turn that answered with a list and a fence, thought, and called two tools. */
const TURN_BODY = separateTurnBody([
  { kind: 'prose', text: 'Created `probe.txt`:\n\n- one line\n- no trailing newline' },
  { kind: 'prose', text: '```sh\ncat probe.txt\n```' },
  { kind: 'reasoning', text: 'The write succeeded; now check the content.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
]).body;

function message(content: string): ChatMessage {
  return {
    id: MESSAGE_ID,
    worktreeId: 'wt-2544',
    role: 'assistant',
    content,
    timestamp: new Date(Date.UTC(2026, 8, 13, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    requestId: claudeTurnRequestId('u-2544'),
  };
}

function renderBubble(content: string) {
  const onCopy = vi.fn();
  render(
    <ChatMessageBubble message={message(content)} showHeader onFilePathClick={vi.fn()} onCopy={onCopy} />,
  );
  return onCopy;
}

/** The bubble's rendered body element, chips included. */
function bodyOf(): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-message-id="${MESSAGE_ID}"]`);
  expect(node).not.toBeNull();
  return node!;
}

afterEach(() => {
  spy.override = null;
  vi.mocked(splitChatMarkdownBody).mockClear();
});

// ---------------------------------------------------------------------------
// 1. One function
// ---------------------------------------------------------------------------

describe('[#2544] the bubble draws and copies from splitChatMarkdownBody', () => {
  it('shows and copies whatever that function answers', () => {
    // Positive control: the row really carries the folded sections, so the
    // sentinel below is not agreeing with a body that had nothing to split.
    expect(TURN_BODY).toContain(`> **${TURN_REASONING_LABEL} (1)**`);
    expect(TURN_BODY).toContain(`> **${TURN_TOOL_LOG_LABEL} (2)**`);

    spy.override = () => ({
      body: 'SENTINEL-2544 answer',
      reasoning: null,
      reasoningBlocks: 0,
      toolLog: '',
      toolCalls: 0,
      folded: true,
    });
    const onCopy = renderBubble(TURN_BODY);

    // The screen: the sentinel, and not the real answer.
    expect(bodyOf().textContent).toContain('SENTINEL-2544 answer');
    expect(bodyOf().textContent).not.toContain('Created');
    // The clipboard: the same sentinel.
    fireEvent.click(screen.getByTestId('chat-copy-message'));
    expect(onCopy).toHaveBeenCalledWith('SENTINEL-2544 answer');
    // Both sides asked about the stored row, not about some copy of it.
    for (const [content] of vi.mocked(splitChatMarkdownBody).mock.calls) {
      expect(content).toBe(TURN_BODY);
    }
  });

  it('offers no copy when that function answers a blank body', () => {
    spy.override = () => ({
      body: '',
      reasoning: null,
      reasoningBlocks: 0,
      toolLog: '- `Bash` — ls',
      toolCalls: 1,
      folded: true,
    });
    renderBubble(TURN_BODY);

    expect(screen.getByTestId(CHAT_TOOL_LOG_GROUP_TESTID)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-copy-message')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The same Markdown
// ---------------------------------------------------------------------------

describe('[#2544] the clipboard holds the source of what is drawn', () => {
  it('draws exactly the copied Markdown above the chips', () => {
    const onCopy = renderBubble(TURN_BODY);
    fireEvent.click(screen.getByTestId('chat-copy-message'));
    const copied = onCopy.mock.calls[0][0] as string;

    expect(copied).toBe(
      'Created `probe.txt`:\n\n- one line\n- no trailing newline\n\n```sh\ncat probe.txt\n```',
    );
    expect(copied).not.toContain(`> **${TURN_REASONING_LABEL}`);
    expect(copied).not.toContain(`> **${TURN_TOOL_LOG_LABEL}`);

    // The bubble's body with its chips taken out...
    const drawn = bodyOf().cloneNode(true) as HTMLElement;
    expect(drawn.querySelector(`[data-testid="${CHAT_THINKING_GROUP_TESTID}"]`)).not.toBeNull();
    expect(drawn.querySelector(`[data-testid="${CHAT_TOOL_LOG_GROUP_TESTID}"]`)).not.toBeNull();
    drawn
      .querySelectorAll(
        `[data-testid="${CHAT_THINKING_GROUP_TESTID}"], [data-testid="${CHAT_TOOL_LOG_GROUP_TESTID}"]`,
      )
      .forEach((chip) => chip.remove());

    // ...is the copied text, rendered by the same renderer.
    const { container } = render(<ChatMarkdownBody content={copied} onFilePathClick={vi.fn()} />);
    expect(container.querySelector('[data-testid]')).toBeNull();
    expect(drawn.innerHTML).toBe(container.innerHTML);
  });
});

// ---------------------------------------------------------------------------
// 3. One path for every surface
// ---------------------------------------------------------------------------

describe('[#2544] PC, phone and /sessions share the one copy path', () => {
  const root = process.cwd();
  const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf-8');

  function sourcesUnder(dir: string): string[] {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourcesUnder(rel);
      return /\.tsx?$/.test(entry.name) ? [rel] : [];
    });
  }

  it.each([
    ['the PC chat pane', 'src/components/worktree/TerminalSplitPaneContent.tsx'],
    ['the phone chat tab', 'src/components/worktree/MobileTerminalTab.tsx'],
    ['the /sessions tile', 'src/components/sessions/SessionTile.tsx'],
  ])('%s mounts ChatSurface', (_surface, file) => {
    expect(read(file)).toMatch(/<ChatSurface\b/);
  });

  it('mounts ChatTranscript from ChatSurface and ChatMessageBubble from ChatTranscript only', () => {
    const sources = sourcesUnder('src');
    const mounting = (tag: string): string[] =>
      sources.filter((file) => new RegExp(`<${tag}\\b`).test(read(file)));

    expect(mounting('ChatTranscript')).toEqual(['src/components/worktree/ChatSurface.tsx']);
    expect(mounting('ChatMessageBubble')).toEqual(['src/components/worktree/ChatTranscript.tsx']);
  });

  it('hands the bubble a copy handler that puts its argument on the clipboard unchanged', () => {
    const transcript = read('src/components/worktree/ChatTranscript.tsx');
    expect(transcript).toMatch(/<ChatMessageBubble[\s\S]*?onCopy=\{handleCopy\}/);
    expect(transcript).toMatch(
      /const handleCopy = useCallback\(\s*async \(content: string\) => \{\s*try \{\s*await copyToClipboard\(content\);/,
    );
  });
});
