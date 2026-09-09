/**
 * "There is no session behind these rows" (Issue #2445).
 *
 * The surface owns ONE reading of that, {@link isChatSessionEnded}, and hands
 * the verdict down. This file pins both halves of it:
 *
 *  1. **the predicate**, as a truth table. Two explicit `false`s and nothing
 *     else counts — `undefined` on either field is "nobody said", which is the
 *     value a pane that has not polled yet and a caller that has not copied the
 *     field across both produce. Reading either as "dead" would flash the fold
 *     and the ended banner across every page load and every instance switch;
 *  2. **what the surface does with it**: the verdict reaches `ChatTranscript`,
 *     and no live tail is drawn while it holds.
 *
 * (2)'s in-flight half is the one that could not be left to chance. Issue
 * #2248's held body outlives the turn that produced it on purpose, so a session
 * dying mid-hold would leave a paragraph under the reader reading as an answer
 * still being written — and the hold is released by `enabled` RISING, so a
 * session coming back must not bring the previous instance's bubble with it.
 *
 * The transcript is stubbed here (this is a test about what the surface
 * DECIDES); the fold and the banner it decides for are asserted against the
 * real component in `ChatTranscript-previous-session-2445.test.tsx` and through
 * the two real wirings in the pane suites.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

interface StubLiveTurn {
  turnKey?: string;
  body?: string;
  isThinking?: boolean;
  settling?: boolean;
}

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({
    messages,
    liveTurn,
    sessionEnded,
  }: {
    messages: Array<{ id: string }>;
    liveTurn?: StubLiveTurn | null;
    sessionEnded?: boolean;
  }) => (
    <div
      data-testid="chat-transcript"
      data-message-count={String(messages.length)}
      data-session-ended={sessionEnded === undefined ? 'unset' : String(sessionEnded)}
    >
      <div data-testid="chat-transcript-scroll-container">
        {liveTurn && (
          <div
            data-testid="chat-transcript-live-turn"
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

import {
  ChatSurface,
  isChatSessionEnded,
  type ChatSurfaceLiveState,
} from '@/components/worktree/ChatSurface';
import { CHAT_TURN_PROGRESS_EVENT_TYPE } from '@/lib/realtime/types';

const WORKTREE_ID = 'wt-2445-surface';
const TURN_KEY = 'claude-md:u-1';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-09T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

const CONVERSATION = [msg('u1', 'user'), msg('a1', 'assistant')];

function surface(live: ChatSurfaceLiveState) {
  return (
    <ChatSurface
      messages={CONVERSATION}
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

function endedFlag(): string | null {
  return screen.getByTestId('chat-transcript').getAttribute('data-session-ended');
}

function liveTurn(): HTMLElement | null {
  return screen.queryByTestId('chat-transcript-live-turn');
}

beforeEach(() => {
  realtime.connected = true;
  realtime.listeners.clear();
});

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

describe('[#2445] isChatSessionEnded needs two explicit answers', () => {
  it('is true only for attaching:false + isRunning:false', () => {
    expect(isChatSessionEnded({ attaching: false, isRunning: false })).toBe(true);
  });

  it.each<[string, ChatSurfaceLiveState]>([
    ['the pane has not polled yet', { attaching: true, isRunning: false }],
    ['the session is up', { attaching: false, isRunning: true }],
    ['nobody said whether it is attaching', { isRunning: false }],
    ['nobody said whether it is running', { attaching: false }],
    ['nobody said anything at all', {}],
  ])('is false when %s', (_why, live) => {
    expect(isChatSessionEnded(live)).toBe(false);
  });

  it.each(['idle', 'ready', 'waiting', 'running'])(
    'ignores sessionStatus %s entirely',
    (sessionStatus) => {
      // #2238's distinction, kept: those four are states of a session that
      // EXISTS. Only `isRunning` answers whether one exists at all.
      expect(isChatSessionEnded({ attaching: false, isRunning: true, sessionStatus })).toBe(false);
      expect(isChatSessionEnded({ attaching: false, isRunning: false, sessionStatus })).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// The verdict reaching the transcript
// ---------------------------------------------------------------------------

describe('[#2445] the surface hands the verdict to the transcript', () => {
  it('forwards true for an observed-dead pane', () => {
    render(surface({ attaching: false, isRunning: false, sessionStatus: 'idle' }));
    expect(endedFlag()).toBe('true');
  });

  it('forwards false while the pane is attaching', () => {
    render(surface({ attaching: true, isRunning: false }));
    expect(endedFlag()).toBe('false');
  });

  it('forwards false for a caller that has not copied `attaching` across', () => {
    // Every pre-#2445 caller. The surface degrades to its old behaviour rather
    // than announcing an ended session on the strength of a missing field.
    render(surface({ isRunning: false, sessionStatus: 'idle' }));
    expect(endedFlag()).toBe('false');
  });

  it('forwards false while a session is up', () => {
    render(surface({ attaching: false, isRunning: true, sessionStatus: 'ready' }));
    expect(endedFlag()).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// The live tail
// ---------------------------------------------------------------------------

describe('[#2445] a dead pane draws no live tail', () => {
  it('draws the generating bubble when a session is up — the control', () => {
    render(surface({ attaching: false, isRunning: true, sessionStatus: 'running' }));
    pushProgress();

    expect(liveTurn()).toBeInTheDocument();
  });

  it('draws nothing live once the pane is observed dead', () => {
    // Defensive by construction — a dead pane publishes `sessionStatus: 'idle'`
    // — and asserted anyway, because the frame where the two disagree is
    // exactly the frame the reader would be told a dead agent is answering.
    render(surface({ attaching: false, isRunning: false, sessionStatus: 'running' }));
    pushProgress();

    expect(liveTurn()).toBeNull();
  });

  it('drops a HELD body when the session dies under it', () => {
    // #2248's hold survives the turn that made it. Without this the last
    // paragraph of the dead session would sit outside the fold, wearing the
    // "not saved yet" note, as if it were still landing.
    const { rerender } = render(
      surface({ attaching: false, isRunning: true, sessionStatus: 'running' }),
    );
    pushProgress();
    rerender(surface({ attaching: false, isRunning: true, sessionStatus: 'idle' }));
    expect(liveTurn()).toHaveAttribute('data-settling', 'true');

    rerender(surface({ attaching: false, isRunning: false, sessionStatus: 'idle' }));
    expect(liveTurn()).toBeNull();
  });

  it('does not resurrect the previous turn when a session comes back', () => {
    const { rerender } = render(
      surface({ attaching: false, isRunning: true, sessionStatus: 'running' }),
    );
    pushProgress();
    rerender(surface({ attaching: false, isRunning: false, sessionStatus: 'idle' }));
    expect(liveTurn()).toBeNull();

    // A new session, not yet generating: nothing may be shown for the turn that
    // belonged to the instance that died.
    rerender(surface({ attaching: false, isRunning: true, sessionStatus: 'ready' }));
    expect(liveTurn()).toBeNull();
  });
});
