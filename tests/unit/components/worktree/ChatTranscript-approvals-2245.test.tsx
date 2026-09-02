/**
 * The chat transcript stops rendering approval dialogs and pane escapes
 * (Issue #2245).
 *
 * ## What was on screen
 *
 * `ChatMessageBubble` looked at `message.role` and nothing else. Measured on
 * develop `966b40f8` over the last 50 rows of two live worktrees, that made 41
 * (antigravity) and 43 (codex) of them "Assistant" bubbles containing 1.6–2.8 KB
 * of pane starting at the shell prompt line, `run_command: {"CommandLine":…}`
 * JSON, or a tool line with its escape sequences visible as `[32m●[39m`. The
 * fixture under `tests/fixtures/chat-transcript-2245` is that data, verbatim.
 *
 * ## What this file pins
 *
 *  1. an approval row renders as a CHIP and its body never reaches the DOM;
 *  2. a run of them is ONE collapsed row, openable, with a label per chip;
 *  3. the Auto-Yes duplicate is one chip that says `auto`;
 *  4. the permission hook's audit row is identified by its `summary` prefix;
 *  5. a degraded `promptData` renders instead of throwing;
 *  6. escape sequences leave both the rendered body and the copied text, while
 *     the Markdown path is untouched;
 *  7. approval rows are outside the search index;
 *  8. the chips add and remove no "Assistant" header.
 *
 * jsdom performs no layout, so the #1123 fallback list is what renders here —
 * the same branch every other `ChatTranscript` test exercises.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

const copyToClipboardMock = vi.fn(async (_text: string) => {});
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (text: string) => copyToClipboardMock(text),
}));

import { ChatTranscript } from '@/components/worktree/ChatTranscript';
import {
  isPermissionAuditMessage,
  isToolApprovalMessage,
} from '@/lib/chat/chat-tool-approvals';
import {
  agyMessages,
  codexMessages,
  AGY_AUDIT_INDEX,
  AGY_DUPLICATE_PAIR_INDEXES,
} from '@tests/fixtures/chat-transcript-2245';
import { degradedPromptRows } from '@tests/fixtures/chat-transcript-2245/degraded-prompt-rows';

const WORKTREE_ID = 'wt-2245';
const ESC = String.fromCharCode(0x1b);
/** A real tool line from the antigravity capture, escapes and all. */
const ANSI_BODY = `${ESC}[32m●${ESC}[39m ${ESC}[1m${ESC}[33mBash${ESC}[0m(git status)`;
const ANSI_BODY_CLEAN = '● Bash(git status)';

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
    timestamp: new Date(Date.UTC(2026, 8, 2, 10, 0, 0)),
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

function openTheGroup(): HTMLElement {
  const group = screen.getByTestId('chat-tool-approval-group');
  fireEvent.click(within(group).getByTestId('chat-tool-approval-toggle'));
  return group;
}

beforeEach(() => {
  copyToClipboardMock.mockClear();
});

// ---------------------------------------------------------------------------
// 1. The body never reaches the DOM
// ---------------------------------------------------------------------------

