/**
 * Feature parity between the chat transcript and the History pane it replaced
 * (Issue #2232).
 *
 * A second transcript implementation is only an improvement if it does not
 * quietly drop what the first one did. Everything below already existed on the
 * chat surface before this Issue, because the surface WAS `HistoryPane`; losing
 * any of it would be a regression that no amount of nicer bubbles pays for:
 *
 *   - #1121's optimistic send states, with retry and discard reachable;
 *   - clickable file paths (`onFilePathClick`);
 *   - copy, and the toast that says it worked;
 *   - insert-into-composer (`onInsertToMessage`);
 *   - #168's dimming of archived rows;
 *   - #716's in-place search, including next/previous.
 *
 * Two of these change SHAPE rather than existing: the actions are rendered
 * unconditionally instead of behind `opacity-0 group-hover:opacity-100` (a
 * hover-shaped design on a surface people use from a phone), and search reaches
 * a message row directly because a row is a message here — History had to go
 * messageId → pairId → row index, which is why `HistoryMatch` was keyed by
 * messageId all along.
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

// Keep the real highlight engine, but watch which namespace it is handed — the
// same technique `HistoryPane.test.tsx` uses for #744.
const applyHistoryHighlightsSpy = vi.fn();
const clearHistoryHighlightsSpy = vi.fn();
vi.mock('@/lib/terminal-highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/terminal-highlight')>();
  return {
    ...actual,
    applyHistoryHighlights: (...args: unknown[]) => {
      applyHistoryHighlightsSpy(...args);
      return (actual.applyHistoryHighlights as (...a: unknown[]) => void)(...args);
    },
    clearHistoryHighlights: (...args: unknown[]) => {
      clearHistoryHighlightsSpy(...args);
      return (actual.clearHistoryHighlights as (...a: unknown[]) => void)(...args);
    },
  };
});

import { ChatTranscript } from '@/components/worktree/ChatTranscript';

const WORKTREE_ID = 'wt-2232-parity';

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
    <ChatTranscript messages={messages} worktreeId={WORKTREE_ID} cliToolId="claude" {...props} />,
  );
}

function rowFor(messageId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-row-message-id="${messageId}"]`);
  expect(row, `row for ${messageId}`).not.toBeNull();
  return row!;
}

beforeEach(() => {
  copyToClipboardMock.mockClear();
  applyHistoryHighlightsSpy.mockClear();
  clearHistoryHighlightsSpy.mockClear();
});

// ---------------------------------------------------------------------------
// #1121 optimistic sends
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript keeps the #1121 pending states', () => {
  it('marks a message that is still being sent', () => {
    renderTranscript([msg('p1', 'user', 'hello', { optimisticState: 'sending' })]);
    expect(screen.getByTestId('chat-optimistic-sending')).toBeInTheDocument();
    expect(rowFor('p1').innerHTML).toContain('opacity-70');
  });

  it('offers retry and discard on a failed send, both keyed by the tempId', () => {
    // `onRetryPending` / `onDiscardPending` were always message-level callbacks,
    // which is why they survive the move off pairs unchanged.
    const onRetryPending = vi.fn();
    const onDiscardPending = vi.fn();
    renderTranscript([msg('p1', 'user', 'hello', { optimisticState: 'error' })], {
      onRetryPending,
      onDiscardPending,
    });

    expect(screen.getByTestId('chat-optimistic-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-pending-retry'));
    fireEvent.click(screen.getByTestId('chat-pending-discard'));

    expect(onRetryPending).toHaveBeenCalledWith('p1');
    expect(onDiscardPending).toHaveBeenCalledWith('p1');
  });

  it('tints the failed bubble as an error rather than an ordinary user turn', () => {
    renderTranscript([msg('p1', 'user', 'hello', { optimisticState: 'error' })]);
    const bubble = rowFor('p1').querySelector('[data-message-id="p1"]')!.parentElement!;
    expect(bubble.className).toContain('bg-danger-subtle');
    expect(bubble.className).not.toContain('bg-accent-500/10');
  });

  it('renders no retry/discard when the caller wired neither', () => {
    renderTranscript([msg('p1', 'user', 'hello', { optimisticState: 'error' })]);
    expect(screen.queryByTestId('chat-pending-retry')).toBeNull();
    expect(screen.queryByTestId('chat-pending-discard')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File paths, copy, insert
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript keeps the row actions', () => {
  it('turns a file path into a control that reports the path', () => {
    const onFilePathClick = vi.fn();
    renderTranscript([msg('a1', 'assistant', 'edited /src/app/page.tsx just now')], {
      onFilePathClick,
    });

    fireEvent.click(screen.getByText('/src/app/page.tsx'));
    expect(onFilePathClick).toHaveBeenCalledWith('/src/app/page.tsx');
  });

  it('links paths inside an agent-authored Markdown body too', () => {
    const onFilePathClick = vi.fn();
    renderTranscript(
      [msg('a1', 'assistant', 'see /src/lib/chat/x.ts for it', { requestId: 'oc-turn:m1' })],
      { onFilePathClick },
    );

    fireEvent.click(screen.getByText('/src/lib/chat/x.ts'));
    expect(onFilePathClick).toHaveBeenCalledWith('/src/lib/chat/x.ts');
  });

  it('copies a body and says so', async () => {
    const showToast = vi.fn();
    renderTranscript([msg('a1', 'assistant', 'the reply')], { showToast });

    fireEvent.click(within(rowFor('a1')).getByTestId('chat-copy-message'));

    expect(copyToClipboardMock).toHaveBeenCalledWith('the reply');
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('worktree.history.copied', 'success'));
  });

  it('says so when the clipboard refuses', async () => {
    const showToast = vi.fn();
    copyToClipboardMock.mockRejectedValueOnce(new Error('denied'));
    renderTranscript([msg('a1', 'assistant', 'the reply')], { showToast });

    fireEvent.click(within(rowFor('a1')).getByTestId('chat-copy-message'));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('worktree.history.copyFailed', 'error'),
    );
  });

  it('puts a user message back into the composer', () => {
    const onInsertToMessage = vi.fn();
    renderTranscript([msg('u1', 'user', 'run the tests')], { onInsertToMessage });

    fireEvent.click(screen.getByTestId('chat-insert-user-message'));
    expect(onInsertToMessage).toHaveBeenCalledWith('run the tests');
  });

  it('renders the actions without waiting for a hover', () => {
    // `ConversationPairCard` hides them behind `opacity-0
    // group-hover:opacity-100` plus an `[@media(hover:none)]` escape. A chat
    // surface is used from a phone; the escape hatch is not the answer, showing
    // the buttons is.
    renderTranscript([msg('u1', 'user')], { onInsertToMessage: vi.fn(), showToast: vi.fn() });
    const actions = within(rowFor('u1')).getByTestId('chat-message-actions');

    expect(actions.className).not.toContain('opacity-0');
    expect(actions.className).not.toContain('group-hover:opacity-100');
    expect(actions.className).not.toContain('hover:none');
  });
});

// ---------------------------------------------------------------------------
// #168 archived rows
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript keeps archived rows dimmed', () => {
  it('dims an archived row and leaves a live one alone', () => {
    renderTranscript([
      msg('old', 'assistant', 'from a previous session', { archived: true }),
      msg('new', 'assistant', 'from this one'),
    ]);

    expect(rowFor('old').className).toContain('opacity-60');
    expect(rowFor('new').className).not.toContain('opacity-60');
  });
});

// ---------------------------------------------------------------------------
// #716 search
// ---------------------------------------------------------------------------

describe('[#2232] ChatTranscript keeps in-place search', () => {
  function openSearchAndType(query: string, props: Record<string, unknown> = {}) {
    renderTranscript(
      [
        msg('u1', 'user', 'find the sentinel here'),
        msg('a1', 'assistant', 'a sentinel and another sentinel'),
      ],
      props,
    );
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
      target: { value: query },
    });
  }

  it('is reachable from one unobtrusive control', () => {
    renderTranscript([msg('u1', 'user')]);
    // Not a header row of controls: one icon, and the bar only once it is asked for.
    expect(screen.queryByRole('search')).toBeNull();
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('highlights every hit and walks them with next/previous', async () => {
    openSearchAndType('sentinel');

    const counter = await screen.findByRole('status');
    await waitFor(() => expect(counter.textContent).toBe('1/3'));

    fireEvent.click(screen.getByLabelText('worktree.history.search.next'));
    await waitFor(() => expect(counter.textContent).toBe('2/3'));

    fireEvent.click(screen.getByLabelText('worktree.history.search.prev'));
    await waitFor(() => expect(counter.textContent).toBe('1/3'));

    // The engine was actually asked to mark the DOM, not merely counted in state.
    await waitFor(() => expect(applyHistoryHighlightsSpy).toHaveBeenCalled());
    const marked = applyHistoryHighlightsSpy.mock.calls.map((call) => call[0] as Element);
    expect(marked.some((el) => el.getAttribute('data-message-id') === 'a1')).toBe(true);
  });

  it('marks under a namespace of its own, never History’s', async () => {
    // `CSS.highlights` is one global registry keyed by name: sharing
    // `history-search` would make a chat search erase a History search's marks.
    openSearchAndType('sentinel');
    await waitFor(() => expect(applyHistoryHighlightsSpy).toHaveBeenCalled());

    const namespaces = applyHistoryHighlightsSpy.mock.calls.map(
      (call) => call[3] as { highlightName?: string } | undefined,
    );
    expect(namespaces.every((ns) => ns?.highlightName === 'chat-search')).toBe(true);
  });

  it('isolates the namespace per PC split', async () => {
    openSearchAndType('sentinel', { splitIndex: 2 });
    await waitFor(() => expect(applyHistoryHighlightsSpy).toHaveBeenCalled());

    const namespaces = applyHistoryHighlightsSpy.mock.calls.map(
      (call) => call[3] as { highlightName?: string } | undefined,
    );
    expect(namespaces.every((ns) => ns?.highlightName === 'chat-search-2')).toBe(true);
  });

  it('closes back to the icon and clears its marks', async () => {
    openSearchAndType('sentinel');
    await waitFor(() => expect(applyHistoryHighlightsSpy).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText('worktree.history.search.close'));

    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.getByTestId('chat-transcript-search-toggle')).toBeInTheDocument();
    await waitFor(() => expect(clearHistoryHighlightsSpy).toHaveBeenCalled());
  });
});
