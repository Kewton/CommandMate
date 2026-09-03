/**
 * The chat bubble opens with the answer, not with the deliberation
 * (Issue #2272).
 *
 * ## What was on screen
 *
 * Measured against opencode 1.18.22, a `reasoning` part arrives in front of
 * every text part, so `renderOpencodeTurn` wrote a `> **Thinking**` quote in
 * front of every paragraph: one on a single-line answer, four on a long one.
 * `ChatMarkdownBody` draws a blockquote as a blockquote, so the bubble opened
 * with the agent thinking about the reply and buried the reply itself.
 *
 * ## Two shapes, one chip
 *
 * `separateTurnBody` now folds the run into ONE trailing `> **Thinking (N)**`
 * section, which fixes rows written from now on. It cannot fix the rows already
 * saved — the writers match on `request_id` and stand down rather than rewriting
 * — so `splitChatThinking` reads BOTH shapes and both become the same chip. The
 * legacy half is not a nicety: every opencode row in every existing database has
 * it.
 *
 * ## Non-vacuity
 *
 * Each rendering assertion is paired with a positive control on the SOURCE
 * string — "the stored body really does open with the quote" — so a test cannot
 * pass because the fixture never had the defect. That is the mutation the Issue
 * asks for: take the split out and the first thing in the bubble is the quote
 * again, which these assertions catch.
 *
 * jsdom performs no layout, so `ChatTranscript`'s #1123 fallback list is what
 * renders here — the same branch every other transcript test exercises.
 *
 * @vitest-environment jsdom
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ChatMessageBubble } from '@/components/worktree/ChatMessageBubble';
import {
  CHAT_THINKING_BODY_TESTID,
  CHAT_THINKING_GROUP_TESTID,
  CHAT_THINKING_LABEL,
  CHAT_THINKING_TOGGLE_TESTID,
  splitChatThinking,
} from '@/components/worktree/ChatMessageBubble';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { TURN_REASONING_LABEL, TURN_TOOL_LOG_LABEL } from '@/lib/hooks/sources/turn-body';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import type { ConversationPair } from '@/types/conversation';
import type { ChatMessage } from '@/types/models';

const MARKDOWN_ID = opencodeTurnRequestId('msg_user2272');

/** The body `separateTurnBody` writes for the Issue's own example turn. */
const NEW_SHAPE = [
  'カレントディレクトリに `probe.txt` を作成し、`hello` の1行を書き込みました。',
  '',
  `> **${TURN_REASONING_LABEL} (2)**`,
  '>',
  '> **Preparing for patch application**',
  '>',
  '> I think I need to edit the patch application process.',
  '>',
  '> The write succeeded. Now check the content.',
  '',
  `> **${TURN_TOOL_LOG_LABEL} (1)**`,
  '>',
  '> - `apply_patch` — probe.txt',
].join('\n');

/** The body every opencode row saved before #2272 still holds. */
const LEGACY_SHAPE = [
  `> **${TURN_REASONING_LABEL}**`,
  '>',
  '> **Preparing for patch application**',
  '>',
  '> I think I need to edit the patch application process.',
  '',
  'カレントディレクトリに `probe.txt` を作成し、`hello` の1行を書き込みました。',
  '',
  `> **${TURN_REASONING_LABEL}**`,
  '>',
  '> The write succeeded. Now check the content.',
  '',
  `> **${TURN_TOOL_LOG_LABEL} (1)**`,
  '>',
  '> - `apply_patch` — probe.txt',
].join('\n');

const ANSWER = 'カレントディレクトリに';

