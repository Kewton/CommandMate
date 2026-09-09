/**
 * The previous session's fold, and the ended banner under it (Issue #2445).
 *
 * ## The defect
 *
 * A chat surface whose tmux session is gone kept drawing the dead session's
 * rows as the current conversation. Nothing on screen said the pane had ended,
 * so the last reply read as the state of play and the composer read as a way to
 * continue that turn — when in fact sending would start a brand new session
 * with none of that context.
 *
 * The server-side half (archiving the previous rows when a new process starts)
 * is Issue #2444 and lands separately; between a session dying and the next
 * send those rows are still `archived = 0`, which is the window this file is
 * about.
 *
 * ## What makes this suite non-vacuous
 *
 * Every assertion below has a stated opposite in the same file, because almost
 * all of them would pass against a component that simply rendered nothing:
 *
 *  - the fold and the banner are asserted ABSENT while attaching, while the
 *    session is running, and while the first history fetch is still in flight;
 *  - the count is asserted against a list whose approval row and whose pending
 *    row are deliberately different kinds of thing, so "N = messages.length"
 *    and "N = rows.length" give different numbers;
 *  - the search assertions check the match COUNT reported by the bar, not just
 *    that a row is missing — a closed fold that still searched would report
 *    matches nobody can see;
 *  - the pending → server-echo case drives the exact ordering the Issue names
 *    (the echo arrives while the pane is still observed dead) and asserts the
 *    row is still outside the fold afterwards.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import {
  ChatTranscript,
  CHAT_PREVIOUS_SESSION_TOGGLE_TESTID,
  CHAT_SESSION_ENDED_BANNER_TESTID,
  chatPreviousSessionRegionId,
} from '@/components/worktree/ChatTranscript';

const WORKTREE_ID = 'wt-2445';

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
    timestamp: new Date(Date.UTC(2026, 8, 9, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    requestId: `req_${id}`,
    ...extra,
  };
}

/** A saved tool-approval row: `messageType: 'prompt'`, folded into a chip row. */
function approval(id: string): ChatMessage {
  return msg(id, 'assistant', `Bash: git status (${id})`, { messageType: 'prompt' });
}

function renderTranscript(messages: ChatMessage[], props: Record<string, unknown> = {}) {
  return render(
    <ChatTranscript
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      instanceId="claude"
      {...props}
    />,
  );
}

function toggle(): HTMLElement | null {
  return screen.queryByTestId(CHAT_PREVIOUS_SESSION_TOGGLE_TESTID);
}

function banner(): HTMLElement | null {
  return screen.queryByTestId(CHAT_SESSION_ENDED_BANNER_TESTID);
}

