/**
 * The in-flight reply on the chat surface (Issue #2199).
 *
 * #2194 gave this surface a live region and an indicator; this Issue puts the
 * reply itself in it while the turn is still running. Five properties, and each
 * one is a specific way the feature turns into a defect:
 *
 *  1. **The swap.** When the settled `chat_messages` row for the same turn
 *     arrives, the live bubble goes. Miss it and the reader sees the reply twice
 *     — once as the transcript row and once as a bubble underneath it that never
 *     clears.
 *  2. **Stale frames are dropped.** opencode re-sends boundary frames and the
 *     room is not an ordered pipe, so an older `version` arriving after a newer
 *     one is a real shape. Render it and the reply appears to shrink.
 *  3. **The frame has to be for THIS instance.** Two agents in one worktree share
 *     a room, so every frame for the sibling arrives here too.
 *  4. **Nothing live while the push connection is down.** There is no replay, so
 *     a held body would be a stale paragraph claiming to be live. The surface
 *     falls back to exactly what it showed before this Issue.
 *  5. **One indicator, not two.** The bubble carries its own spinner and the same
 *     sentence, so there is never a second "responding" row beside it.
 *
 * ## What Issue #2233 changed about this file
 *
 * The five properties above are unchanged; WHERE the reply is drawn is not. The
 * footer strip is gone — `ChatSurface` now hands the state to `ChatTranscript`
 * as `liveTurn` and the transcript draws it as the last bubble in the column.
 * So every assertion here reads the `liveTurn` the surface PUBLISHES rather than
 * the markup it used to own, which is the right seam anyway: what this file is
 * responsible for is the hook wiring, the version discipline and the swap. How
 * that state looks on screen — Markdown, `.chat-md`, `text-sm`, the bubble cap,
 * and the fact that it is not a virtualized row — is
 * `ChatTranscript-live-turn-2233.test.tsx`, against the real component.
 *
 * `ChatTranscript` is stubbed the way `ChatSurface-2194.test.tsx` stubs it — the
 * transcript is not what is under test here, and the stub is what makes the
 * scroll container present at all in a layout-less DOM.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

/**
 * The transcript stub, publishing the `liveTurn` it is handed (Issue #2233).
 *
 * Attributes rather than a rendered bubble on purpose: this file asserts what
 * the surface DECIDES, and a stub that tried to reproduce the real bubble would
 * be asserting the stub.
 */
