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
 *     sentence, so the standalone generating row stands down while it is up.
 *
 * `HistoryPane` is stubbed the way `ChatSurface-2194.test.tsx` stubs it — the
 * transcript is not what is under test here, and the stub is what makes the
 * scroll container present at all in a layout-less DOM.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="history-pane" data-message-count={String(messages.length)}>
      <div data-testid="history-scroll-container">
        {messages.map((m) => (
          <div key={m.id} data-message-id={m.id} />
        ))}
      </div>
    </div>
  ),
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
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

describe('[#2199] showing the in-flight reply', () => {
  it('renders the pushed body in the live region', () => {
    renderSurface();
    push(progressFrame());

    const body = screen.getByTestId('chat-surface-progress-body');
    expect(body.textContent).toContain('The reply so far.');
  });

  it('renders it as Markdown, the way the settled row will be', () => {
    renderSurface();
    push(progressFrame({ body: '## A heading' }));

    expect(screen.getByTestId('chat-surface-progress-body').querySelector('h2')).not.toBeNull();
  });

  it('grows as later frames arrive', () => {
    renderSurface();
    push(progressFrame({ version: 1, body: 'One.' }));
    push(progressFrame({ version: 2, body: 'One.\n\nTwo.' }));

    expect(screen.getByTestId('chat-surface-progress-body').textContent).toContain('Two.');
  });

  it('keeps the live region a sibling of the pane, not a row inside it', () => {
    // The whole reason #2194 built the region: a row inside the virtual list is
    // unmounted the moment the reader scrolls away from the end.
    renderSurface();
    push(progressFrame());

    const region = screen.getByTestId('chat-surface-live');
    expect(region.className).toContain('shrink-0');
    expect(region.contains(screen.getByTestId('chat-surface-progress'))).toBe(true);
    expect(region.contains(screen.getByTestId('history-pane'))).toBe(false);
  });

  it('says so when the body does not start at the beginning of the turn', () => {
    renderSurface();
    push(progressFrame({ partial: true }));

    expect(screen.getByTestId('chat-surface-progress-partial')).toBeInTheDocument();
  });

  it('says nothing of the sort when the body is whole', () => {
    renderSurface();
    push(progressFrame({ partial: false }));

    expect(screen.queryByTestId('chat-surface-progress-partial')).toBeNull();
  });
});

describe('[#2199] the swap', () => {
  it('drops the bubble once the settled row for the same turn is in the transcript', () => {
    const { rerender } = renderSurface();
    push(progressFrame());
    expect(screen.getByTestId('chat-surface-progress')).toBeInTheDocument();

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

    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
    // ...and the row is in the transcript exactly once.
    expect(screen.getByTestId('history-pane')).toHaveAttribute('data-message-count', '2');
  });

  it('keeps the bubble when a DIFFERENT turn settles', () => {
    renderSurface({
      messages: [msg('m-1', 'assistant', { requestId: 'claude-md:u-0' })],
    });
    push(progressFrame());

    expect(screen.getByTestId('chat-surface-progress')).toBeInTheDocument();
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

    expect(screen.getByTestId('chat-surface-progress-body').textContent).toContain(
      'The newest paragraph.',
    );
  });

  it('ignores a byte-identical re-send of the version already rendered', () => {
    renderSurface();
    push(progressFrame({ version: 4, body: 'Once.' }));
    push(progressFrame({ version: 4, body: 'Something else entirely.' }));

    expect(screen.getByTestId('chat-surface-progress-body').textContent).toContain('Once.');
  });

  it('ignores a frame for a sibling instance in the same room', () => {
    renderSurface();
    push(progressFrame({ instanceId: 'claude-2', body: 'the other agent’s reply' }));

    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
  });

  it('ignores a frame for another tool', () => {
    renderSurface();
    push(progressFrame({ cliToolId: 'opencode', instanceId: 'opencode' }));

    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
  });

  it('ignores a frame for another worktree', () => {
    renderSurface();
    push(progressFrame({ worktreeId: 'wt-other' }));

    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
  });

  it('ignores realtime events that are not progress frames', () => {
    renderSurface();
    push({ type: 'terminal_snapshot', worktreeId: WORKTREE_ID, version: 9 });

    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
  });
});

describe('[#2199] falling back', () => {
  it('shows nothing live while the push connection is down', () => {
    renderSurface();
    push(progressFrame());
    expect(screen.getByTestId('chat-surface-progress')).toBeInTheDocument();

    realtime.connected = false;
    // Any re-render re-reads the connection; the surface re-renders on every poll.
    push(progressFrame({ version: 2, body: 'later' }));

    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
  });

  it('falls back to the plain generating row when the connection is down', () => {
    realtime.connected = false;
    renderSurface();

    expect(screen.getByTestId('chat-surface-generating')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
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

    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
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

    expect(screen.queryByTestId('chat-surface-progress')).toBeNull();
  });
});

describe('[#2199] one indicator, not two', () => {
  it('stands the standalone generating row down while the bubble is up', () => {
    renderSurface();
    expect(screen.getByTestId('chat-surface-generating')).toBeInTheDocument();

    push(progressFrame());

    expect(screen.queryByTestId('chat-surface-generating')).toBeNull();
    expect(screen.getByTestId('chat-surface-progress')).toBeInTheDocument();
  });

  it('still raises the terminal banner beside the bubble', () => {
    // A pager over a generating turn is still a state chat cannot drive, and the
    // bubble must not be the reason the way out disappears.
    renderSurface({ live: { isRunning: true, isPagerActive: true } });
    push(progressFrame());

    expect(screen.getByTestId('chat-surface-progress')).toBeInTheDocument();
    expect(screen.getByTestId('chat-surface-terminal-banner')).toHaveAttribute(
      'data-reason',
      'pager',
    );
  });
});
