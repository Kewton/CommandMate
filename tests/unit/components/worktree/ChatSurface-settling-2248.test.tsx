/**
 * The chat surface while a body is held (Issue #2248).
 *
 * `useChatTurnProgress-settling-2248.test.tsx` pins the hold itself; this file
 * pins what the SURFACE does with it, which is three separate promises:
 *
 *  1. **It looks like prose, not like work in progress.** No spinner, no
 *     "Responding…", no thinking wording — Issue #2238 was opened because this
 *     surface claimed to be responding when nothing was running, and a hold is
 *     precisely the state where that claim is false. The body itself does not
 *     move: same `liveTurn`, same position, same turn key.
 *  2. **It ends.** Three ways, and the surface owns two of them — the saved row
 *     for the same turn (#2199's swap, which needed no change), and a new row
 *     appended to the transcript, which is how the user's NEXT message stops the
 *     previous turn's paragraph from sitting underneath it while the poller
 *     catches up. The third, the grace period, is asserted here through the
 *     surface as well because that is where a reader would see it expire.
 *  3. **It belongs to one instance.** Two agents share a worktree room and a
 *     split can be re-pointed at either, so a hold that leaked would show one
 *     agent's reply in the other's column.
 *
 * The mutation Issue #2248 requires: restore `setProgress(null)` to the
 * `enabled` effect in the hook and the first describe below goes red.
 *
 * `ChatTranscript` is stubbed, as every `ChatSurface` unit does — what the held
 * bubble LOOKS like is `ChatTranscript-settling-2248.test.tsx`, against the real
 * component.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

interface StubLiveTurn {
  turnKey?: string;
  version?: number;
  body?: string;
  partial?: boolean;
  isThinking?: boolean;
  settling?: boolean;
}

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({
    messages,
    liveTurn,
  }: {
    messages: Array<{ id: string }>;
    liveTurn?: StubLiveTurn | null;
  }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container">
        {messages.map((m) => (
          <div key={m.id} data-message-id={m.id} />
        ))}
        {liveTurn && (
          <div
            data-testid="chat-transcript-live-turn"
            data-turn-key={liveTurn.turnKey ?? ''}
            data-version={liveTurn.version === undefined ? '' : String(liveTurn.version)}
            data-partial={liveTurn.partial ? 'true' : 'false'}
            data-thinking={liveTurn.isThinking ? 'true' : 'false'}
            data-settling={liveTurn.settling ? 'true' : 'false'}
          >
            {liveTurn.body ?? ''}
          </div>
        )}
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

import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import { CHAT_TURN_PROGRESS_EVENT_TYPE } from '@/lib/realtime/types';

const WORKTREE_ID = 'wt-2248';
const TURN_KEY = 'claude-md:u-1';
const RUNNING: ChatSurfaceLiveState = { isRunning: true, sessionStatus: 'running' };
/** The reported state: the turn is over and the tmux session is perfectly healthy. */
const STOPPED: ChatSurfaceLiveState = { isRunning: true, sessionStatus: 'ready' };

function msg(
  id: string,
  role: ChatMessage['role'],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-03T00:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

const CONVERSATION = [msg('u1', 'user')];

function surface(
  live: ChatSurfaceLiveState,
  messages: ChatMessage[] = CONVERSATION,
  instanceId = 'claude',
) {
  return (
    <ChatSurface
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      instanceId={instanceId}
      live={live}
      onSurfaceModeChange={vi.fn()}
    />
  );
}

function push(overrides: Record<string, unknown> = {}): void {
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
        done: false,
        ...overrides,
      }),
    );
  });
}

function liveTurn(): HTMLElement | null {
  return screen.queryByTestId('chat-transcript-live-turn');
}

beforeEach(() => {
  realtime.connected = true;
  realtime.listeners.clear();
});

describe('[#2248] the body survives the end of the turn', () => {
  it('is still on screen after the session stops generating', () => {
    const { rerender } = render(surface(RUNNING));
    push();
    expect(liveTurn()?.textContent).toContain('The reply so far.');

    rerender(surface(STOPPED));

    expect(liveTurn()?.textContent).toContain('The reply so far.');
  });

  it('keeps the same turn key and version, so the swap still has its join key', () => {
    const { rerender } = render(surface(RUNNING));
    push();

    rerender(surface(STOPPED));

    expect(liveTurn()).toHaveAttribute('data-turn-key', TURN_KEY);
    expect(liveTurn()).toHaveAttribute('data-version', '1');
  });

  it('publishes the hold to the transcript so it can drop the spinner', () => {
    const { rerender } = render(surface(RUNNING));
    push();
    expect(liveTurn()).toHaveAttribute('data-settling', 'false');

    rerender(surface(STOPPED));

    expect(liveTurn()).toHaveAttribute('data-settling', 'true');
  });

  it('stops forwarding the thinking wording, because nothing is thinking', () => {
    // Issue #2238 in one assertion: a stopped turn must not keep saying it is
    // working. `isThinking` is what the transcript turns into "Thinking…".
    const { rerender } = render(surface({ ...RUNNING, isThinking: true }));
    push();
    expect(liveTurn()).toHaveAttribute('data-thinking', 'true');

    rerender(surface({ ...STOPPED, isThinking: true }));

    expect(liveTurn()).toHaveAttribute('data-thinking', 'false');
  });

  it('draws exactly one live element, before and after the turn ends', () => {
    const { rerender } = render(surface(RUNNING));
    push();

    rerender(surface(STOPPED));

    expect(screen.getAllByTestId('chat-transcript-live-turn')).toHaveLength(1);
  });

  it('holds nothing on a session that never published a frame', () => {
    // The #2238 case: an idle pane with a healthy tmux session and a finished
    // conversation draws nothing at all, held or otherwise.
    const { rerender } = render(surface(RUNNING));

    rerender(surface(STOPPED));

    expect(liveTurn()).toBeNull();
  });

  it('closes the progress subscription anyway', () => {
    // The hold is a value, not a live wire: nothing is being listened for.
    const { rerender } = render(surface(RUNNING));
    push();

    rerender(surface(STOPPED));

    expect(realtime.listeners.size).toBe(0);
  });
});

