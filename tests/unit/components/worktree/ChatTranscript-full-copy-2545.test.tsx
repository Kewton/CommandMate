/**
 * "Copy the full message" on the chat surface (Issue #2545).
 *
 * #2544 made the copy button beside a reply hand over the answer only, leaving
 * the Thinking and Tool calls sections behind their chips. This Issue puts the
 * whole row back within reach of the chat surface as a SECOND operation, so a
 * reader who wants the reasoning and the calls does not have to open History.
 *
 * ## What this file pins
 *
 *  1. **where it appears** — on a Markdown row `splitChatMarkdownBody` folded
 *     something out of, including a tools-only turn whose answer is blank; and
 *     nowhere else: not on a row that folded nothing, not on a terminal scrape,
 *     not on a prompt;
 *  2. **what it copies** — `message.content`, byte for byte, through the same
 *     `handleCopy` as the answer-only copy, so both toasts are the existing ones;
 *  3. **that it reads `folded`** — `splitChatMarkdownBody` is spied, and the
 *     button follows what it answers rather than a detection of its own;
 *  4. **that it is told apart** — a different `aria-label`, `title` and visible
 *     word from the answer-only copy, each defined in both dictionaries;
 *  5. **that it is not hover-shaped** — rendered with the row, no hover-reveal
 *     class on it or on the actions row, and mounted through the one transcript
 *     the PC pane, the phone tab and the `/sessions` tile all share.
 *
 * @vitest-environment jsdom
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ChatMarkdownBodySplit } from '@/lib/chat/chat-markdown-body';
import type { ChatMessage } from '@/types/models';

const copyToClipboardMock = vi.fn(async (_text: string) => {});
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (text: string) => copyToClipboardMock(text),
}));

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

import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import {
  CHAT_THINKING_GROUP_TESTID,
  CHAT_TOOL_LOG_GROUP_TESTID,
} from '@/components/worktree/ChatMessageBubble';
import {
  separateTurnBody,
  TURN_REASONING_LABEL,
  TURN_TOOL_LOG_LABEL,
} from '@/lib/hooks/sources/turn-body';
import { claudeTurnRequestId } from '@/types/agent-transcript';

const WORKTREE_ID = 'wt-2545';
const FULL_COPY_TESTID = 'chat-copy-full-message';
const COPY_TESTID = 'chat-copy-message';

const ANSWER = 'Created `probe.txt` and wrote one line to it.';

/** A turn that answered, thought and called two tools. */
const TURN_BODY = separateTurnBody([
  { kind: 'prose', text: ANSWER },
  { kind: 'reasoning', text: 'The write succeeded; now check the content.' },
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `apply_patch` — probe.txt' },
]).body;

/** A turn that only thought before answering. */
const THINKING_ONLY = separateTurnBody([
  { kind: 'prose', text: ANSWER },
  { kind: 'reasoning', text: 'The write succeeded.' },
]).body;

/** A turn that ran tools and said nothing. */
const TOOLS_ONLY = separateTurnBody([
  { kind: 'tool', text: '- `Bash` — ls' },
  { kind: 'tool', text: '- `Bash` — pwd' },
]).body;

function msg(id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date(Date.UTC(2026, 8, 13, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    // The scraper's id: the verbatim (plain) path.
    requestId: `req_${id}`,
    ...extra,
  };
}

/** An agent-authored assistant row: the Markdown path. */
function agentRow(id: string, content: string): ChatMessage {
  return msg(id, 'assistant', content, { requestId: claudeTurnRequestId(`u-${id}`) });
}

function renderTranscript(messages: ChatMessage[]) {
  const showToast = vi.fn();
  render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      onFilePathClick={vi.fn()}
      showToast={showToast}
    />,
  );
  return showToast;
}

