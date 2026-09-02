/**
 * What "the agent is generating" is read from (Issue #2238).
 *
 * The defect this file is the guard for: the chat surface gated its in-flight
 * bubble on `live.isRunning`, and `isRunning` does not mean what its name and
 * its old doc comment ("The session is generating.") say. It is
 * `hasSession() + isSessionHealthy()` — *a healthy tmux session exists* — so on
 * every worktree with a live pane the surface said "Responding…" forever:
 * after the reply had settled into the transcript, with no `esc to interrupt`
 * on the pane, across a full page reload. Not a stuck frame; a permanent one.
 *
 * The codebase already knew the difference. `current-output-builder.ts` gates
 * the progress publisher on `payload.isRunning && payload.sessionStatus ===
 * 'running'` and says so in a comment. The producer used the merged verdict and
 * the consumer used the session flag, and only the consumer was wrong.
 *
 * So the property here is one sentence, asserted from both directions:
 * **`sessionStatus === 'running'` decides, and `isRunning` decides nothing.**
 * Every case below therefore holds `isRunning: true` — an idle agent still has
 * a session, which is exactly why the old gate could not tell the two apart.
 *
 * Value domain for `sessionStatus` is `SessionStatus` in
 * `@/lib/detection/status-detector`: `'idle' | 'ready' | 'running' | 'waiting'`.
 * `'ready'` — idle at the composer — is the state the bug was reported in.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

interface StubLiveTurn {
  turnKey?: string;
  body?: string;
  isThinking?: boolean;
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
            data-thinking={liveTurn.isThinking ? 'true' : 'false'}
          >
            {liveTurn.body ?? ''}
          </div>
        )}
      </div>
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

/**
 * The realtime seam.
 *
 * `listeners` is read directly as well as fired: `useChatTurnProgress` is the
 * ONLY consumer of `useRealtime` under this surface (`ChatTranscript` is
 * stubbed), so the size of this set is a direct reading of that hook's
 * `enabled` — the subscription criterion, stated without inferring it from what
 * happens to be painted.
 */
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

const WORKTREE_ID = 'wt-2238';
const TURN_KEY = 'claude-md:u-1';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-02T19:30:42Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

/**
 * The conversation as the UAT left it: the user's message and the assistant's
 * settled 643-character reply. Nothing is pending and nothing is in flight —
 * the turn is over — and the surface kept claiming otherwise.
 */
const SETTLED_CONVERSATION = [msg('u1', 'user'), msg('a1', 'assistant')];

function surface(live: ChatSurfaceLiveState, messages = SETTLED_CONVERSATION) {
  return (
    <ChatSurface
      messages={messages}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      instanceId="claude"
      live={live}
      onSurfaceModeChange={vi.fn()}
    />
  );
}