describe('[#2248] release (a): the saved row lands', () => {
  it('drops the hold when the row for the same turn arrives', () => {
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));
    expect(liveTurn()).not.toBeNull();

    rerender(
      surface(STOPPED, [...CONVERSATION, msg('a1', 'assistant', { requestId: TURN_KEY })]),
    );

    expect(liveTurn()).toBeNull();
  });
});

describe('[#2248] release (b): the next turn starts', () => {
  it('drops the hold when the session starts generating again', () => {
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));

    rerender(surface(RUNNING));

    expect(liveTurn()?.textContent).toBe('');
  });

  it('drops the hold when the user’s next message is appended', () => {
    // The window this exists for: the optimistic user row lands immediately and
    // `sessionStatus` does not flip to `running` until the poller's next tick.
    // Without this the previous turn's paragraph sits UNDER the message the user
    // just sent and reads as an answer to it.
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));
    expect(liveTurn()).not.toBeNull();

    rerender(surface(STOPPED, [...CONVERSATION, msg('u2', 'user')]));

    expect(liveTurn()).toBeNull();
  });

  it('keeps the hold while the transcript is merely re-fetched unchanged', () => {
    // The same rows arriving again is a poll, not a new turn.
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));

    rerender(surface(STOPPED, [msg('u1', 'user')]));

    expect(liveTurn()?.textContent).toContain('The reply so far.');
  });

  it('re-arms for the turn after that', () => {
    // The release must not latch: a hold released by a new row has to be
    // available again once the next turn produces a body.
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));
    const withNext = [...CONVERSATION, msg('u2', 'user')];
    rerender(surface(STOPPED, withNext));
    expect(liveTurn()).toBeNull();

    rerender(surface(RUNNING, withNext));
    push({ turnKey: 'claude-md:u-2', version: 2, body: 'The second reply.' });
    rerender(surface(STOPPED, withNext));

    expect(liveTurn()?.textContent).toContain('The second reply.');
    expect(liveTurn()).toHaveAttribute('data-settling', 'true');
  });
});

describe('[#2248] release (c): the grace period', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('still shows the body just before the grace runs out', () => {
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));

    act(() => {
      vi.advanceTimersByTime(599_999);
    });

    expect(liveTurn()?.textContent).toContain('The reply so far.');
  });

  it('clears it once the grace has passed', () => {
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));

    act(() => {
      vi.advanceTimersByTime(600_000);
    });

    expect(liveTurn()).toBeNull();
  });
});

describe('[#2248] the hold does not leak between instances', () => {
  it('shows nothing when the surface is re-pointed at the sibling', () => {
    const { rerender } = render(surface(RUNNING, CONVERSATION, 'claude'));
    push();
    rerender(surface(STOPPED, CONVERSATION, 'claude'));
    expect(liveTurn()?.textContent).toContain('The reply so far.');

    rerender(surface(STOPPED, CONVERSATION, 'claude-2'));

    expect(liveTurn()).toBeNull();
  });

  it('holds nothing from a frame addressed to the sibling', () => {
    const { rerender } = render(surface(RUNNING, CONVERSATION, 'claude'));
    push({ instanceId: 'claude-2', body: 'the other agent’s reply' });

    rerender(surface(STOPPED, CONVERSATION, 'claude'));

    expect(liveTurn()).toBeNull();
  });
});

describe('[#2248] the jump-to-latest chip', () => {
  /** Put the reader partway up; jsdom performs no layout of its own. */
  function scrollUp(): void {
    const container = screen.getByTestId('chat-transcript-scroll-container');
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => 4000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: () => {},
    });
    fireEvent.scroll(container);
  }

  it('offers the way back down to a held body', () => {
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));
    scrollUp();

    expect(screen.getByTestId('chat-surface-new-messages')).toBeInTheDocument();
  });

  it('does not claim the turn is still running', () => {
    // #2233 put "still responding, below you" on this chip. A held body is not
    // a running turn, so the spinner and the accessible name go with it.
    const { rerender } = render(surface(RUNNING));
    push();
    rerender(surface(STOPPED));
    scrollUp();

    const chip = screen.getByTestId('chat-surface-new-messages');
    expect(chip).not.toHaveAttribute('data-generating');
    expect(chip).not.toHaveAttribute('aria-label');
  });
});