function row(messageId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-row-message-id="${messageId}"]`);
}

/** The `opacity-60` wrapper the fold puts around each of its rows. */
function foldedWrapperOf(messageId: string): HTMLElement | null {
  return row(messageId)?.closest<HTMLElement>('[data-previous-session="true"]') ?? null;
}

const ENDED = { sessionEnded: true } as const;

const TWO_TURNS = [
  msg('u1', 'user', 'run the tests'),
  msg('a1', 'assistant', 'they pass'),
];

beforeEach(() => {
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// When the fold appears at all
// ---------------------------------------------------------------------------

describe('[#2445] the fold only appears on an observed-dead pane', () => {
  it('folds the saved rows and draws the banner once the pane is observed dead', () => {
    renderTranscript(TWO_TURNS, ENDED);

    expect(toggle()).not.toBeNull();
    expect(banner()).not.toBeNull();
    // Closed by default: the rows are not merely dimmed, they are not rendered.
    expect(row('u1')).toBeNull();
    expect(row('a1')).toBeNull();
  });

  it('draws neither while the pane is alive', () => {
    // The control for every assertion above. `sessionEnded` is the surface's
    // verdict; without it nothing about this component changes.
    renderTranscript(TWO_TURNS);

    expect(toggle()).toBeNull();
    expect(banner()).toBeNull();
    expect(row('u1')).not.toBeNull();
    expect(row('a1')).not.toBeNull();
  });

  it('draws neither while the first history fetch is still in flight', () => {
    // `isLoading` outranks the verdict: a column with no rows yet has nothing to
    // call previous, and folding an empty transcript only to unfold it a tick
    // later is a flash the reader has to interpret.
    renderTranscript([], { ...ENDED, isLoading: true });

    expect(toggle()).toBeNull();
    expect(banner()).toBeNull();
    expect(screen.getByTestId('chat-transcript-loading')).toBeInTheDocument();
  });

  it('folds the rows that were waiting on that fetch once it lands', () => {
    // The other half of the case above: the presentation is deferred, not
    // cancelled, and the snapshot is taken from the rows the fetch delivered.
    const { rerender } = renderTranscript([], { ...ENDED, isLoading: true });
    expect(toggle()).toBeNull();

    rerender(
      <ChatTranscript
        messages={TWO_TURNS}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        sessionEnded
        isLoading={false}
      />,
    );

    expect(toggle()).toHaveAttribute('data-count', '2');
    expect(banner()).not.toBeNull();
  });

  it('draws no fold and no banner when there is nothing saved to fold', () => {
    // A dead pane whose only row is a send in flight. "Previous session (0)"
    // and a banner about a conversation that does not exist would both be
    // noise; the pending bubble keeps its ordinary place.
    renderTranscript([msg('p1', 'user', 'hello', { optimisticState: 'sending' })], ENDED);

    expect(toggle()).toBeNull();
    expect(banner()).toBeNull();
    expect(row('p1')).not.toBeNull();
  });

  it('falls back to the ordinary empty state when every row is archived', () => {
    // The banner would be a second copy of what the empty state already says
    // ("send to start a session"), so it stands down.
    renderTranscript([msg('old', 'assistant', 'retired', { archived: true })], ENDED);

    expect(screen.getByTestId('chat-transcript-empty')).toBeInTheDocument();
    expect(toggle()).toBeNull();
    expect(banner()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The count
// ---------------------------------------------------------------------------

describe('[#2445] the count describes the messages in the fold', () => {
  it('counts saved user, assistant and approval rows — not chips, not pairs', () => {
    // Four saved messages, of which two approvals collapse into ONE chip row.
    // A count taken off `rows.length` would say 3; off the pairs, 2.
    renderTranscript(
      [
        msg('u1', 'user'),
        approval('p1'),
        approval('p2'),
        msg('a1', 'assistant'),
      ],
      ENDED,
    );

    expect(toggle()).toHaveAttribute('data-count', '4');
  });

  it('counts neither archived rows nor a send in flight', () => {
    renderTranscript(
      [
        msg('old', 'assistant', 'retired', { archived: true }),
        msg('u1', 'user'),
        msg('a1', 'assistant'),
        msg('p1', 'user', 'just sent', { optimisticState: 'sending' }),
      ],
      ENDED,
    );

    expect(toggle()).toHaveAttribute('data-count', '2');
  });
});

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

describe('[#2445] opening the fold', () => {
  it('shows the rows dimmed, and hides them again when closed', () => {
    renderTranscript(TWO_TURNS, ENDED);

    fireEvent.click(toggle()!);
    expect(row('u1')).not.toBeNull();
    expect(foldedWrapperOf('u1')?.className).toContain('opacity-60');
    expect(foldedWrapperOf('a1')?.className).toContain('opacity-60');

    fireEvent.click(toggle()!);
    expect(row('u1')).toBeNull();
  });

  it('does not fake `archived` on the message to get the dimming', () => {
    // The Issue forbids it explicitly: `archived` is a database fact, and the
    // bubble hands the message object to every action on the row. The dimming
    // is a wrapper; the bubble itself must stay undimmed.
    renderTranscript(TWO_TURNS, ENDED);
    fireEvent.click(toggle()!);

    expect(row('u1')!.className).not.toContain('opacity-60');
    expect(foldedWrapperOf('u1')).not.toBeNull();
  });

  it('leaves the rows outside the fold undimmed', () => {
    renderTranscript(
      [...TWO_TURNS, msg('p1', 'user', 'just sent', { optimisticState: 'sending' })],
      ENDED,
    );
    fireEvent.click(toggle()!);

    expect(foldedWrapperOf('a1')).not.toBeNull();
    expect(foldedWrapperOf('p1')).toBeNull();
  });

  it('names a region that exists, and names a different one per split', () => {
    const { unmount } = renderTranscript(TWO_TURNS, { ...ENDED, splitIndex: 0 });
    const first = toggle()!;
    expect(first).toHaveAttribute('aria-expanded', 'false');
    const regionId = first.getAttribute('aria-controls')!;
    expect(regionId).toBe(chatPreviousSessionRegionId(0));
    expect(document.getElementById(regionId)).not.toBeNull();

    fireEvent.click(first);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    unmount();

    renderTranscript(TWO_TURNS, { ...ENDED, splitIndex: 2 });
    expect(toggle()!.getAttribute('aria-controls')).toBe(chatPreviousSessionRegionId(2));
    expect(chatPreviousSessionRegionId(0)).not.toBe(chatPreviousSessionRegionId(2));
  });

  it('is operable from the keyboard', () => {
    // A `<button>`, so Enter/Space are the browser's job — what this checks is
    // that the control IS a button and is reachable, rather than a div with an
    // onClick that a keyboard user cannot reach at all.
    renderTranscript(TWO_TURNS, ENDED);
    const button = toggle()!;

    expect(button.tagName).toBe('BUTTON');
    button.focus();
    expect(document.activeElement).toBe(button);
  });
});

// ---------------------------------------------------------------------------
// Closing again on its own
// ---------------------------------------------------------------------------

describe('[#2445] the fold re-closes rather than remembering', () => {
  it('is closed again the next time the pane dies', () => {
    const { rerender } = renderTranscript(TWO_TURNS, ENDED);
    fireEvent.click(toggle()!);
    expect(row('u1')).not.toBeNull();

    const render2 = (ended: boolean) =>
      rerender(
        <ChatTranscript
          messages={TWO_TURNS}
          worktreeId={WORKTREE_ID}
          cliToolId="claude"
          instanceId="claude"
          sessionEnded={ended}
        />,
      );

    render2(false);
    expect(toggle()).toBeNull();
    render2(true);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(row('u1')).toBeNull();
  });

  it('is closed again when the column switches instance', () => {
    const { rerender } = renderTranscript(TWO_TURNS, ENDED);
    fireEvent.click(toggle()!);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <ChatTranscript
        messages={TWO_TURNS}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude-2"
        sessionEnded
      />,
    );

    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });
});

// ---------------------------------------------------------------------------
// The session coming back
// ---------------------------------------------------------------------------

describe('[#2445] a session coming back withdraws the whole presentation', () => {
  it('drops the fold and the banner and shows every row again', () => {
    const { rerender } = renderTranscript(TWO_TURNS, ENDED);
    expect(banner()).not.toBeNull();

    rerender(
      <ChatTranscript
        messages={TWO_TURNS}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        sessionEnded={false}
      />,
    );

    expect(toggle()).toBeNull();
    expect(banner()).toBeNull();
    expect(row('u1')).not.toBeNull();
    expect(row('a1')).not.toBeNull();
  });

  it('keeps a row the reader sent to the dead pane OUT of the fold when its server echo arrives first', () => {
    // The ordering the Issue asks for by name: the send's saved row lands while
    // `isRunning` is still observed false. A "previous = every non-optimistic
    // row" rule would fold the message the reader just sent into a closed group
    // — i.e. make it vanish — which is why the classification is a SNAPSHOT of
    // the ids that were there when the pane was first seen dead.
    const { rerender } = renderTranscript(TWO_TURNS, ENDED);
    expect(toggle()).toHaveAttribute('data-count', '2');

    const pending = msg('temp-1', 'user', 'restart please', { optimisticState: 'sending' });
    const withPending = [...TWO_TURNS, pending];
    const rerenderWith = (messages: ChatMessage[]) =>
      rerender(
        <ChatTranscript
          messages={messages}
          worktreeId={WORKTREE_ID}
          cliToolId="claude"
          instanceId="claude"
          sessionEnded
        />,
      );

    rerenderWith(withPending);
    expect(row('temp-1')).not.toBeNull();
    expect(toggle()).toHaveAttribute('data-count', '2');

    // The echo: a different id, no `optimisticState`, the pending bubble gone.
    rerenderWith([...TWO_TURNS, msg('srv-9', 'user', 'restart please')]);

    expect(row('srv-9')).not.toBeNull();
    expect(foldedWrapperOf('srv-9')).toBeNull();
    expect(toggle()).toHaveAttribute('data-count', '2');
  });

  it('does not lose or duplicate the pending bubble when the running flag arrives first', () => {
    const { rerender } = renderTranscript(TWO_TURNS, ENDED);
    const pending = msg('temp-1', 'user', 'restart please', { optimisticState: 'sending' });

    // `isRunning` back before the refetch: the fold goes, the bubble stays.
    rerender(
      <ChatTranscript
        messages={[...TWO_TURNS, pending]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        sessionEnded={false}
      />,
    );

    expect(toggle()).toBeNull();
    expect(document.querySelectorAll('[data-row-message-id="temp-1"]')).toHaveLength(1);
  });

  it('keeps a failed send outside the fold, with its retry and discard reachable', () => {
    const onRetryPending = vi.fn();
    const onDiscardPending = vi.fn();
    renderTranscript(
      [...TWO_TURNS, msg('temp-1', 'user', 'restart please', { optimisticState: 'error' })],
      { ...ENDED, onRetryPending, onDiscardPending },
    );

    expect(foldedWrapperOf('temp-1')).toBeNull();
    fireEvent.click(within(row('temp-1')!).getByTestId('chat-pending-retry'));
    expect(onRetryPending).toHaveBeenCalledWith('temp-1');
    fireEvent.click(within(row('temp-1')!).getByTestId('chat-pending-discard'));
    expect(onDiscardPending).toHaveBeenCalledWith('temp-1');
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('[#2445] a closed fold is not searchable', () => {
  const HAYSTACK = [
    msg('u1', 'user', 'the sentinel was here'),
    msg('a1', 'assistant', 'and a sentinel here too'),
  ];

  /** The bar's own counter — `0/0`, `1/2`, … — not a count derived in the test. */
  function counter(): HTMLElement {
    return within(screen.getByRole('search')).getByRole('status');
  }

  function search(query: string) {
    fireEvent.click(screen.getByTestId('chat-transcript-search-toggle'));
    fireEvent.change(screen.getByLabelText('worktree.history.search.keywordLabel'), {
      target: { value: query },
    });
  }

  it('reports no matches while the fold is closed, and finds them once it is open', async () => {
    renderTranscript(HAYSTACK, ENDED);
    search('sentinel');
    // The count the bar reports, not just "the row is absent": a fold that
    // searched its hidden rows would say 1/2 and then have nowhere to jump.
    await waitFor(() => expect(counter().textContent).toBe('0/0'));

    fireEvent.click(toggle()!);
    await waitFor(() => expect(counter().textContent).toBe('1/2'));
  });

  it('recomputes the count back to zero when the fold is closed again', async () => {
    // The current match cannot be left pointing at a row that has just been
    // unmounted, which is what this asserts from the outside.
    renderTranscript(HAYSTACK, ENDED);
    fireEvent.click(toggle()!);
    search('sentinel');
    await waitFor(() => expect(counter().textContent).toBe('1/2'));

    fireEvent.click(toggle()!);
    await waitFor(() => expect(counter().textContent).toBe('0/0'));
    expect(row('u1')).toBeNull();
  });

  it('still searches a live transcript', async () => {
    // The control: none of the above is "search is broken on this surface".
    renderTranscript(HAYSTACK);
    search('sentinel');
    await waitFor(() => expect(counter().textContent).toBe('1/2'));
  });

  it('still searches a row that ARRIVED after the pane was seen dead', async () => {
    // The row has to arrive after the snapshot, not merely be non-optimistic:
    // everything present when the verdict landed is previous by definition.
    const { rerender } = renderTranscript(HAYSTACK, ENDED);
    rerender(
      <ChatTranscript
        messages={[...HAYSTACK, msg('srv-9', 'user', 'one more sentinel')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        sessionEnded
      />,
    );
    search('sentinel');

    // Exactly the one row outside the fold, and neither of the two inside it.
    await waitFor(() => expect(counter().textContent).toBe('1/1'));
    expect(foldedWrapperOf('srv-9')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The live tail
// ---------------------------------------------------------------------------

describe('[#2445] the banner is the last thing in the column', () => {
  it('sits after the rows outside the fold', () => {
    renderTranscript(
      [...TWO_TURNS, msg('temp-1', 'user', 'restart please', { optimisticState: 'sending' })],
      ENDED,
    );

    const position = banner()!.compareDocumentPosition(row('temp-1')!);
    // eslint-disable-next-line no-bitwise
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('survives a fold long enough to be cut off by the #1123 fallback', () => {
    // The fallback renders the first 40 rows only. A banner written as row 41+
    // would silently disappear on exactly the transcripts this Issue is about.
    const many = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user'));
    renderTranscript(many, ENDED);
    fireEvent.click(toggle()!);

    expect(banner()).not.toBeNull();
    expect(toggle()).toHaveAttribute('data-count', '60');
  });
});