function pushProgress(overrides: Record<string, unknown> = {}): void {
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

describe('[#2238] the generating bubble is gated on sessionStatus, not isRunning', () => {
  it.each(['ready', 'idle', 'waiting'])(
    'draws nothing live for a healthy session sitting at %s',
    (sessionStatus) => {
      // `isRunning: true` throughout: the session is up and healthy, which is
      // the ONLY thing that flag has ever meant. Under the old gate every one
      // of these rendered "Responding…" over a finished conversation.
      render(surface({ isRunning: true, sessionStatus }));

      expect(liveTurn()).toBeNull();
    },
  );

  it('draws the live bubble while the turn is generating', () => {
    render(surface({ isRunning: true, sessionStatus: 'running' }));

    expect(liveTurn()).toBeInTheDocument();
  });

  it('forwards the thinking wording while generating, as before', () => {
    // #2233's bubble is unchanged by this Issue — only what turns it on is.
    render(surface({ isRunning: true, sessionStatus: 'running', isThinking: true }));

    expect(liveTurn()).toHaveAttribute('data-thinking', 'true');
  });

  it('drops the bubble the moment the turn finishes, session still up', () => {
    // The reported sequence, end to end: a turn runs, the agent returns to its
    // prompt, the tmux session stays healthy because nobody killed it.
    const { rerender } = render(surface({ isRunning: true, sessionStatus: 'running' }));
    expect(liveTurn()).toBeInTheDocument();

    rerender(surface({ isRunning: true, sessionStatus: 'ready' }));

    expect(liveTurn()).toBeNull();
  });

  it('does not resurrect the bubble when only isRunning is true', () => {
    // The guard against a partial revert: restoring `isRunning` to the gate as
    // an OR would pass every test above except this one.
    render(surface({ isRunning: true }));

    expect(liveTurn()).toBeNull();
  });
});

describe('[#2238] the progress subscription follows the same verdict', () => {
  it('opens no subscription while the session is merely alive', () => {
    render(surface({ isRunning: true, sessionStatus: 'ready' }));

    expect(realtime.listeners.size).toBe(0);
  });

  it('opens one while the turn is generating', () => {
    render(surface({ isRunning: true, sessionStatus: 'running' }));

    expect(realtime.listeners.size).toBe(1);
  });

  it('closes it again when the turn ends', () => {
    const { rerender } = render(surface({ isRunning: true, sessionStatus: 'running' }));
    expect(realtime.listeners.size).toBe(1);

    rerender(surface({ isRunning: true, sessionStatus: 'ready' }));

    expect(realtime.listeners.size).toBe(0);
  });

  it('renders no body from a frame that arrives while the pane is idle', () => {
    // Belt and braces for the subscription assertions above: even if a frame
    // reached the room (a sibling's server, a late flush), an idle surface has
    // nothing to paint it into.
    render(surface({ isRunning: true, sessionStatus: 'ready' }));

    pushProgress();

    expect(liveTurn()).toBeNull();
  });

  it('holds nothing across an idle gap, so the next turn starts empty', () => {
    // Why this is the discriminating test for `enabled` rather than for the
    // bubble gate: the hook CLEARS on disable (#2199 rule 3). A body pushed
    // while the pane was idle must therefore be absent when it next generates
    // — a bubble showing "The reply so far." here would mean the subscription
    // had stayed open through the idle stretch.
    const { rerender } = render(surface({ isRunning: true, sessionStatus: 'ready' }));
    pushProgress();

    rerender(surface({ isRunning: true, sessionStatus: 'running' }));

    expect(liveTurn()).toBeInTheDocument();
    expect(liveTurn()?.textContent).toBe('');
  });

  it('paints the body pushed while it really is generating', () => {
    render(surface({ isRunning: true, sessionStatus: 'running' }));

    pushProgress();

    expect(liveTurn()?.textContent).toContain('The reply so far.');
    expect(liveTurn()).toHaveAttribute('data-turn-key', TURN_KEY);
  });
});

describe('[#2238] the jump-to-latest chip tells the same story', () => {
  /** Put the reader partway up; jsdom performs no layout of its own. */
  function scrollUp(): void {
    const container = screen.getByTestId('chat-transcript-scroll-container');
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => 4000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, get: () => 0, set: () => {} });
    fireEvent.scroll(container);
  }

  it('wears the spinner only while the turn is generating', () => {
    // #2233 put "still running, below you" on the chip. Gated on the same
    // verdict, so scrolling up on an idle pane cannot claim a running turn.
    render(surface({ isRunning: true, sessionStatus: 'running' }));
    scrollUp();

    const chip = screen.getByTestId('chat-surface-new-messages');
    expect(chip).toHaveAttribute('data-generating', 'true');
    expect(chip).toHaveAttribute('aria-label', 'worktree.chatSurface.jumpToLatestGenerating');
  });

  it('stays down entirely on an idle pane with nothing new below', () => {
    render(surface({ isRunning: true, sessionStatus: 'ready' }));
    scrollUp();

    expect(screen.queryByTestId('chat-surface-new-messages')).toBeNull();
  });
});
