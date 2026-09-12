/**
 * Both composer surfaces hold a send that could not get out, and resend it when
 * the server answers again (Issue #2503).
 *
 * `usePendingMessages` is exercised directly in
 * `tests/unit/hooks/usePendingMessages-offline-resend-2503.test.ts`. What is
 * pinned here is the wiring, which is the part a refactor silently drops: the
 * two surfaces that own a transcript — `TerminalSplitPaneContent` on PC and
 * `MobileTerminalTab`'s chat surface on the phone — each have to read the
 * connection verdict and hand it to the hook. Either one left unwired looks
 * exactly like before: the message goes to 「送信に失敗しました」 after 30s and
 * stays there.
 *
 * `useConnectivity` is mocked rather than driven through `navigator.onLine`,
 * because #2501 deliberately refuses to take `onLine === true` as evidence —
 * setting the flag would prove nothing about what these surfaces do.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { ConnectivityState, ConnectivitySignals } from '@/hooks/useConnectivity';
import { getSplitSurfaceModeStorageKey } from '@/config/surface-mode-config';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';
import {
  WorktreeChatSendProvider,
  useChatOptimisticSend,
} from '@/contexts/WorktreeChatSendContext';

beforeAll(() => installRadixJsdomPolyfills());

// ---------------------------------------------------------------------------
// Connectivity: the one input under test
// ---------------------------------------------------------------------------

/**
 * A tiny reactive store, so flipping the verdict actually re-renders the
 * surfaces under test the way the real hook's own state does. A plain mutable
 * object would let a component that never re-reads connectivity pass.
 */
const connectivity = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: null as unknown as ConnectivityState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: ConnectivityState) {
      this.state = next;
      listeners.forEach((listener) => listener());
    },
  };
});

function signalsFor(reachable: boolean, browserOnline: boolean): ConnectivitySignals {
  return {
    browserOnline,
    // Live push down throughout: the desktop is carried by polling, which is
    // precisely the case `isServerConfirmedReachable` has to accept.
    realtimeStatus: 'disconnected',
    serverReachable: reachable ? true : browserOnline ? false : null,
  };
}

function setConnectivity(verdict: 'offline' | 'reachable'): void {
  const reachable = verdict === 'reachable';
  connectivity.set({
    status: reachable ? 'reconnecting' : 'offline',
    isOnline: false,
    isReconnecting: reachable,
    isOffline: !reachable,
    shouldSurface: true,
    signals: signalsFor(reachable, reachable),
    lastReachableAt: reachable ? 1 : null,
    recheck: vi.fn(),
  });
}

vi.mock('@/hooks/useConnectivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useConnectivity')>();
  const { useSyncExternalStore } = await import('react');
  return {
    ...actual,
    useConnectivity: () =>
      useSyncExternalStore(
        (listener: () => void) => connectivity.subscribe(listener),
        () => connectivity.state,
        () => connectivity.state,
      ),
  };
});

// ---------------------------------------------------------------------------
// Shared stubs
// ---------------------------------------------------------------------------

const { sendMessageMock, refreshMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  refreshMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    worktreeApi: { ...actual.worktreeApi, sendMessage: sendMessageMock },
  };
});

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: refreshMock }),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [],
    filteredGroups: [],
    allCommands: [],
    loading: false,
    error: null,
    filter: '',
    setFilter: vi.fn(),
    refresh: vi.fn(),
    isCatalogStale: false,
  }),
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

/** Reports the send state of each row — the whole assertion surface here. */
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-transcript">
      {messages.map((m) => (
        <div key={m.id} data-testid={`row-${m.content}`} data-optimistic={m.optimisticState ?? ''}>
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
      output: 'output',
      realtimeSnippet: 'output',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive: false,
      isPagerActive: false,
      isUnclassifiedActive: false,
      composerText: '',
      attaching: false,
      autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null, diff: null },
    setAutoScroll: vi.fn(),
    setPromptAnswering: vi.fn(),
    clearPrompt: vi.fn(),
    refresh: vi.fn(),
  });
}

import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import { MobileTerminalTab } from '@/components/worktree/MobileTerminalTab';

const WORKTREE_ID = 'wt-2503';
const TEXT = 'send this when we are back';

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

/** The surface's recovery pass settles before it decides; give it room. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
}

function bubbleState(): string | null {
  return screen.getByTestId(`row-${TEXT}`).getAttribute('data-optimistic');
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({}) }),
  ) as unknown as typeof fetch;
  mockPane();
  setConnectivity('offline');
  sendMessageMock.mockRejectedValue(new TypeError('Failed to fetch'));
});

afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

// ---------------------------------------------------------------------------
// PC: TerminalSplitPaneContent
// ---------------------------------------------------------------------------

describe('[#2503] PC split composer', () => {
  /** Stands in for `MessageInput`: the one call the composer makes. */
  function renderSplit() {
    window.localStorage.setItem(getSplitSurfaceModeStorageKey(WORKTREE_ID, 0), 'chat');
    return render(
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
  }

  async function send(): Promise<void> {
    const textarea = await screen.findByTestId('message-input-textarea');
    fireEvent.change(textarea, { target: { value: TEXT } });
    fireEvent.submit(textarea.closest('form') as HTMLFormElement);
  }

  it('holds an offline send as waiting and resends it once the server answers', async () => {
    renderSplit();
    await send();

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle();
    // Waiting for the network, not failed — the bubble keeps its in-flight look.
    expect(bubbleState()).toBe('sending');

    sendMessageMock.mockResolvedValue({ id: 'srv-1' });
    act(() => setConnectivity('reachable'));
    await settle();

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(sendMessageMock).toHaveBeenLastCalledWith(WORKTREE_ID, TEXT, {
      cliToolId: 'claude',
    });
    expect(bubbleState()).toBe('sending');
  });
});

// ---------------------------------------------------------------------------
// Phone: MobileTerminalTab's chat surface
// ---------------------------------------------------------------------------

describe('[#2503] mobile chat composer', () => {
  /** Stand-in for `MobileComposer` — the same single read of the registration. */
  function Composer() {
    const optimisticSend = useChatOptimisticSend({ cliToolId: 'claude' });
    return (
      <button
        type="button"
        data-testid="composer-send"
        onClick={() => optimisticSend?.(TEXT, { cliToolId: 'claude' })}
      />
    );
  }

  function renderScreen() {
    return render(
      <WorktreeChatSendProvider onInsertToComposer={vi.fn()}>
        <MobileTerminalTab worktreeId={WORKTREE_ID} cliToolId="claude" />
        <Composer />
      </WorktreeChatSendProvider>,
    );
  }

  async function showChat(): Promise<void> {
    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
    await waitFor(() => {
      expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument();
    });
  }

  it('holds an offline send as waiting and resends it once the server answers', async () => {
    renderScreen();
    await showChat();

    act(() => {
      screen.getByTestId('composer-send').click();
    });

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(bubbleState()).toBe('sending');

    sendMessageMock.mockResolvedValue({ id: 'srv-1' });
    act(() => setConnectivity('reachable'));
    await settle();

    await waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(2));
    expect(bubbleState()).toBe('sending');
  });

  it('fails an offline send the old way when the verdict says the server is there', async () => {
    // The control: with a healthy connection nothing is held, so a rejection is
    // still a failure the user can retry or discard.
    setConnectivity('reachable');
    renderScreen();
    await showChat();

    act(() => {
      screen.getByTestId('composer-send').click();
    });

    await waitFor(() => expect(bubbleState()).toBe('error'));
    await settle();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
