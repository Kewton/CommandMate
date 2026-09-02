/**
 * ChatTranscript — the chat surface's own transcript (Issue #2232).
 *
 * The Epic decided the chat surface would just BE `HistoryPane` and that no
 * second transcript would be written; #2232 withdrew both decisions after the
 * shipped screen turned out to be "the terminal hidden and History widened".
 * What that leaves behind is a set of properties whose regression would put the
 * screen straight back:
 *
 *  1. **Two columns.** A user bubble is pushed right and an assistant bubble
 *     left, and both are width-capped. Delete either the cap or the push and the
 *     surface is two stacked full-width paragraphs again — which is a log, not a
 *     conversation, whatever color it is painted. Issue #2232 asks for exactly
 *     this mutation to be caught, so the classes are asserted BY VALUE.
 *  2. **No clamp.** `ConversationPairCard` shows 100 characters of a collapsed
 *     reply; measured on this repository, that hid ~96% of the assistant rows
 *     (median 2,478 characters). A reply is rendered whole here, with no expand
 *     toggle to find and no "..." to notice.
 *  3. **One size.** History renders assistant bodies at `text-xs` and user
 *     bodies at `text-sm`, which makes the ANSWER read as metadata about the
 *     question. Both are `text-sm` here.
 *  4. **Markdown only where the row says so.** #2041's distinction is unchanged:
 *     an agent-authored row is parsed as Markdown, a terminal scrape is not —
 *     rendering a scrape as Markdown turns a `┌──┐` box into a table.
 *  5. **Turn-level labels.** Consecutive rows from the same role are one answer
 *     that happened to be saved twice; stamping a header on each makes the
 *     surface look like a log again.
 *  6. **One empty state and one loading state.** There were two of each before
 *     (`HistoryPane`'s and `ChatSurface`'s).
 *
 * jsdom performs no layout, so the virtualizer materializes zero rows and the
 * #1123 fallback list is what is under test in this file. The virtualized branch
 * is exercised separately in `ChatTranscript-virtualization-2232.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { readFileSync } from 'fs';
import path from 'path';
import type { ChatMessage } from '@/types/models';
import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import {
  CHAT_BUBBLE_ALIGN_ASSISTANT,
  CHAT_BUBBLE_ALIGN_USER,
  CHAT_BUBBLE_MAX_WIDTH_ASSISTANT,
  CHAT_BUBBLE_MAX_WIDTH_USER,
} from '@/components/worktree/ChatMessageBubble';

const WORKTREE_ID = 'wt-2232';
const T0 = Date.UTC(2026, 8, 2, 10, 0, 0);

function msg(
  id: string,
  role: ChatMessage['role'],
  content = `content ${id}`,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date(T0),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

function renderTranscript(messages: ChatMessage[], props: Record<string, unknown> = {}) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      onFilePathClick={vi.fn()}
      {...props}
    />,
  );
}

/** The bubble element of a row (the box carrying the width cap and the tint). */
function bubbleOf(row: HTMLElement): HTMLElement {
  const body = row.querySelector('[data-message-id]');
  expect(body, 'row has a message body').not.toBeNull();
  const bubble = body!.parentElement;
  expect(bubble, 'body has a bubble parent').not.toBeNull();
  return bubble as HTMLElement;
}