function rowFor(messageId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-row-message-id="${messageId}"]`);
  expect(row, `row for ${messageId}`).not.toBeNull();
  return row!;
}

beforeEach(() => {
  window.localStorage.clear();
  copyToClipboardMock.mockReset();
  copyToClipboardMock.mockImplementation(async () => {});
});

afterEach(() => {
  spy.override = null;
});

// ---------------------------------------------------------------------------
// 1. Where it appears
// ---------------------------------------------------------------------------

describe('[#2545] the full-message copy appears only on rows with folded sections', () => {
  it('appears on a row with Thinking and Tool calls, beside the answer-only copy', () => {
    expect(TURN_BODY).toContain(`> **${TURN_REASONING_LABEL} (1)**`);
    expect(TURN_BODY).toContain(`> **${TURN_TOOL_LOG_LABEL} (2)**`);
    renderTranscript([agentRow('a1', TURN_BODY)]);

    const row = within(rowFor('a1'));
    expect(row.getByTestId(CHAT_THINKING_GROUP_TESTID)).toBeInTheDocument();
    expect(row.getByTestId(CHAT_TOOL_LOG_GROUP_TESTID)).toBeInTheDocument();
    expect(row.getByTestId(COPY_TESTID)).toBeInTheDocument();
    expect(row.getByTestId(FULL_COPY_TESTID)).toBeInTheDocument();
  });

  it('appears on a row whose only folded section is Thinking', () => {
    expect(THINKING_ONLY).toContain(`> **${TURN_REASONING_LABEL} (1)**`);
    expect(THINKING_ONLY).not.toContain(TURN_TOOL_LOG_LABEL);
    renderTranscript([agentRow('a1', THINKING_ONLY)]);

    expect(within(rowFor('a1')).getByTestId(FULL_COPY_TESTID)).toBeInTheDocument();
  });

  it('appears on a tools-only turn, where it is the only copy the row offers', () => {
    expect(TOOLS_ONLY).toContain(`> **${TURN_TOOL_LOG_LABEL} (2)**`);
    renderTranscript([agentRow('a1', TOOLS_ONLY)]);

    const row = within(rowFor('a1'));
    expect(row.getByTestId(CHAT_TOOL_LOG_GROUP_TESTID)).toBeInTheDocument();
    // #2544's rule, unchanged: a blank answer offers no answer-only copy.
    expect(row.queryByTestId(COPY_TESTID)).toBeNull();
    expect(row.getByTestId(FULL_COPY_TESTID)).toBeInTheDocument();
  });

  it('does not appear on a Markdown row that folded nothing', () => {
    renderTranscript([
      agentRow('a1', 'Just the answer.\n\n> a quote the agent wrote\n\n- a prose list\n'),
      agentRow('a2', TURN_BODY),
    ]);

    expect(within(rowFor('a1')).getByTestId(COPY_TESTID)).toBeInTheDocument();
    expect(within(rowFor('a1')).queryByTestId(FULL_COPY_TESTID)).toBeNull();
    // Positive control in the same transcript: a folded row next to it has one.
    expect(within(rowFor('a2')).getByTestId(FULL_COPY_TESTID)).toBeInTheDocument();
  });

  it('does not appear on a terminal scrape, even one carrying the section markers', () => {
    // Out of scope by design: the plain path has no markers it can trust, so
    // there is no "answer" to tell apart from "the whole row".
    renderTranscript([msg('a1', 'assistant', TURN_BODY)]);

    expect(within(rowFor('a1')).getByTestId(COPY_TESTID)).toBeInTheDocument();
    expect(within(rowFor('a1')).queryByTestId(FULL_COPY_TESTID)).toBeNull();
  });

  it('does not appear on a user prompt', () => {
    renderTranscript([msg('u1', 'user', TURN_BODY)]);
    expect(within(rowFor('u1')).queryByTestId(FULL_COPY_TESTID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. What it copies, and the toasts
// ---------------------------------------------------------------------------

describe('[#2545] the full-message copy hands over message.content through handleCopy', () => {
  it('copies the whole stored row, folded sections included, and toasts success', async () => {
    const showToast = renderTranscript([agentRow('a1', TURN_BODY)]);

    fireEvent.click(within(rowFor('a1')).getByTestId(FULL_COPY_TESTID));
    await waitFor(() => expect(showToast).toHaveBeenCalled());

    expect(copyToClipboardMock).toHaveBeenCalledTimes(1);
    const copied = copyToClipboardMock.mock.calls[0][0];
    expect(copied).toBe(TURN_BODY);
    expect(copied).toContain(ANSWER);
    expect(copied).toContain(`> **${TURN_REASONING_LABEL} (1)**`);
    expect(copied).toContain('apply_patch');
    // The same toast the answer-only copy raises.
    expect(showToast).toHaveBeenCalledWith('worktree.history.copied', 'success');
  });

  it('leaves the answer-only copy handing over the answer on the same row', async () => {
    renderTranscript([agentRow('a1', TURN_BODY)]);

    fireEvent.click(within(rowFor('a1')).getByTestId(COPY_TESTID));
    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());
    expect(copyToClipboardMock).toHaveBeenCalledWith(ANSWER);
  });

  it('copies a tools-only turn whole', async () => {
    renderTranscript([agentRow('a1', TOOLS_ONLY)]);

    fireEvent.click(within(rowFor('a1')).getByTestId(FULL_COPY_TESTID));
    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());
    expect(copyToClipboardMock.mock.calls[0][0]).toBe(TOOLS_ONLY);
  });

  it('toasts the existing failure message when the clipboard refuses', async () => {
    copyToClipboardMock.mockImplementation(async () => {
      throw new Error('denied');
    });
    const showToast = renderTranscript([agentRow('a1', TURN_BODY)]);

    fireEvent.click(within(rowFor('a1')).getByTestId(FULL_COPY_TESTID));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith('worktree.history.copyFailed', 'error');
    expect(showToast).not.toHaveBeenCalledWith('worktree.history.copied', 'success');
  });
});

// ---------------------------------------------------------------------------
// 3. It reads `folded`
// ---------------------------------------------------------------------------

describe('[#2545] the full-message copy follows splitChatMarkdownBody', () => {
  const split = (content: string, folded: boolean): ChatMarkdownBodySplit => ({
    body: content,
    reasoning: null,
    reasoningBlocks: 0,
    toolLog: '',
    toolCalls: 0,
    folded,
  });

  it('is hidden on a sectioned row when the function says nothing was folded', () => {
    spy.override = (content) => split(content, false);
    renderTranscript([agentRow('a1', TURN_BODY)]);
    expect(within(rowFor('a1')).queryByTestId(FULL_COPY_TESTID)).toBeNull();
  });

  it('is shown on a plain answer when the function says something was folded', async () => {
    spy.override = (content) => split(content, true);
    renderTranscript([agentRow('a1', 'Just the answer.')]);

    fireEvent.click(within(rowFor('a1')).getByTestId(FULL_COPY_TESTID));
    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());
    expect(copyToClipboardMock.mock.calls[0][0]).toBe('Just the answer.');
  });
});

// ---------------------------------------------------------------------------
// 4. Told apart from the answer-only copy
// ---------------------------------------------------------------------------

describe('[#2545] the two copies are labelled apart', () => {
  it('uses its own aria-label, title and visible word', () => {
    renderTranscript([agentRow('a1', TURN_BODY)]);
    const copy = within(rowFor('a1')).getByTestId(COPY_TESTID);
    const full = within(rowFor('a1')).getByTestId(FULL_COPY_TESTID);

    expect(full).toHaveAttribute('aria-label', 'worktree.chatTranscript.copyFull.action');
    expect(full).toHaveAttribute('title', 'worktree.chatTranscript.copyFull.title');
    expect(full.textContent).toBe('worktree.chatTranscript.copyFull.label');

    expect(full.getAttribute('aria-label')).not.toBe(copy.getAttribute('aria-label'));
    expect(full.getAttribute('title')).not.toBe(copy.getAttribute('title'));
    expect(full.textContent).not.toBe(copy.textContent);
  });

  // The global next-intl mock echoes keys, so the assertions above stay green
  // with the dictionaries empty. These read the real ones.
  const LOCALES_DIR = path.resolve(__dirname, '../../../../locales');
  type Dict = Record<string, Record<string, Record<string, string> & Record<string, unknown>>>;
  const load = (locale: string): Dict =>
    JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8')) as Dict;

  for (const locale of ['en', 'ja'] as const) {
    it(`${locale} defines the three strings, each different from the answer-only copy's`, () => {
      const dict = load(locale);
      const copyFull = dict.chatTranscript.copyFull as unknown as Record<string, string>;
      expect(copyFull, `${locale}: chatTranscript.copyFull`).toBeTypeOf('object');

      for (const key of ['label', 'action', 'title']) {
        expect(copyFull[key], `${locale}: chatTranscript.copyFull.${key}`).toBeTypeOf('string');
        expect(copyFull[key].trim().length).toBeGreaterThan(0);
      }
      expect(copyFull.action).not.toBe(dict.conversation.copyMessage);
      expect(copyFull.title).not.toBe(dict.conversation.copy);
      expect(copyFull.label).not.toBe(dict.conversation.copy);
    });
  }

  it('en and ja declare the same copyFull keys, each in its own language', () => {
    const en = load('en').chatTranscript.copyFull as unknown as Record<string, string>;
    const ja = load('ja').chatTranscript.copyFull as unknown as Record<string, string>;
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());

    const isJapanese = (value: string) => /[぀-ヿ一-龯]/.test(value);
    for (const key of Object.keys(en)) {
      expect(isJapanese(en[key]), `en: ${key}`).toBe(false);
      expect(isJapanese(ja[key]), `ja: ${key}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Not hover-shaped, on every surface
// ---------------------------------------------------------------------------

describe('[#2545] the full-message copy is reachable without hover', () => {
  const HOVER_REVEAL = /(^|\s)(opacity-0|invisible|hidden|group-hover:\S+|\[@media\(hover:none\)\]:\S+)(\s|$)/;

  it('is rendered with the row, with no hover-reveal class on it or its actions row', () => {
    renderTranscript([agentRow('a1', TURN_BODY)]);
    const full = within(rowFor('a1')).getByTestId(FULL_COPY_TESTID);
    const actions = within(rowFor('a1')).getByTestId('chat-message-actions');

    expect(actions.contains(full)).toBe(true);
    for (let node: HTMLElement | null = full; node && node !== rowFor('a1'); node = node.parentElement) {
      expect(node.className, `class of ${node.tagName}`).not.toMatch(HOVER_REVEAL);
    }
  });

  it('is wired by the one transcript the PC pane, the phone tab and the /sessions tile share', () => {
    const root = process.cwd();
    const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf-8');

    for (const file of [
      'src/components/worktree/TerminalSplitPaneContent.tsx',
      'src/components/worktree/MobileTerminalTab.tsx',
      'src/components/sessions/SessionTile.tsx',
    ]) {
      expect(read(file), file).toMatch(/<ChatSurface\b/);
    }
    expect(read('src/components/worktree/ChatSurface.tsx')).toMatch(/<ChatTranscript\b/);
    expect(read('src/components/worktree/ChatTranscript.tsx')).toMatch(
      /<ChatMessageBubble[\s\S]*?onCopy=\{handleCopy\}/,
    );
    // The button calls the same `onCopy` prop the answer-only copy does.
    expect(read('src/components/worktree/ChatMessageBubble.tsx')).toMatch(
      /data-testid="chat-copy-full-message"\s*onClick=\{\(\) => onCopy\(fullCopyContent\)\}/,
    );
  });
});
