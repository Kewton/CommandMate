/**
 * The phone's chat surface gets the #1121 optimistic bubble (Issue #2213).
 *
 * #2194 left this to PC for a wiring reason, not a design one: `usePendingMessages`
 * has to live wherever the transcript array does (it merges the bubble in and
 * reconciles it against the server echo), and on a phone the composer is docked
 * *outside* this tab. #2213 keeps the hook here — next to `useSplitMessages`,
 * which must stay chat-only so a terminal-mode tab never runs a history poll it
 * does not render — and sends the SEND upward over `WorktreeChatSendContext`.
 *
 * So what is pinned here is the pair of facts that makes that safe:
 *   - the registration exists exactly while the transcript is on screen, and
 *   - the send is still the one `POST /send`, fired once.
 *
 * The composer is a stand-in for `MobileComposer` (one line: read the
 * registration, hand it to `MessageInput` as `onOptimisticSend`). The real
 * `MessageInput` path is covered by the #1121 suite and by
 * `WorktreeDetailRefactored-mobile-pending-2213`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import {
  WorktreeChatSendProvider,
  useChatOptimisticSend,
} from '@/contexts/WorktreeChatSendContext';

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

// Exposes exactly what these tests reason about: how many rows reached the
// transcript, in what order, and the #1121 send state of each. (Issue #2232
// swapped the chat surface's body from `HistoryPane` to `ChatTranscript`; the
// callbacks this stub exercises were message-level on both, which is why the
// screen's own behavior is unchanged.)
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({
    messages,
    onRetryPending,
    onDiscardPending,
  }: {
    messages: ChatMessage[];
    onRetryPending?: (tempId: string) => void;
    onDiscardPending?: (tempId: string) => void;
  }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      {messages.map((m) => (
        <div
          key={m.id}
          data-testid={`row-${m.id}`}
          data-optimistic={m.optimisticState ?? ''}
          data-role={m.role}
        >
          {m.content}
        </div>
      ))}
      <button
        type="button"
        data-testid="retry-last"
        onClick={() => onRetryPending?.(messages[messages.length - 1].id)}
      />
      <button
        type="button"
        data-testid="discard-last"
        onClick={() => onDiscardPending?.(messages[messages.length - 1].id)}
      />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

const { useTerminalPanePollingMock, useSplitMessagesMock, sendMessageMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  sendMessageMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
}));
vi.mock('@/lib/api-client', () => ({
  worktreeApi: { sendMessage: sendMessageMock },
}));

import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-2213';

function serverRow(id: string, content: string, role: 'user' | 'assistant' = 'user'): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content,
    timestamp: new Date('2026-09-01T09:00:00.000Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'claude',
  };
}

/** Drives the mocked `useSplitMessages` from inside the surface's own render. */
let pushServerMessages: ((next: ChatMessage[]) => void) | null = null;
const refreshMock = vi.fn(() => Promise.resolve());

function mockSplitMessages(initial: ChatMessage[]): void {
  useSplitMessagesMock.mockImplementation(() => {
    // A real hook call inside the component that consumes it, so a test-driven
    // change re-renders that component even though it is `memo`ised.
    const [messages, setMessages] = React.useState<ChatMessage[]>(initial);
    pushServerMessages = setMessages;
    return { messages, isLoading: false, refresh: refreshMock };
  });
}