function rowFor(messageId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-row-message-id="${messageId}"]`);
  expect(row, `row for ${messageId}`).not.toBeNull();
  return row!;
}

// ---------------------------------------------------------------------------
// 1. Two columns
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript bubble geometry', () => {
  it('pushes the user bubble right and caps its width', () => {
    renderTranscript([msg('u1', 'user')]);
    const bubble = bubbleOf(rowFor('u1'));

    // Both the rendered class and the exported constant, by literal value: a
    // test that only compares the DOM against the constant it came from stays
    // green when the constant itself is emptied or flipped.
    expect(bubble.className).toContain('ml-auto');
    expect(bubble.className).toContain('max-w-[85%]');
    expect(bubble.className).toContain('sm:max-w-[75%]');
    expect(CHAT_BUBBLE_ALIGN_USER).toBe('ml-auto');
    expect(CHAT_BUBBLE_MAX_WIDTH_USER).toBe('max-w-[85%] sm:max-w-[75%]');
  });

  it('keeps the assistant bubble left and caps it wider', () => {
    renderTranscript([msg('a1', 'assistant')]);
    const bubble = bubbleOf(rowFor('a1'));

    expect(bubble.className).toContain('mr-auto');
    expect(bubble.className).toContain('max-w-[92%]');
    expect(CHAT_BUBBLE_ALIGN_ASSISTANT).toBe('mr-auto');
    expect(CHAT_BUBBLE_MAX_WIDTH_ASSISTANT).toBe('max-w-[92%]');
  });

  it('never gives the two roles the same side', () => {
    renderTranscript([msg('u1', 'user'), msg('a1', 'assistant')]);
    const user = bubbleOf(rowFor('u1')).className;
    const assistant = bubbleOf(rowFor('a1')).className;

    expect(user).toContain('ml-auto');
    expect(user).not.toContain('mr-auto');
    expect(assistant).toContain('mr-auto');
    expect(assistant).not.toContain('ml-auto');
  });

  it('publishes the role on the row so the split is inspectable', () => {
    renderTranscript([msg('u1', 'user'), msg('a1', 'assistant')]);
    expect(rowFor('u1').getAttribute('data-role')).toBe('user');
    expect(rowFor('a1').getAttribute('data-role')).toBe('assistant');
  });
});

// ---------------------------------------------------------------------------
// 2. + 3. No clamp, one size
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript renders replies in full', () => {
  // Comfortably past ConversationPairCard's COLLAPSED_MAX_CHARS (100) and
  // COLLAPSED_MAX_LINES (2) — the two numbers that hid 25 of this repository's
  // last 26 assistant rows.
  const LONG = Array.from({ length: 40 }, (_, i) => `line ${i} of a long reply`).join('\n');

  it('puts the whole assistant body in the DOM', () => {
    renderTranscript([msg('a1', 'assistant', LONG)]);
    const body = rowFor('a1').querySelector('[data-message-id="a1"]');

    expect(body?.textContent).toBe(LONG);
    expect(body?.textContent?.length).toBeGreaterThan(100);
  });

  it('offers no expand toggle and prints no truncation ellipsis', () => {
    renderTranscript([msg('a1', 'assistant', LONG)]);
    const row = rowFor('a1');

    expect(within(row).queryByLabelText('worktree.conversation.expandMessage')).toBeNull();
    expect(within(row).queryByLabelText('worktree.conversation.collapseMessage')).toBeNull();
    expect(row.textContent).not.toContain('...');
  });

  it('clamps the rendered height of nothing', () => {
    // `COLLAPSED_MARKDOWN_MAX_HEIGHT` is how History collapses a Markdown reply
    // without cutting the string mid-token. Neither mechanism exists here.
    renderTranscript([msg('a1', 'assistant', LONG)]);
    expect(rowFor('a1').innerHTML).not.toContain('max-h-[');
  });

  it('renders both roles at the same size', () => {
    renderTranscript([msg('u1', 'user'), msg('a1', 'assistant')]);
    expect(bubbleOf(rowFor('u1')).className).toContain('text-sm');
    expect(bubbleOf(rowFor('a1')).className).toContain('text-sm');
    expect(bubbleOf(rowFor('a1')).className).not.toContain('text-xs');
  });

  it('keeps a terminal scrape’s own line breaks', () => {
    renderTranscript([msg('a1', 'assistant', 'first\n  indented')]);
    const body = rowFor('a1').querySelector('[data-message-id="a1"]');
    expect(body?.className).toContain('whitespace-pre-wrap');
  });
});

// ---------------------------------------------------------------------------
// 4. Markdown only where the row says so
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript body rendering', () => {
  it('parses an agent-authored row as Markdown', () => {
    renderTranscript([
      msg('a1', 'assistant', '# Heading\n\n- one\n- two', { requestId: 'oc-turn:msg_1' }),
    ]);
    const body = rowFor('a1').querySelector('[data-message-id="a1"]') as HTMLElement;

    expect(body.getAttribute('data-markdown')).toBe('true');
    expect(body.className).toContain('chat-md');
    expect(body.querySelector('h1')?.textContent).toBe('Heading');
    expect(body.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders a terminal scrape verbatim, headings and all', () => {
    // A `# ` in a captured shell prompt is not a heading, and a `┌──┐` box is
    // not a table. #2041's distinction is what keeps that true.
    renderTranscript([msg('a1', 'assistant', '# not a heading\n┌──┐')]);
    const body = rowFor('a1').querySelector('[data-message-id="a1"]') as HTMLElement;

    expect(body.getAttribute('data-markdown')).toBeNull();
    expect(body.className).not.toContain('chat-md');
    expect(body.querySelector('h1')).toBeNull();
    expect(body.textContent).toContain('# not a heading');
  });

  it('styles Markdown through .chat-md, never the shared .assistant-md', () => {
    // `.assistant-md` is History's and `/chat`'s. Reusing it would have made
    // every rule this Issue adds land on two surfaces it must not touch.
    renderTranscript([msg('a1', 'assistant', '**bold**', { requestId: 'claude-turn:u-1' })]);
    expect(document.body.innerHTML).not.toContain('assistant-md');
  });
});

