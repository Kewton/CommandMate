/**
 * The held bubble, drawn (Issue #2248).
 *
 * `ChatSurface-settling-2248.test.tsx` pins the decision — when a body is held
 * and when the hold ends. This file pins the only two things that decision is
 * worth anything for on screen, against the real component:
 *
 *  1. **It says nothing is running.** No spinner, no `chatSurface.generating`,
 *     no `chatSurface.thinking`. Issue #2238 was opened because this surface
 *     claimed to be responding when it was not, and a hold is the exact state
 *     where re-introducing that claim would be a regression rather than a
 *     cosmetic slip. What it says instead is one quiet line.
 *  2. **Nothing else changes.** Same row class, same bubble class, same Markdown
 *     body class, same position in the same column — compared class string
 *     against class string with the live bubble, not eyeballed. That is Issue
 *     #2233's rule (a turn ending must not move a paragraph or restyle it) and
 *     a hold inherits it, because the reader watches the swap happen twice now:
 *     live → held, held → saved row.
 *
 * `data-settling="true"` is the machine-readable half, for the real screen and
 * for E2E. `data-turn-key` / `data-version` were already published by #2233 and
 * have to survive, because they are how a hold is matched to the row that ends
 * it.
 *
 * The mutation this file is the guard for: draw the held state with
 * `ChatLiveTurnBubble` (i.e. give it back the spinner) and the first describe
 * goes red; change either bubble's classes without changing the other's and the
 * parity describe goes red.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import { ChatTranscript, type ChatTranscriptLiveTurn } from '@/components/worktree/ChatTranscript';
import {
  CHAT_BUBBLE_ASSISTANT_CLASS,
  CHAT_BUBBLE_MARKDOWN_BODY_CLASS,
  CHAT_BUBBLE_ROW_CLASS,
  CHAT_BUBBLE_TESTID,
} from '@/components/worktree/ChatMessageBubble';

const WORKTREE_ID = 'wt-2248';
const TURN_KEY = 'claude-turn:u-1';
const BODY = 'The reply so far.';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `message body ${id}`,
    timestamp: new Date(Date.UTC(2026, 8, 3, 10, 0, 0)),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

const MESSAGES = [msg('m-0', 'user')];

const LIVE: ChatTranscriptLiveTurn = {
  turnKey: TURN_KEY,
  version: 3,
  body: BODY,
  partial: false,
  isThinking: false,
};

const HELD: ChatTranscriptLiveTurn = { ...LIVE, isThinking: false, settling: true };

function renderTranscript(liveTurn: ChatTranscriptLiveTurn) {
  return render(
    <ChatTranscript
      messages={MESSAGES}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      liveTurn={liveTurn}
      onFilePathClick={vi.fn()}
    />,
  );
}

function liveRow(): HTMLElement {
  return screen.getByTestId('chat-live-turn');
}

/** The bubble box inside the live-turn row — the same probe `#2233` uses. */
function bubbleIn(row: HTMLElement): HTMLElement {
  // [#2284] Found by testid, not by `[class*="rounded-2xl"]`: the assistant's
  // half is no longer a rounded box, and what this probe wants is the element
  // wearing the role's presentation whatever that presentation currently is.
  const bubble = row.querySelector<HTMLElement>(`[data-testid="${CHAT_BUBBLE_TESTID}"]`);
  expect(bubble, 'row has a bubble').not.toBeNull();
  return bubble!;
}

describe('[#2248] a held body claims nothing is running', () => {
  it('marks the row as held', () => {
    renderTranscript(HELD);

    expect(liveRow()).toHaveAttribute('data-settling', 'true');
  });

  it('leaves the mark off a turn that really is generating', () => {
    renderTranscript(LIVE);

    expect(liveRow()).not.toHaveAttribute('data-settling');
  });

  it('drops the spinner row entirely', () => {
    renderTranscript(HELD);

    expect(screen.queryByTestId('chat-live-turn-indicator')).toBeNull();
    expect(liveRow().querySelector('.animate-spin')).toBeNull();
  });

  it('says neither "Responding…" nor "Thinking…"', () => {
    renderTranscript(HELD);

    expect(liveRow().textContent).not.toContain('worktree.chatSurface.generating');
    expect(liveRow().textContent).not.toContain('worktree.chatSurface.thinking');
  });

  it('ignores a thinking flag that reached it anyway', () => {
    // Defence in depth: `ChatSurface` already strips it, and a held body must
    // not be able to paint "Thinking…" even if a caller forgets.
    renderTranscript({ ...HELD, isThinking: true });

    expect(liveRow().textContent).not.toContain('worktree.chatSurface.thinking');
  });

  it('says the body is not saved yet, once', () => {
    renderTranscript(HELD);

    const note = screen.getByTestId('chat-settling-turn-note');
    expect(note.textContent).toBe('worktree.chatSurface.settling');
  });

  it('still carries the caveat when the body starts mid-turn', () => {
    renderTranscript({ ...HELD, partial: true });

    expect(screen.getByTestId('chat-live-turn-partial').textContent).toBe(
      'worktree.chatSurface.progressPartial',
    );
  });

  it('names the row for a screen reader without claiming a live turn', () => {
    renderTranscript(HELD);

    expect(liveRow()).toHaveAttribute('aria-label', 'worktree.chatSurface.settlingLabel');
  });
});

describe('[#2248] the keys the hold is matched on survive', () => {
  it('publishes the turn key and the version', () => {
    renderTranscript(HELD);

    expect(liveRow()).toHaveAttribute('data-turn-key', TURN_KEY);
    expect(liveRow()).toHaveAttribute('data-version', '3');
  });

  it('reports that it has a body', () => {
    renderTranscript(HELD);

    expect(liveRow()).toHaveAttribute('data-has-body', 'true');
    expect(liveRow()).toHaveAttribute('data-role', 'assistant');
  });

  it('renders the body through the Markdown path, as the live bubble does', () => {
    renderTranscript(HELD);

    const body = screen.getByTestId('chat-live-turn-body');
    expect(body).toHaveAttribute('data-markdown', 'true');
    expect(body.textContent).toContain(BODY);
  });
});

describe('[#2248] held and live are the same bubble', () => {
  /** Render one state, read its class strings, unmount. */
  function classesOf(liveTurn: ChatTranscriptLiveTurn) {
    const { unmount } = renderTranscript(liveTurn);
    const row = liveRow();
    const shape = {
      row: row.className,
      bubble: bubbleIn(row).className,
      body: screen.getByTestId('chat-live-turn-body').className,
    };
    unmount();
    return shape;
  }

  it('wears identical row, bubble and body classes', () => {
    // Not "similar": string equality, so a change to one that is not a change
    // to the other fails here instead of showing up as a jerk on screen when a
    // turn ends.
    expect(classesOf(HELD)).toEqual(classesOf(LIVE));
  });

  it('wears the shared constants rather than copies of them', () => {
    const held = classesOf(HELD);

    expect(held.row).toBe(CHAT_BUBBLE_ROW_CLASS);
    expect(held.bubble).toBe(CHAT_BUBBLE_ASSISTANT_CLASS);
    expect(held.body).toBe(CHAT_BUBBLE_MARKDOWN_BODY_CLASS);
  });

  it('sits in the same place: inside the scroll region, after the rows', () => {
    renderTranscript(HELD);

    const scroll = screen.getByTestId('chat-transcript-scroll-container');
    expect(scroll.contains(liveRow())).toBe(true);
    expect(scroll.lastElementChild).toBe(liveRow());
  });
});