function message(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    worktreeId: 'wt-2272',
    role: 'assistant',
    content,
    timestamp: new Date(Date.UTC(2026, 8, 3, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'opencode',
    requestId: MARKDOWN_ID,
    ...overrides,
  };
}

function renderBubble(content: string, overrides: Partial<ChatMessage> = {}) {
  return render(
    <ChatMessageBubble
      message={message(content, overrides)}
      showHeader
      onFilePathClick={vi.fn()}
    />,
  );
}

/** The bubble's rendered body element, chip included. */
function bodyOf(): HTMLElement {
  const node = document.querySelector('[data-message-id="msg-1"]');
  expect(node).not.toBeNull();
  return node as HTMLElement;
}

// ---------------------------------------------------------------------------
// 1. The reader: splitChatThinking
// ---------------------------------------------------------------------------

describe('[#2272] splitChatThinking', () => {
  it('agrees with the label the writers bake into the row', () => {
    // The one seam between a server-side reader and a client bundle. They are
    // two constants because they live in two bundles; they must be one string.
    expect(CHAT_THINKING_LABEL).toBe(TURN_REASONING_LABEL);
  });

  it('lifts the trailing `Thinking (N)` section out and keeps its count', () => {
    // Positive control first: the stored body really does carry the section.
    expect(NEW_SHAPE).toContain(`> **${TURN_REASONING_LABEL} (2)**`);

    const split = splitChatThinking(NEW_SHAPE);
    expect(split.blocks).toBe(2);
    expect(split.body).toBe(
      [
        'カレントディレクトリに `probe.txt` を作成し、`hello` の1行を書き込みました。',
        '',
        `> **${TURN_TOOL_LOG_LABEL} (1)**`,
        '>',
        '> - `apply_patch` — probe.txt',
      ].join('\n'),
    );
    expect(split.reasoning).toBe(
      [
        '**Preparing for patch application**',
        '',
        'I think I need to edit the patch application process.',
        '',
        'The write succeeded. Now check the content.',
      ].join('\n'),
    );
  });

  it('lifts every legacy `Thinking` quote out, wherever in the body it sat', () => {
    // Positive control: the legacy body OPENS with the quote — that is the
    // defect the Issue reports, present in the fixture.
    expect(LEGACY_SHAPE.split('\n')[0]).toBe(`> **${TURN_REASONING_LABEL}**`);

    const split = splitChatThinking(LEGACY_SHAPE);
    // Two quotes, one before the answer and one after it, and both are folded —
    // counted one apiece, since the legacy shape carries no count of its own.
    expect(split.blocks).toBe(2);
    expect(split.body.split('\n')[0]).toBe(
      'カレントディレクトリに `probe.txt` を作成し、`hello` の1行を書き込みました。',
    );
    expect(split.reasoning).toContain('Preparing for patch application');
    expect(split.reasoning).toContain('The write succeeded.');
  });

  it('leaves the tool log exactly where #2234 put it', () => {
    const split = splitChatThinking(NEW_SHAPE);
    expect(split.body).toContain(`> **${TURN_TOOL_LOG_LABEL} (1)**`);
    expect(split.body).toContain('> - `apply_patch` — probe.txt');
  });

  it('returns a body with no reasoning byte-identical', () => {
    // Every non-opencode bubble goes through this function on every render.
    const plain = `Done.\n\n> **${TURN_TOOL_LOG_LABEL} (1)**\n>\n> - \`Bash\` — ls`;
    const split = splitChatThinking(plain);
    expect(split.body).toBe(plain);
    expect(split.reasoning).toBeNull();
    expect(split.blocks).toBe(0);
  });

  it('leaves an ordinary blockquote the agent wrote alone', () => {
    const quoted = 'As the docs put it:\n\n> never trust the pane\n\nSo I read the file.';
    expect(splitChatThinking(quoted).body).toBe(quoted);
    expect(splitChatThinking(quoted).reasoning).toBeNull();
  });

  it('does not tear a Thinking heading out of the middle of a larger quote', () => {
    // The heading has to OPEN the blockquote. One nested inside another quote is
    // that quote's content and removing it would corrupt what is left.
    const nested = `> a quote\n> **${TURN_REASONING_LABEL}**\n> still the same quote`;
    expect(splitChatThinking(nested).body).toBe(nested);
    expect(splitChatThinking(nested).reasoning).toBeNull();
  });

  it('is not fooled by a paragraph that merely says Thinking', () => {
    const prose = `Thinking about it, I read the file.\n\n**${TURN_REASONING_LABEL}** is a word.`;
    expect(splitChatThinking(prose).body).toBe(prose);
  });

  it('closes the gap the removed section leaves behind', () => {
    const split = splitChatThinking(
      `one\n\n> **${TURN_REASONING_LABEL} (1)**\n>\n> thought\n\ntwo`,
    );
    expect(split.body).toBe('one\n\ntwo');
  });

  it('answers an empty body for a turn that was nothing but reasoning', () => {
    const split = splitChatThinking(`> **${TURN_REASONING_LABEL} (1)**\n>\n> hmm`);
    expect(split.body).toBe('');
    expect(split.reasoning).toBe('hmm');
  });

  it('takes an empty string without complaint', () => {
    expect(splitChatThinking('')).toEqual({ body: '', reasoning: null, blocks: 0 });
  });
});

// ---------------------------------------------------------------------------
// 2. The bubble
// ---------------------------------------------------------------------------

describe('[#2272] the bubble', () => {
  it('opens with the answer and not with the quote', () => {
    // Non-vacuity: the SOURCE the bubble is handed still leads with the answer
    // only because the split ran — the legacy row below proves the other half.
    renderBubble(NEW_SHAPE);
    const body = bodyOf();
    const first = body.querySelector('p, blockquote');
    expect(first?.tagName.toLowerCase()).toBe('p');
    expect(first?.textContent).toContain(ANSWER);
  });

  it('folds a legacy row into the same chip, answer first', () => {
    expect(LEGACY_SHAPE.split('\n')[0]).toBe(`> **${TURN_REASONING_LABEL}**`);
    renderBubble(LEGACY_SHAPE);
    const body = bodyOf();
    const first = body.querySelector('p, blockquote');
    expect(first?.tagName.toLowerCase()).toBe('p');
    expect(first?.textContent).toContain(ANSWER);
    expect(screen.getByTestId(CHAT_THINKING_GROUP_TESTID)).toBeInTheDocument();
  });

  it('keeps the reasoning out of the DOM until the chip is opened', () => {
    renderBubble(NEW_SHAPE);
    expect(screen.queryByTestId(CHAT_THINKING_BODY_TESTID)).toBeNull();
    expect(document.body.textContent).not.toContain('Preparing for patch application');
  });

  it('shows the reasoning in full when the chip is opened', () => {
    renderBubble(NEW_SHAPE);
    fireEvent.click(screen.getByTestId(CHAT_THINKING_TOGGLE_TESTID));

    const opened = screen.getByTestId(CHAT_THINKING_BODY_TESTID);
    // Every block, not a preview: the information is folded, never truncated.
    expect(within(opened).getByText('Preparing for patch application')).toBeInTheDocument();
    expect(opened.textContent).toContain('I think I need to edit the patch application process.');
    expect(opened.textContent).toContain('The write succeeded. Now check the content.');
  });

  it('closes again on a second click', () => {
    renderBubble(NEW_SHAPE);
    const toggle = screen.getByTestId(CHAT_THINKING_TOGGLE_TESTID);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId(CHAT_THINKING_BODY_TESTID)).toBeNull();
  });

  it('says how many blocks it stands for', () => {
    // Asserted on the attribute rather than the label: the harness stubs
    // next-intl with the key itself, so the interpolated count never reaches
    // the text node and an assertion on it would pass on a missing count.
    renderBubble(NEW_SHAPE);
    expect(
      screen.getByTestId(CHAT_THINKING_GROUP_TESTID).getAttribute('data-thinking-blocks'),
    ).toBe('2');
  });

  it('draws no chip for a reply that did no thinking', () => {
    renderBubble('Just the answer.');
    expect(screen.queryByTestId(CHAT_THINKING_GROUP_TESTID)).toBeNull();
  });

  it('leaves the tool log where it was', () => {
    renderBubble(NEW_SHAPE);
    expect(bodyOf().textContent).toContain(`${TURN_TOOL_LOG_LABEL} (1)`);
    expect(bodyOf().textContent).toContain('apply_patch');
  });

  it('copies the whole row, reasoning included', () => {
    // What is folded is not deleted. The copy button hands over
    // `message.content`, which still holds every word.
    const onCopy = vi.fn();
    render(
      <ChatMessageBubble
        message={message(NEW_SHAPE)}
        showHeader
        onFilePathClick={vi.fn()}
        onCopy={onCopy}
      />,
    );
    fireEvent.click(screen.getByTestId('chat-copy-message'));
    expect(onCopy).toHaveBeenCalledWith(NEW_SHAPE);
  });

  it('does not touch a terminal-scrape row that happens to quote Thinking', () => {
    // No `requestId` prefix means the plain path, where the body is a screen
    // scrape and every character of it is content.
    renderBubble(LEGACY_SHAPE, { requestId: undefined });
    expect(screen.queryByTestId(CHAT_THINKING_GROUP_TESTID)).toBeNull();
    expect(bodyOf().textContent).toContain(`> **${TURN_REASONING_LABEL}**`);
  });
});

