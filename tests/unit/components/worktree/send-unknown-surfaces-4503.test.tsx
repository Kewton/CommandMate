/**
 * Issue #4503 (review 3, P2-1): the screen's two transcript owners — `TerminalSplitPaneContent` on
 * PC and `MobileTerminalTab` on the phone — each reach `usePendingMessages` with #4503's flags
 * (`useOptimisticPaneMessages` sets `isOutcomeUnknown` / `holdInFlightOnTimeout`). Rendered as the
 * surfaces themselves, so a surface that stops going through that hook, or the hook losing either
 * flag, turns these red:
 *
 * - `isOutcomeUnknown`: a 500 `sendOutcome: 'unknown'` is `unknown`, not `error` (+ ［再試行］).
 * - `holdInFlightOnTimeout`: a 201 whose echo has not come, and a request still in flight, are
 *   waiting (`sending` + awaiting) once the 30 s clock runs out — not `error` (+ ［再試行］).
 *
 * Positive control: a 400 still fails. The harness is `composer-offline-resend-2503`'s; the page
 * (`WorktreeDetailRefactored`) is `WorktreeDetailRefactored-send-unknown-4503`, the `/sessions`
 * tile `SessionTile-send-unknown-4503`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { ConnectivityState } from '@/hooks/useConnectivity';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import { WorktreeChatSendProvider, useChatOptimisticSend } from '@/contexts/WorktreeChatSendContext';
import { ApiError } from '@/lib/api-client';

beforeAll(() => installRadixJsdomPolyfills());

/** A healthy connection throughout: nothing here is held for the network. */
vi.mock('@/hooks/useConnectivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useConnectivity')>();
  const online: ConnectivityState = {
    status: 'online',
    isOnline: true,
    isReconnecting: false,
    isOffline: false,
    shouldSurface: false,
    signals: { browserOnline: true, realtimeStatus: 'connected', serverReachable: true },
    lastReachableAt: 1,
    recheck: () => undefined,
  } as ConnectivityState;
  return { ...actual, useConnectivity: () => online };
});

const { sendMessageMock, refreshMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  refreshMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock } };
});

// The echo never comes: the server's transcript stays empty.
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: refreshMock }),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false, error: null,
    filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

/** Reports each row's send state and whether it waits for the answer — the assertion surface. */
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-transcript">
      {messages.map((m) => (
        <div
          key={m.id}
          data-testid={`row-${m.content}`}
          data-optimistic={m.optimisticState ?? ''}
          data-awaiting={m.optimisticAwaitingResponse ? 'true' : ''}
        >
          {m.content}
        </div>
      ))}
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

const useTerminalPanePollingMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

function mockPane(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output', realtimeSnippet: 'output', isRunning: true, isThinking: false,
      sessionStatus: 'waiting', isSelectionListActive: false, isPagerActive: false,
      isUnclassifiedActive: false, composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(), setPromptAnswering: vi.fn(), clearPrompt: vi.fn(), refresh: vi.fn(),
  });
}

import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-4503';
const TEXT = 'did this arrive';

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

const row = () => screen.getByTestId(`row-${TEXT}`);

async function flush(ms = 10): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** A surface: how to put it on screen and send `TEXT` from it. */
interface Surface {
  name: string;
  renderAndSend(): Promise<void>;
}

const PC: Surface = {
  name: 'PC split (TerminalSplitPaneContent)',
  async renderAndSend() {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
    render(
      <TerminalSplitPaneContent
        worktreeId={WORKTREE_ID}
        splitIndex={0}
        cliToolId="claude"
        availableInstances={[inst('claude')]}
        onInstanceChange={vi.fn()}
        onFocus={vi.fn()}
        autoYes={{ onToggle: vi.fn() }}
      />,
    );
    const textarea = await screen.findByTestId('message-input-textarea');
    fireEvent.change(textarea, { target: { value: TEXT } });
    fireEvent.submit(textarea.closest('form') as HTMLFormElement);
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await flush();
  },
};

/** Stand-in for `MobileComposer` — the same single read of the registration. */
function Composer() {
  const optimisticSend = useChatOptimisticSend({ cliToolId: 'claude' });
  return <button type="button" data-testid="composer-send" onClick={() => optimisticSend?.(TEXT, { cliToolId: 'claude' })} />;
}

const PHONE: Surface = {
  name: 'phone (MobileTerminalTab)',
  async renderAndSend() {
    render(
      <WorktreeChatSendProvider onInsertToComposer={vi.fn()}>
        <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />
        <Composer />
      </WorktreeChatSendProvider>,
    );
    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
    await waitFor(() => expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument());
    act(() => {
      screen.getByTestId('composer-send').click();
    });
    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await flush();
  },
};

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  mockPane();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe.each([PC, PHONE])('[#4503 review 3 P2-1] $name: the flags reach the hook', (surface) => {
  it('isOutcomeUnknown: a 500 sendOutcome:unknown is unknown, not a failure', async () => {
    sendMessageMock.mockRejectedValue(new ApiError('submit could not be confirmed', 500, { error: 'x', sendOutcome: 'unknown' }));
    await surface.renderAndSend();
    await waitFor(() => expect(row()).toHaveAttribute('data-optimistic', 'unknown'));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('holdInFlightOnTimeout: a 201 whose echo has not come waits once 30 s pass — not error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendMessageMock.mockResolvedValue({ id: 'srv-1' });
    await surface.renderAndSend();
    expect(row()).toHaveAttribute('data-optimistic', 'sending');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(row()).toHaveAttribute('data-optimistic', 'sending');
    expect(row()).toHaveAttribute('data-awaiting', 'true');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('holdInFlightOnTimeout: a request still in flight waits once 30 s pass — not error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendMessageMock.mockReturnValue(new Promise(() => undefined));
    await surface.renderAndSend();
    expect(row()).toHaveAttribute('data-optimistic', 'sending');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(row()).toHaveAttribute('data-optimistic', 'sending');
    expect(row()).toHaveAttribute('data-awaiting', 'true');
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('(positive control) a 400 still fails', async () => {
    sendMessageMock.mockRejectedValue(new ApiError('content is required', 400, { error: 'content is required' }));
    await surface.renderAndSend();
    await waitFor(() => expect(row()).toHaveAttribute('data-optimistic', 'error'));
  });
});