function mockPaneState(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output',
      realtimeSnippet: 'output',
      isRunning: false,
      isThinking: false,
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

/** Stand-in for `MobileComposer` — the same single read of the registration. */
function Composer({ cliToolId = 'claude' as const, instanceId }: { cliToolId?: 'claude'; instanceId?: string }) {
  const optimisticSend = useChatOptimisticSend({ cliToolId, instanceId });
  return (
    <button
      type="button"
      data-testid="composer-send"
      data-has-send={optimisticSend ? 'yes' : 'no'}
      onClick={() => optimisticSend?.('deploy please', { cliToolId, instanceId })}
    />
  );
}

const insertToComposerMock = vi.fn();

function renderScreen(instanceId?: string) {
  return render(
    <WorktreeChatSendProvider onInsertToComposer={insertToComposerMock}>
      <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" instanceId={instanceId} />
      <Composer instanceId={instanceId} />
    </WorktreeChatSendProvider>,
  );
}

async function showChat(): Promise<void> {
  fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
  await waitFor(() => {
    expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument();
  });
}

function rowCount(): number {
  return Number(screen.getByTestId('chat-transcript').getAttribute('data-message-count'));
}

describe('[#2213] mobile chat surface optimistic send', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    pushServerMessages = null;
    mockPaneState();
    mockSplitMessages([serverRow('m1', 'older turn')]);
    sendMessageMock.mockResolvedValue(serverRow('srv-1', 'deploy please'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('registers nothing while the terminal is the visible surface', () => {
    renderScreen();

    // The chat surface is unmounted, so there is no transcript to put a bubble
    // in — and `MessageInput` reads a missing `onOptimisticSend` as the legacy
    // await-then-clear path, which is what the phone did before #2213.
    expect(screen.getByTestId('composer-send')).toHaveAttribute('data-has-send', 'no');
    expect(useSplitMessagesMock).not.toHaveBeenCalled();
  });

  it('publishes the send while the transcript is showing, and releases it again', async () => {
    renderScreen();
    await showChat();

    expect(screen.getByTestId('composer-send')).toHaveAttribute('data-has-send', 'yes');

    fireEvent.click(screen.getByTestId('mobile-surface-mode-terminal'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    });
    expect(screen.getByTestId('composer-send')).toHaveAttribute('data-has-send', 'no');
  });

  it('shows the sent line as a pending row before the server answers', async () => {
    let resolveSend: (value: ChatMessage) => void = () => {};
    sendMessageMock.mockImplementation(
      () =>
        new Promise<ChatMessage>((resolve) => {
          resolveSend = resolve;
        }),
    );

    renderScreen();
    await showChat();
    expect(rowCount()).toBe(1);

    act(() => {
      screen.getByTestId('composer-send').click();
    });

    await waitFor(() => expect(rowCount()).toBe(2));
    const bubble = screen.getByText('deploy please');
    expect(bubble).toHaveAttribute('data-optimistic', 'sending');
    expect(bubble).toHaveAttribute('data-role', 'user');

    // And the API is the existing one, called once — no second send path.
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(WORKTREE_ID, 'deploy please', {
      cliToolId: 'claude',
      instanceId: undefined,
    });

    act(() => resolveSend(serverRow('srv-1', 'deploy please')));
  });

  it('replaces the pending row with the server echo instead of adding a second one', async () => {
    renderScreen();
    await showChat();

    act(() => {
      screen.getByTestId('composer-send').click();
    });
    await waitFor(() => expect(rowCount()).toBe(2));

    // The #2195 push (or the `onSent` refetch) lands the real row.
    act(() => {
      pushServerMessages?.([serverRow('m1', 'older turn'), serverRow('srv-1', 'deploy please')]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('row-srv-1')).toBeInTheDocument();
    });
    expect(rowCount()).toBe(2);
    expect(screen.getByTestId('row-srv-1')).toHaveAttribute('data-optimistic', '');
  });

  it('collapses a duplicate id rather than showing the message twice', async () => {
    // Two rows with one id is already an upstream bug (`upsertMessage` matches by
    // id, and `usePendingMessages` reconciles the bubble before both can be in
    // the array). `ChatSurface.dedupeById` makes its symptom "the newer copy
    // wins" rather than the user watching their own message double — on the
    // phone as on PC.
    renderScreen();
    await showChat();

    act(() => {
      pushServerMessages?.([
        serverRow('m1', 'older turn'),
        serverRow('srv-1', 'first copy'),
        serverRow('srv-1', 'second copy'),
      ]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('row-srv-1')).toBeInTheDocument();
    });
    expect(rowCount()).toBe(2);
    expect(screen.getByTestId('row-srv-1')).toHaveTextContent('second copy');
  });

  it('marks an unconfirmed send as failed once the timeout elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderScreen();
      await showChat();

      act(() => {
        screen.getByTestId('composer-send').click();
      });
      await waitFor(() => expect(rowCount()).toBe(2));
      expect(screen.getByText('deploy please')).toHaveAttribute('data-optimistic', 'sending');

      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(screen.getByText('deploy please')).toHaveAttribute('data-optimistic', 'error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a discarded failed send to the composer', async () => {
    sendMessageMock.mockRejectedValue(new Error('network down'));

    renderScreen();
    await showChat();

    act(() => {
      screen.getByTestId('composer-send').click();
    });
    await waitFor(() => {
      expect(screen.getByText('deploy please')).toHaveAttribute('data-optimistic', 'error');
    });

    act(() => {
      screen.getByTestId('discard-last').click();
    });

    await waitFor(() => expect(rowCount()).toBe(1));
    expect(insertToComposerMock).toHaveBeenCalledWith('deploy please');
  });

  it('re-fires the same send on retry', async () => {
    sendMessageMock.mockRejectedValueOnce(new Error('network down'));

    renderScreen();
    await showChat();

    act(() => {
      screen.getByTestId('composer-send').click();
    });
    await waitFor(() => {
      expect(screen.getByText('deploy please')).toHaveAttribute('data-optimistic', 'error');
    });

    sendMessageMock.mockResolvedValue(serverRow('srv-1', 'deploy please'));
    act(() => {
      screen.getByTestId('retry-last').click();
    });

    await waitFor(() => {
      expect(screen.getByText('deploy please')).toHaveAttribute('data-optimistic', 'sending');
    });
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('scopes the registration to the instance whose transcript is showing', async () => {
    render(
      <WorktreeChatSendProvider onInsertToComposer={insertToComposerMock}>
        <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" instanceId="claude-2" />
        {/* A composer aimed at the primary instance while the surface shows
            claude-2 must NOT be handed that surface's send. */}
        <Composer />
      </WorktreeChatSendProvider>,
    );
    await showChat();

    expect(screen.getByTestId('composer-send')).toHaveAttribute('data-has-send', 'no');
  });
});