// ---------------------------------------------------------------------------
// 3. History does not move
// ---------------------------------------------------------------------------

describe('[#2272] the History column is untouched', () => {
  function pairWith(content: string): ConversationPair {
    const base = message(content);
    return {
      id: 'pair-1',
      userMessage: { ...base, id: 'user-1', role: 'user', content: 'go', requestId: undefined },
      assistantMessages: [{ ...base, id: 'asst-1' }],
      status: 'completed',
    };
  }

  it('still draws the reasoning as a blockquote in the card', () => {
    // `ConversationPairCard` clamps to two lines and is for browsing; folding a
    // fold gains it nothing, so this Issue deliberately leaves it alone.
    render(
      <ConversationPairCard
        pair={pairWith(NEW_SHAPE)}
        isExpanded
        onFilePathClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(CHAT_THINKING_GROUP_TESTID)).toBeNull();
    expect(document.querySelector('blockquote')).not.toBeNull();
    expect(document.body.textContent).toContain('Preparing for patch application');
  });
});

// ---------------------------------------------------------------------------
// 4. The label the chip actually shows
// ---------------------------------------------------------------------------

describe('[#2272] the chip label', () => {
  const locale = (name: string): Record<string, string> => {
    const parsed = JSON.parse(
      readFileSync(join(process.cwd(), 'locales', name, 'worktree.json'), 'utf-8'),
    ) as { chatTranscript: { thinking: Record<string, string> } };
    return parsed.chatTranscript.thinking;
  };

  it.each(['en', 'ja'])('carries the count and both disclosure verbs in %s', (name) => {
    // The harness stubs next-intl with the key, so the rendered text can never
    // prove the count is in the string. This reads the file that ships.
    const strings = locale(name);
    expect(strings.summary).toContain('{count}');
    expect(strings.expand.length).toBeGreaterThan(0);
    expect(strings.collapse.length).toBeGreaterThan(0);
    expect(strings.expand).not.toBe(strings.collapse);
  });
});