describe('[#2245] approval rows are chips, not bubbles', () => {
  it('draws no bubble for a captured approval row', () => {
    const messages = agyMessages();
    renderTranscript(messages);

    for (const approval of messages.filter(isToolApprovalMessage)) {
      expect(
        document.querySelector(`[data-row-message-id="${approval.id}"]`),
        `bubble for ${approval.id}`,
      ).toBeNull();
      expect(document.querySelector(`[data-message-id="${approval.id}"]`)).toBeNull();
    }
  });

  it('puts none of the pane dump on the screen', () => {
    const messages = agyMessages();
    renderTranscript(messages);
    const readTranscript = () => screen.getByTestId('chat-transcript').textContent ?? '';

    // The three shapes the Issue measured — closed, and then opened, because a
    // fold that only hides the body until somebody clicks has fixed nothing.
    const assertClean = (body: string) => {
      expect(body).not.toContain("CM_HOOK_URL='http");
      expect(body).not.toContain('"CommandLine"');
      expect(body).not.toContain(ESC);
    };

    assertClean(readTranscript());
    openTheGroup();
    assertClean(readTranscript());
  });

  it('still renders the ordinary rows around them', () => {
    const messages = agyMessages();
    renderTranscript(messages);
    for (const normal of messages.filter((m) => !isToolApprovalMessage(m))) {
      expect(
        document.querySelector(`[data-row-message-id="${normal.id}"]`),
        `bubble for ${normal.id}`,
      ).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. One collapsed row per run
// ---------------------------------------------------------------------------

describe('[#2245] a run of approvals is one collapsed row', () => {
  it('folds the codex audit run into a single group, closed', () => {
    const messages = codexMessages();
    const approvals = messages.filter(isToolApprovalMessage);
    expect(approvals.length).toBeGreaterThanOrEqual(4);
    renderTranscript(messages);

    const groups = screen.getAllByTestId('chat-tool-approval-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].getAttribute('data-approval-count')).toBe(String(approvals.length));
    // Closed: the labels are not in the DOM until it is asked for.
    expect(screen.queryAllByTestId('chat-tool-approval-entry')).toHaveLength(0);
    expect(
      within(groups[0]).getByTestId('chat-tool-approval-toggle').getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('shows one label per approval once it is opened', () => {
    const messages = codexMessages();
    const approvals = messages.filter(isToolApprovalMessage);
    renderTranscript(messages);
    const group = openTheGroup();

    const entries = within(group).getAllByTestId('chat-tool-approval-entry');
    expect(entries).toHaveLength(approvals.length);
    expect(
      within(group).getByTestId('chat-tool-approval-toggle').getAttribute('aria-expanded'),
    ).toBe('true');

    // Each chip says what was approved — the question, not the body.
    for (const entry of entries) {
      expect(entry.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      expect(entry.textContent).toContain('Approve Bash?');
    }

    fireEvent.click(within(group).getByTestId('chat-tool-approval-toggle'));
    expect(screen.queryAllByTestId('chat-tool-approval-entry')).toHaveLength(0);
  });

  it('does not merge two runs separated by a reply', () => {
    renderTranscript([
      msg('p1', 'assistant', 'pane', { messageType: 'prompt' }),
      msg('a1', 'assistant', 'a reply'),
      msg('p2', 'assistant', 'pane', { messageType: 'prompt' }),
    ]);
    expect(screen.getAllByTestId('chat-tool-approval-group')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. + 4. The duplicate, and the audit row
// ---------------------------------------------------------------------------

describe('[#2245] what each chip says', () => {
  it('shows the Auto-Yes duplicate as one approval answered automatically', () => {
    const pair = AGY_DUPLICATE_PAIR_INDEXES.map((i) => agyMessages()[i]);
    renderTranscript(pair);
    const group = openTheGroup();

    const entries = within(group).getAllByTestId('chat-tool-approval-entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].getAttribute('data-approval-outcome')).toBe('auto');
    expect(entries[0].getAttribute('data-approval-merged')).toBe('2');
    expect(entries[0].textContent).toContain('worktree.chatTranscript.toolApproval.autoApproved');
    expect(entries[0].textContent).not.toContain(
      'worktree.chatTranscript.toolApproval.answeredInTerminal',
    );
  });

  it('shows a `PermissionRequest allow` row as auto-approved', () => {
    renderTranscript([agyMessages()[AGY_AUDIT_INDEX]]);
    const group = openTheGroup();
    const [entry] = within(group).getAllByTestId('chat-tool-approval-entry');

    expect(entry.getAttribute('data-approval-audit')).toBe('true');
    expect(entry.getAttribute('data-approval-outcome')).toBe('auto');
    expect(entry.textContent).toContain('worktree.chatTranscript.toolApproval.autoApproved');
  });

  it('keeps a terminal-answered dialog labelled as such when nothing folds into it', () => {
    const [first] = AGY_DUPLICATE_PAIR_INDEXES.map((i) => agyMessages()[i]);
    renderTranscript([first]);
    const group = openTheGroup();
    const [entry] = within(group).getAllByTestId('chat-tool-approval-entry');
    expect(entry.getAttribute('data-approval-outcome')).toBe('terminal');
  });
});

// ---------------------------------------------------------------------------
// 5. Degraded promptData
// ---------------------------------------------------------------------------

describe('[#2245] degraded promptData does not take the conversation down', () => {
  it('renders every shape the column can hold', () => {
    expect(() =>
      renderTranscript([msg('u1', 'user', 'question'), ...degradedPromptRows]),
    ).not.toThrow();

    const group = openTheGroup();
    const entries = within(group).getAllByTestId('chat-tool-approval-entry');
    expect(entries).toHaveLength(degradedPromptRows.length);
    // Each one still says something, and none of them says the body.
    for (const entry of entries) {
      expect(entry.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      expect(entry.textContent).not.toContain('pane dump that must never be rendered');
    }
    expect(screen.getByTestId('chat-transcript')).toBeInTheDocument();
  });

  it('names the row when it has nothing at all to say', () => {
    renderTranscript([degradedPromptRows[0]]);
    const group = openTheGroup();
    expect(within(group).getByText('worktree.chatTranscript.toolApproval.unlabeled')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. Escape sequences
// ---------------------------------------------------------------------------

describe('[#2245] escape sequences leave the non-Markdown path', () => {
  it('strips them from the rendered body', () => {
    renderTranscript([msg('a1', 'assistant', ANSI_BODY)]);
    const body = document.querySelector('[data-message-id="a1"]') as HTMLElement;

    expect(body.textContent).toBe(ANSI_BODY_CLEAN);
    expect(body.textContent).not.toContain(ESC);
    expect(body.textContent).not.toContain('[32m');
  });

  it('strips them from what copy puts on the clipboard', async () => {
    renderTranscript([msg('a1', 'assistant', ANSI_BODY)]);
    fireEvent.click(screen.getByTestId('chat-copy-message'));

    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());
    const copied = copyToClipboardMock.mock.calls[0][0];
    expect(copied).toBe(ANSI_BODY_CLEAN);
    expect(copied).not.toContain(ESC);
  });

  it('strips them from the captured rows the Issue found them in', () => {
    const messages = [...agyMessages(), ...codexMessages()].filter(
      (m) => !isToolApprovalMessage(m),
    );
    expect(messages.some((m) => m.content.includes(ESC))).toBe(true);
    renderTranscript(messages);
    expect(screen.getByTestId('chat-transcript').textContent).not.toContain(ESC);
  });

  it('leaves the Markdown path exactly as it was', () => {
    // A transcript-reader body is authored text: an `ESC` there is content, and
    // this Issue is not allowed to reach into #2041's Markdown branch.
    renderTranscript([
      msg('a1', 'assistant', `# Heading\n\n${ANSI_BODY}`, { requestId: 'oc-turn:msg_1' }),
    ]);
    const body = document.querySelector('[data-message-id="a1"]') as HTMLElement;

    expect(body.getAttribute('data-markdown')).toBe('true');
    expect(body.querySelector('h1')?.textContent).toBe('Heading');
    expect(body.textContent).toContain(ESC);
  });

  it('copies a Markdown body verbatim', async () => {
    const content = `# Heading\n\n${ANSI_BODY}`;
    renderTranscript([msg('a1', 'assistant', content, { requestId: 'oc-turn:msg_1' })]);
    fireEvent.click(screen.getByTestId('chat-copy-message'));

    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalled());
    expect(copyToClipboardMock.mock.calls[0][0]).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// 7. Search
// ---------------------------------------------------------------------------

describe('[#2245] approval rows are outside the search index', () => {
  it('counts hits in replies only', async () => {
    // `sentinel` is in one reply and in two approval bodies. Before #2245 the
    // search reported three hits, two of which could not be scrolled to or
    // highlighted: there is no `data-message-id` element for a chip.
    renderTranscript([
      msg('a1', 'assistant', 'a sentinel in a reply'),
      msg('p1', 'assistant', 'pane dump with a sentinel in it', { messageType: 'prompt' }),
      msg('p2', 'assistant', 'another pane dump with a sentinel', { messageType: 'prompt' }),
    ]);

    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
      target: { value: 'sentinel' },
    });

    const counter = await screen.findByRole('status');
    await waitFor(() => expect(counter.textContent).toBe('1/1'));
  });

  it('finds nothing when the only occurrences are in approval rows', async () => {
    // `0/0` is also the state before anything is typed, so the search runs
    // twice: `alpha` establishes that the pipeline is live and returns the
    // reply's single hit, and only then does `beta` — which exists nowhere but
    // in the approval bodies — have to come back empty.
    renderTranscript([
      msg('a1', 'assistant', 'an ordinary reply with alpha in it'),
      msg('p1', 'assistant', 'pane dump with alpha and beta in it', { messageType: 'prompt' }),
      msg('p2', 'assistant', 'another pane dump with beta', { messageType: 'prompt' }),
    ]);

    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    const input = screen.getByLabelText('worktree.history.search.keywordLabel');

    fireEvent.change(input, { target: { value: 'alpha' } });
    const counter = await screen.findByRole('status');
    await waitFor(() => expect(counter.textContent).toBe('1/1'));

    fireEvent.change(input, { target: { value: 'beta' } });
    await waitFor(() => expect(counter.textContent).toBe('0/0'));
    expect(screen.getByLabelText('worktree.history.search.next')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// 8. Role headers
// ---------------------------------------------------------------------------

describe('[#2245] chips change no role header', () => {
  const headerCount = () => screen.queryAllByText('worktree.conversation.assistant').length;

  it('renders the same Assistant headers with the chips as without them', () => {
    const { unmount } = renderTranscript([msg('u1', 'user'), msg('a1', 'assistant')]);
    const withoutChips = headerCount();
    expect(withoutChips).toBe(1);
    unmount();

    renderTranscript([
      msg('u1', 'user'),
      msg('p1', 'assistant', 'pane', { messageType: 'prompt' }),
      msg('p2', 'assistant', 'pane', { messageType: 'prompt' }),
      msg('a1', 'assistant'),
    ]);
    expect(headerCount()).toBe(withoutChips);
  });

  it('does not split one reply in two because a chip landed inside it', () => {
    const { unmount } = renderTranscript([msg('a1', 'assistant'), msg('a2', 'assistant')]);
    const withoutChips = headerCount();
    expect(withoutChips).toBe(1);
    unmount();

    renderTranscript([
      msg('a1', 'assistant'),
      msg('p1', 'assistant', 'pane', { messageType: 'prompt' }),
      msg('a2', 'assistant'),
    ]);
    expect(headerCount()).toBe(withoutChips);
  });

  it('gives the audit rows no Assistant label of their own', () => {
    renderTranscript(codexMessages().filter(isPermissionAuditMessage));
    expect(headerCount()).toBe(0);
    expect(screen.getByTestId('chat-tool-approval-group')).toBeInTheDocument();
  });
});
