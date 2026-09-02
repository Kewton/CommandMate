/**
 * What Issue #2233 owes the reader who has scrolled up.
 *
 * The Issue asks for two things that one element cannot both do:
 *
 *   (a) completing a turn must not move the reply, so the in-flight bubble has
 *       to be at the END of the scrolled content, where its settled row will be;
 *   (b) "still generating" must stay visible while the reader scrolls up, which
 *       needs an element fixed to the viewport.
 *
 * (a) wins, because #2194's actual reason for the footer was that a virtualized
 * row is UNMOUNTED — it leaves the DOM — not merely that it can scroll out of
 * sight. `ChatTranscript-live-turn-2233.test.tsx` is the guard for that.
 *
 * This file is the price of that choice being paid rather than ignored: the
 * jump-to-latest chip — already the surface's "there is something below you"
 * control, already floating over the transcript's bottom edge — carries the
 * spinner and says so in its accessible name for as long as a turn is running
 * and the reader is not at the end. Without it, scrolling up during a long reply
 * leaves the surface saying nothing at all about the turn, which is the exact
 * failure #2194 built the footer to prevent.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({
    messages,
    liveTurn,
  }: {
    messages: Array<{ id: string }>;
    liveTurn?: { body?: string } | null;
  }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container">
        {liveTurn && <div data-testid="chat-transcript-live-turn">{liveTurn.body ?? ''}</div>}
      </div>
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

const realtime = {
  connected: true,
  listeners: new Set<(event: unknown) => void>(),
};

vi.mock('@/hooks/useRealtimeConnection', () => ({
  useRealtime: () => ({
    status: realtime.connected ? 'connected' : 'disconnected',
    connected: realtime.connected,
    subscribe: () => {},
    unsubscribe: () => {},
    addListener: (listener: (event: unknown) => void) => {
      realtime.listeners.add(listener);
      return () => realtime.listeners.delete(listener);
    },
  }),
}));

import { ChatSurface } from '@/components/worktree/ChatSurface';
import { CHAT_TURN_PROGRESS_EVENT_TYPE } from '@/lib/realtime/types';

const WORKTREE_ID = 'wt-2233-chip';
const TURN_KEY = 'claude-turn:u-1';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-02T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

/** Movable scroll metrics; jsdom performs no layout of its own. */
function stubScroll(
  el: HTMLElement,
  { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number },
): { get scrollTop(): number } {
  let top = scrollTop;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
  return {
    get scrollTop() {
      return top;
    },
  };
}

function push(frame: Record<string, unknown> = {}): void {
  act(() => {
    realtime.listeners.forEach((listener) =>
      listener({
        type: CHAT_TURN_PROGRESS_EVENT_TYPE,
        worktreeId: WORKTREE_ID,
        cliToolId: 'claude',
        instanceId: 'claude',
        turnKey: TURN_KEY,
        body: 'The reply so far.',
        partial: false,
        version: 1,
        ...frame,
      }),
    );
  });
}

function renderSurface(isRunning: boolean) {
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      instanceId="claude"
      live={{ isRunning }}
      onSurfaceModeChange={vi.fn()}
    />,
  );
}

/** Put the reader partway up the transcript, the way a real scroll would. */
function scrollUp(): { get scrollTop(): number } {
  const container = screen.getByTestId('chat-transcript-scroll-container');
  const scroll = stubScroll(container, { scrollHeight: 4000, clientHeight: 400, scrollTop: 0 });
  fireEvent.scroll(container);
  return scroll;
}

function chip(): HTMLElement | null {
  return screen.queryByTestId('chat-surface-new-messages');
}

beforeEach(() => {
  realtime.connected = true;
  realtime.listeners.clear();
});

describe('[#2233] the jump-to-latest chip while a turn is live', () => {
  it('appears the moment the reader scrolls away from a running turn', () => {
    // No new MESSAGE has arrived — the old chip condition — so without this the
    // surface says nothing at all about the turn once the bubble scrolls off.
    renderSurface(true);
    expect(chip()).toBeNull();

    scrollUp();

    expect(chip()).toBeInTheDocument();
    expect(chip()).toHaveAttribute('data-generating', 'true');
  });

  it('says in its accessible name that the turn is still running', () => {
    // A spinner alone is `aria-hidden`, so a screen reader would hear the same
    // "Jump to latest" it hears when the session is idle.
    renderSurface(true);
    scrollUp();

    expect(chip()).toHaveAttribute('aria-label', 'worktree.chatSurface.jumpToLatestGenerating');
  });

  it('stays down while the reader is still at the end', () => {
    // The bubble itself is on screen there. A chip on top of it is chrome
    // covering the thing it is advertising.
    renderSurface(true);
    const container = screen.getByTestId('chat-transcript-scroll-container');
    stubScroll(container, { scrollHeight: 4000, clientHeight: 400, scrollTop: 3600 });
    fireEvent.scroll(container);

    expect(chip()).toBeNull();
  });

  it('stays down while nothing is running, however far up the reader is', () => {
    renderSurface(false);
    scrollUp();

    expect(chip()).toBeNull();
  });

  it('does not claim a turn is running once the session stops', () => {
    const { rerender } = renderSurface(true);
    scrollUp();
    expect(chip()).toHaveAttribute('data-generating', 'true');

    rerender(
      <ChatSurface
        messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        live={{ isRunning: false }}
        onSurfaceModeChange={vi.fn()}
      />,
    );

    expect(chip()).toBeNull();
  });

  it('takes the reader back to the live bubble when pressed', () => {
    renderSurface(true);
    const scroll = scrollUp();

    fireEvent.click(chip() as HTMLElement);

    expect(scroll.scrollTop).toBe(4000);
    expect(chip()).toBeNull();
  });
});

describe('[#2233] following the live bubble as it grows', () => {
  it('keeps a pinned reader at the end as the body arrives', () => {
    // The bubble grows inside the scroll region now, so the follow that used to
    // compensate for a footer strip taking height has to compensate for the
    // content itself getting taller.
    renderSurface(true);
    const container = screen.getByTestId('chat-transcript-scroll-container');
    const scroll = stubScroll(container, { scrollHeight: 4000, clientHeight: 400, scrollTop: 3600 });
    fireEvent.scroll(container);

    push();

    expect(scroll.scrollTop).toBe(4000);
  });

  it('leaves a reader who scrolled up exactly where they are', () => {
    renderSurface(true);
    const scroll = scrollUp();

    push();

    expect(scroll.scrollTop).toBe(0);
  });
});