// ---------------------------------------------------------------------------
// 5. Turn-level labels
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript role headers', () => {
  it('labels the first message of each role run', () => {
    renderTranscript([msg('u1', 'user'), msg('a1', 'assistant')]);

    expect(within(rowFor('u1')).getByText('worktree.conversation.you')).toBeInTheDocument();
    expect(within(rowFor('a1')).getByText('worktree.conversation.assistant')).toBeInTheDocument();
  });

  it('omits the header on a message that continues the role above it', () => {
    renderTranscript([msg('a1', 'assistant'), msg('a2', 'assistant')]);

    expect(within(rowFor('a1')).getByText('worktree.conversation.assistant')).toBeInTheDocument();
    expect(within(rowFor('a2')).queryByText('worktree.conversation.assistant')).toBeNull();
  });

  it('brings the header back when the role changes again', () => {
    renderTranscript([
      msg('a1', 'assistant'),
      msg('a2', 'assistant'),
      msg('u1', 'user'),
      msg('a3', 'assistant'),
    ]);

    expect(within(rowFor('u1')).getByText('worktree.conversation.you')).toBeInTheDocument();
    expect(within(rowFor('a3')).getByText('worktree.conversation.assistant')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. One empty state, one loading state
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript empty and loading states', () => {
  it('shows exactly one empty state', () => {
    renderTranscript([]);
    expect(screen.getAllByTestId('chat-transcript-empty')).toHaveLength(1);
    expect(screen.getByText('worktree.chatTranscript.empty')).toBeInTheDocument();
    expect(screen.getByText('worktree.chatTranscript.emptyHint')).toBeInTheDocument();
  });

  it('shows exactly one loading state, and no empty state beside it', () => {
    renderTranscript([], { isLoading: true });
    expect(screen.getAllByTestId('chat-transcript-loading')).toHaveLength(1);
    expect(screen.queryByTestId('chat-transcript-empty')).toBeNull();
  });

  it('shows neither once there are messages', () => {
    renderTranscript([msg('u1', 'user')]);
    expect(screen.queryByTestId('chat-transcript-empty')).toBeNull();
    expect(screen.queryByTestId('chat-transcript-loading')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Layout invariants the phone depends on
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript layout', () => {
  it('keeps `min-h-0` on the column and on the scroll region', () => {
    // Issue #2106 / the MobileTerminalTab comment: a flex child without
    // `min-h-0` refuses to shrink below its content, which is how a transcript
    // ends up painting over the controls beneath it.
    renderTranscript([msg('u1', 'user')]);
    const root = screen.getByTestId('chat-transcript');
    const scroll = screen.getByTestId('chat-transcript-scroll-container');

    expect(root.className).toContain('min-h-0');
    expect(root.className).toContain('overflow-hidden');
    expect(scroll.className).toContain('min-h-0');
    expect(scroll.className).toContain('overflow-y-auto');
  });

  it('spends no layout height on chrome', () => {
    // The search affordance floats. On the phone every pixel of chrome comes
    // out of the transcript's own budget (Issue #2106).
    renderTranscript([msg('u1', 'user')]);
    const toggle = screen.getByTestId('chat-transcript-search-toggle');
    expect(toggle.closest('.absolute')).not.toBeNull();
  });

  it('renders none of the History browser chrome', () => {
    renderTranscript([msg('u1', 'user')], {
      isLoading: false,
    });
    expect(screen.queryByText('worktree.history.title')).toBeNull();
    expect(screen.queryByLabelText('worktree.history.displayLimit')).toBeNull();
    expect(screen.queryByLabelText('worktree.history.showUserOnly')).toBeNull();
    expect(screen.queryByText('worktree.history.showArchived')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The discipline the second implementation is paid for with
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript leaves the History assets alone', () => {
  const read = (relative: string) =>
    readFileSync(path.join(process.cwd(), relative), 'utf8');

  /**
   * Source with comments removed.
   *
   * Both files NAME `.assistant-md` in prose, to record why they do not use it —
   * a guard that cannot tell an explanation from a usage would push the
   * explanation out of the code, which is the opposite of what it is for.
   */
  const code = (relative: string) =>
    read(relative)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  const CHAT_SOURCES = [
    'src/components/worktree/ChatTranscript.tsx',
    'src/components/worktree/ChatMessageBubble.tsx',
  ];

  it('imports neither History component', () => {
    // Not a style preference: importing them back is exactly how the "chat is
    // History with the terminal hidden" screen returns, and it is the change a
    // future reader is most likely to make while "removing duplication".
    for (const file of CHAT_SOURCES) {
      const source = code(file);
      expect(source, file).not.toMatch(/from '\.\/HistoryPane'/);
      expect(source, file).not.toMatch(/from '\.\/ConversationPairCard'/);
    }
  });

  it('groups nothing into conversation pairs', () => {
    for (const file of CHAT_SOURCES) {
      const source = code(file);
      expect(source, file).not.toContain('groupMessagesIntoPairs');
      expect(source, file).not.toContain('useConversationHistory');
    }
  });

  it('writes its Markdown styling into its own namespace', () => {
    // `.assistant-md` is shared with History's cards and `/chat`'s
    // `AssistantMessageList`; a rule added there lands on two surfaces this
    // Issue is required not to touch.
    for (const file of CHAT_SOURCES) {
      expect(code(file), file).not.toContain('assistant-md');
    }
    const css = read('src/app/globals.css');
    expect(css).toContain('.chat-md pre');
    expect(css).toContain('.chat-md code');
  });

  it('keeps the always-dark exception to fenced code blocks only', () => {
    // docs/design-system.md §"常時ダーク領域": a code block may stay dark in both
    // themes because it carries github-dark syntax tokens. A bubble may not.
    const css = read('src/app/globals.css');
    const chatMdRules = css
      .split('\n')
      .filter((line) => line.trim().startsWith('.chat-md') || line.trim().startsWith('.dark .chat-md'));
    const darkGrounds = chatMdRules.filter((line) => line.includes('#0d1117'));
    expect(darkGrounds).toHaveLength(0); // the value sits inside `.chat-md pre`'s body
    expect(css).toMatch(/\.chat-md pre \{[^}]*background-color: #0d1117;/);

    for (const file of CHAT_SOURCES) {
      const source = code(file);
      expect(source, file).not.toContain('bg-terminal-surface');
      expect(source, file).not.toContain('text-terminal-foreground');
      expect(source, file).not.toContain('#0d1117');
    }
  });
});