interface StubLiveTurn {
  turnKey?: string;
  version?: number;
  body?: string;
  partial?: boolean;
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
            data-version={liveTurn.version === undefined ? '' : String(liveTurn.version)}
            data-partial={liveTurn.partial ? 'true' : 'false'}
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

/** The realtime seam, driven by hand. */
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

import { ChatSurface, isTurnSettled } from '@/components/worktree/ChatSurface';
import { CHAT_TURN_PROGRESS_EVENT_TYPE } from '@/lib/realtime/types';

const WORKTREE_ID = 'wt-2199';
const TURN_KEY = 'claude-md:u-1';
const T0 = new Date('2026-09-01T10:00:00Z');

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
    timestamp: T0,
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

function progressFrame(overrides: Record<string, unknown> = {}) {
  return {
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
  };
}

function push(frame: unknown): void {
  act(() => {
    realtime.listeners.forEach((listener) => listener(frame));
  });
}

function renderSurface(props: Partial<React.ComponentProps<typeof ChatSurface>> = {}) {
  return render(
    <ChatSurface
      messages={props.messages ?? [msg('m-1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId="claude"
      instanceId="claude"
      live={{ isRunning: true, ...(props.live ?? {}) }}
      onSurfaceModeChange={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  realtime.connected = true;
  realtime.listeners.clear();
});

function liveTurn(): HTMLElement {
  return screen.getByTestId('chat-transcript-live-turn');
}

describe('[#2199] showing the in-flight reply', () => {
  it('publishes the pushed body to the transcript', () => {
    renderSurface();
    push(progressFrame());

    expect(liveTurn().textContent).toContain('The reply so far.');
  });

  it('publishes the turn key the settled row will be matched on', () => {
    renderSurface();
    push(progressFrame());

    expect(liveTurn()).toHaveAttribute('data-turn-key', TURN_KEY);
  });

  it('grows as later frames arrive', () => {
    renderSurface();
    push(progressFrame({ version: 1, body: 'One.' }));
    push(progressFrame({ version: 2, body: 'One.\n\nTwo.' }));

    expect(liveTurn().textContent).toContain('Two.');
  });

  it('draws no footer strip of its own for it (Issue #2233)', () => {
    // The strip was where #2199 put the reply, and it is the reason completing a
    // turn moved the paragraph to a different part of the screen. Only the
    // terminal banner is left in that region, and there is no banner here.
    renderSurface();
    push(progressFrame());

    expect(screen.queryByTestId('chat-surface-live')).toBeNull();
    expect(screen.getByTestId('chat-transcript').contains(liveTurn())).toBe(true);
  });

  it('says so when the body does not start at the beginning of the turn', () => {
    renderSurface();
    push(progressFrame({ partial: true }));

    expect(liveTurn()).toHaveAttribute('data-partial', 'true');
  });

  it('says nothing of the sort when the body is whole', () => {
    renderSurface();
    push(progressFrame({ partial: false }));

    expect(liveTurn()).toHaveAttribute('data-partial', 'false');
  });

  it('forwards the thinking wording the CLI reports', () => {
    renderSurface({ live: { isRunning: true, isThinking: true } });
    push(progressFrame());

    expect(liveTurn()).toHaveAttribute('data-thinking', 'true');
  });
});

describe('[#2199] the swap', () => {
  it('drops the bubble once the settled row for the same turn is in the transcript', () => {
    const { rerender } = renderSurface();
    push(progressFrame());
    expect(liveTurn().textContent).toContain('The reply so far.');

    rerender(
      <ChatSurface
        messages={[msg('m-1', 'assistant'), msg('m-2', 'assistant', { requestId: TURN_KEY })]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        live={{ isRunning: true }}
        onSurfaceModeChange={() => {}}
      />,
    );

    // The body is gone from the live bubble — and because `isRunning` is still
    // true the bubble itself stays, now carrying nothing but the indicator, so
    // the reply is on screen exactly once.
    expect(liveTurn().textContent).toBe('');
    expect(liveTurn()).toHaveAttribute('data-turn-key', '');
    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-message-count', '2');
  });

  it('leaves nothing live at all once the settled row lands and the session stops', () => {
    const { rerender } = renderSurface();
    push(progressFrame());

    rerender(
      <ChatSurface
        messages={[msg('m-1', 'assistant'), msg('m-2', 'assistant', { requestId: TURN_KEY })]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        live={{ isRunning: false }}
        onSurfaceModeChange={() => {}}
      />,
    );

    expect(screen.queryByTestId('chat-transcript-live-turn')).toBeNull();
  });

  it('keeps the bubble when a DIFFERENT turn settles', () => {
    renderSurface({
      messages: [msg('m-1', 'assistant', { requestId: 'claude-md:u-0' })],
    });
    push(progressFrame());

    expect(liveTurn().textContent).toContain('The reply so far.');
  });

  it('isTurnSettled answers on requestId alone', () => {
    const rows = [msg('a', 'user'), msg('b', 'assistant', { requestId: TURN_KEY })];
    expect(isTurnSettled(rows, TURN_KEY)).toBe(true);
    expect(isTurnSettled(rows, 'claude-md:other')).toBe(false);
    expect(isTurnSettled([], TURN_KEY)).toBe(false);
  });
});

describe('[#2199] frames that must not be rendered', () => {
  it('ignores a frame whose version is not newer than the one on screen', () => {
    renderSurface();
    push(progressFrame({ version: 7, body: 'The newest paragraph.' }));
    push(progressFrame({ version: 3, body: 'An older, shorter one.' }));

    expect(liveTurn().textContent).toContain('The newest paragraph.');
    expect(liveTurn()).toHaveAttribute('data-version', '7');
  });

  it('ignores a byte-identical re-send of the version already rendered', () => {
    renderSurface();
    push(progressFrame({ version: 4, body: 'Once.' }));
    push(progressFrame({ version: 4, body: 'Something else entirely.' }));

    expect(liveTurn().textContent).toContain('Once.');
  });

  it('ignores a frame for a sibling instance in the same room', () => {
    renderSurface();
    push(progressFrame({ instanceId: 'claude-2', body: 'the other agent’s reply' }));

    expect(liveTurn().textContent).toBe('');
  });

  it('ignores a frame for another tool', () => {
    renderSurface();
    push(progressFrame({ cliToolId: 'opencode', instanceId: 'opencode' }));

    expect(liveTurn().textContent).toBe('');
  });

  it('ignores a frame for another worktree', () => {
    renderSurface();
    push(progressFrame({ worktreeId: 'wt-other' }));

    expect(liveTurn().textContent).toBe('');
  });

  it('ignores realtime events that are not progress frames', () => {
    renderSurface();
    push({ type: 'terminal_snapshot', worktreeId: WORKTREE_ID, version: 9 });

    expect(liveTurn().textContent).toBe('');
  });
});

describe('[#2199] falling back', () => {
  it('shows no body while the push connection is down', () => {
    renderSurface();
    push(progressFrame());
    expect(liveTurn().textContent).toContain('The reply so far.');

    realtime.connected = false;
    // Any re-render re-reads the connection; the surface re-renders on every poll.
    push(progressFrame({ version: 2, body: 'later' }));

    expect(liveTurn().textContent).toBe('');
  });

  it('falls back to the bare indicator when the connection is down', () => {
    realtime.connected = false;
    renderSurface();

    // The bubble is still there — the session IS running — it simply carries no
    // body and no turn key, which is exactly the codex / antigravity case.
    expect(liveTurn()).toHaveAttribute('data-turn-key', '');
    expect(liveTurn().textContent).toBe('');
  });

  it('clears the bubble when the session stops running', () => {
    const { rerender } = renderSurface();
    push(progressFrame());

    rerender(
      <ChatSurface
        messages={[msg('m-1', 'assistant')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        live={{ isRunning: false }}
        onSurfaceModeChange={() => {}}
      />,
    );

    expect(screen.queryByTestId('chat-transcript-live-turn')).toBeNull();
  });

  it('does not hold the previous turn’s body across a stop/start', () => {
    const { rerender } = renderSurface();
    push(progressFrame({ body: 'turn one' }));

    const idle = (
      <ChatSurface
        messages={[msg('m-1', 'assistant')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        live={{ isRunning: false }}
        onSurfaceModeChange={() => {}}
      />
    );
    rerender(idle);
    rerender(
      <ChatSurface
        messages={[msg('m-1', 'assistant')]}
        worktreeId={WORKTREE_ID}
        cliToolId="claude"
        instanceId="claude"
        live={{ isRunning: true }}
        onSurfaceModeChange={() => {}}
      />,
    );

    expect(liveTurn().textContent).toBe('');
  });
});

describe('[#2199] one indicator, not two', () => {
  it('publishes ONE live turn, indicator and body together', () => {
    // Before Issue #2233 these were two elements the surface had to keep from
    // both being on screen. They are one bubble now, so the property is
    // structural: a body arriving must not add a second live element.
    renderSurface();
    expect(screen.getAllByTestId('chat-transcript-live-turn')).toHaveLength(1);

    push(progressFrame());

    expect(screen.getAllByTestId('chat-transcript-live-turn')).toHaveLength(1);
    expect(liveTurn().textContent).toContain('The reply so far.');
  });

  it('still raises the terminal banner beside the bubble', () => {
    // A pager over a generating turn is still a state chat cannot drive, and the
    // bubble must not be the reason the way out disappears.
    renderSurface({ live: { isRunning: true, isPagerActive: true } });
    push(progressFrame());

    expect(liveTurn().textContent).toContain('The reply so far.');
    expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
      'data-reason',
      'pager',
    );
  });
});
