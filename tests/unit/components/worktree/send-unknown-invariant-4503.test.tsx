/**
 * Issue #4503 (review 1, P1-1・U-0): through the screen's own wiring, a send whose outcome is unknown
 * is never sent again without the person's confirmation — and a send that really was not sent can be.
 *
 * The pane under test is the worktree screen's: `MessageInput` handing its send to the real
 * `useOptimisticPaneMessages` (the hook that sets `isOutcomeUnknown` / `holdInFlightOnTimeout` for
 * the PC split and the phone), whose rows are drawn by both histories (PC `ConversationPairCard`,
 * phone `ChatMessageBubble`). `fetch` answers `/send` the way the route does (`sendOutcome`, `code`);
 * `api-client` is the real one, so a rejected fetch reaches the hook as the `ApiError` it really is.
 *
 * Entrances pinned shut for an unknown row: ［再試行］ (there is none, on either history), 「送り直す」
 * before its confirmation, the return of the connection (#2503's automatic resend), Enter and the
 * send button (the composer holds nothing of it). The awaited composer's entrances (Enter, the
 * button, the brief choice, a draft brought back by a remount, a switch of the target) are in
 * `MessageInput-send-unknown-4503.test.tsx`; the `/sessions` tile is `SessionTile-send-unknown-4503`.
 *
 * Red with the wiring taken out of `useOptimisticPaneMessages` (checked by hand, #4503 review 1).
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import { ChatMessageBubble } from '@/components/worktree/ChatMessageBubble';
import { ConversationPairCard } from '@/components/worktree/ConversationPairCard';
import { ToastProvider } from '@/components/common/Toast';
import { useOptimisticPaneMessages } from '@/hooks/useOptimisticPaneMessages';
import type { ConnectivityState } from '@/hooks/useConnectivity';
import { mockCommandGroups } from '@tests/helpers/message-input-test-utils';
import ja from '../../../../locales/ja/worktree.json';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-4503',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({
    groups: mockCommandGroups,
    filteredGroups: mockCommandGroups,
    allCommands: mockCommandGroups.flatMap((g) => g.commands),
    loading: false,
    error: null,
    isCatalogStale: false,
  })),
}));

/** The connection verdict, reactive (as in `composer-offline-resend-2503`). */
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

function setConnectivity(verdict: 'offline' | 'reachable'): void {
  const reachable = verdict === 'reachable';
  act(() => {
    connectivity.set({
      status: reachable ? 'reconnecting' : 'offline',
      isOnline: false,
      isReconnecting: reachable,
      isOffline: !reachable,
      shouldSurface: true,
      signals: {
        browserOnline: reachable,
        realtimeStatus: 'disconnected',
        serverReachable: reachable ? true : null,
      },
      lastReachableAt: reachable ? 1 : null,
      recheck: vi.fn(),
    });
  });
}

const WT = 'wt-4503';
const BODY = 'please review the diff';
const JA = ja.conversation.sendUnknown;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type SendAnswer = () => Response | Promise<Response>;
let sendAnswers: SendAnswer[] = [];
let sendCalls = 0;

function installFetch(...answers: SendAnswer[]) {
  sendAnswers = answers;
  sendCalls = 0;
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/worktrees/${WT}/send` && init?.method === 'POST') {
      const answer = sendAnswers[Math.min(sendCalls, sendAnswers.length - 1)];
      sendCalls += 1;
      return answer();
    }
    if (url.includes('/start-preview')) return json(200, { ok: true, show: false, attended: false });
    return json(200, {});
  }) as unknown as typeof fetch;
}

const created = () =>
  json(201, { id: 'srv-1', worktreeId: WT, role: 'user', content: BODY, timestamp: new Date().toISOString(), messageType: 'normal' });

function Pane() {
  const [insert, setInsert] = React.useState<string | null>(null);
  const { messages, sendOptimistic, retry, discard } = useOptimisticPaneMessages({
    worktreeId: WT,
    serverMessages: [],
    onSent: () => undefined,
    onNotSent: (content) => setInsert(content),
  });
  const onDiscard = (id: string) => {
    const content = discard(id);
    if (content) setInsert(content);
  };
  return (
    <>
      <MessageInput
        worktreeId={WT}
        cliToolId="antigravity"
        onMessageSent={() => undefined}
        onOptimisticSend={sendOptimistic}
        pendingInsertText={insert}
        onInsertConsumed={() => setInsert(null)}
      />
      <div data-testid="pc-history">
        {messages.map((m) => (
          <ConversationPairCard
            key={m.id}
            pair={{ id: m.id, userMessage: m, assistantMessages: [], status: 'pending' }}
            onFilePathClick={() => undefined}
            onInsertToMessage={(content) => setInsert(content)}
            onRetryPending={retry}
            onDiscardPending={onDiscard}
          />
        ))}
      </div>
      <div data-testid="phone-history">
        {messages.map((m) => (
          <ChatMessageBubble
            key={m.id}
            message={m}
            showHeader
            onFilePathClick={() => undefined}
            onInsertToMessage={(content) => setInsert(content)}
            onRetryPending={retry}
            onDiscardPending={onDiscard}
          />
        ))}
      </div>
    </>
  );
}

const textarea = () => screen.getByTestId('message-input-textarea') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: /send message|送信/i });
const pc = () => within(screen.getByTestId('pc-history'));
const phone = () => within(screen.getByTestId('phone-history'));

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderAndSend(): Promise<void> {
  render(
    <ToastProvider>
      <Pane />
    </ToastProvider>,
  );
  fireEvent.change(textarea(), { target: { value: BODY } });
  fireEvent.click(sendButton());
  await flush(10);
}

beforeEach(() => {
  window.localStorage.clear();
  setConnectivity('reachable');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const UNKNOWN_ANSWERS: Array<[string, SendAnswer]> = [
  ['500 sendOutcome:unknown (the route: typed, then its answer failed)', () => json(500, { error: 'submit could not be confirmed', sendOutcome: 'unknown' })],
  ['500 with no sendOutcome (review 2: D4 as written)', () => json(500, { error: 'Internal failure' })],
  ['502 with no sendOutcome (a proxy / tunnel)', () => json(502, { error: 'Bad Gateway' })],
  ['504 with no sendOutcome (a proxy / tunnel)', () => json(504, {})],
  ['the fetch rejected (network)', () => Promise.reject(new TypeError('Failed to fetch'))],
];

describe('[#4503 U-0] the worktree pane: an unknown send is never sent again without confirmation', () => {
  it.each(UNKNOWN_ANSWERS)('%s', async (_name, answer) => {
    installFetch(answer, created);
    await renderAndSend();
    await waitFor(() => expect(pc().getByTestId('optimistic-unknown')).toHaveTextContent(JA.status));
    expect(sendCalls).toBe(1);

    // Both histories say it is unknown and offer no ［再試行］.
    expect(pc().getByTestId('optimistic-unknown-guidance')).toHaveTextContent(JA.guidance);
    expect(phone().getByTestId('chat-optimistic-unknown')).toHaveTextContent(JA.status);
    expect(pc().queryByTestId('pending-retry')).toBeNull();
    expect(phone().queryByTestId('chat-pending-retry')).toBeNull();
    expect(pc().queryByTestId('optimistic-error')).toBeNull();
    // Nothing to put back in the composer from the row (its Enter would send it again unasked).
    expect(pc().queryByTestId('insert-user-message')).toBeNull();
    expect(phone().queryByTestId('chat-insert-user-message')).toBeNull();

    // 「送り直す」 on either history sends nothing until it is confirmed.
    fireEvent.click(pc().getByTestId('pending-resend'));
    fireEvent.click(phone().getByTestId('chat-pending-resend'));
    await flush(10);
    expect(sendCalls).toBe(1);
    fireEvent.click(pc().getByTestId('pending-resend-confirm-no'));
    fireEvent.click(phone().getByTestId('chat-pending-resend-confirm-no'));

    // The composer holds nothing of it: Enter and the button send nothing.
    expect(textarea().value).toBe('');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    fireEvent.click(sendButton());
    await flush(10);
    expect(sendCalls).toBe(1);

    // The connection goes and comes back: no automatic resend (#2503 is for what never went out).
    setConnectivity('offline');
    await flush(10);
    setConnectivity('reachable');
    await flush(400);
    expect(sendCalls).toBe(1);
    expect(pc().getByTestId('optimistic-unknown')).toBeInTheDocument();

    // Only the confirmation sends it again.
    fireEvent.click(pc().getByTestId('pending-resend'));
    await act(async () => {
      fireEvent.click(pc().getByTestId('pending-resend-confirm-yes'));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(sendCalls).toBe(2);
  });

  it('discarding an unknown row does not put its text back in the composer', async () => {
    installFetch(() => json(500, { error: 'x', sendOutcome: 'unknown' }));
    await renderAndSend();
    await waitFor(() => expect(pc().getByTestId('optimistic-unknown')).toBeInTheDocument());
    fireEvent.click(pc().getByTestId('pending-discard'));
    await flush(10);
    expect(pc().queryByTestId('optimistic-unknown')).toBeNull();
    expect(textarea().value).toBe('');
    expect(sendCalls).toBe(1);
  });

  it('a clock run out while the request is in flight reads as waiting, with nothing to press', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installFetch(() => new Promise<Response>(() => undefined));
      await renderAndSend();
      await waitFor(() => expect(pc().getByTestId('optimistic-sending')).toBeInTheDocument());
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(pc().getByTestId('optimistic-awaiting')).toHaveTextContent(JA.awaiting);
      expect(phone().getByTestId('chat-optimistic-awaiting')).toHaveTextContent(JA.awaiting);
      for (const id of ['pending-retry', 'pending-discard', 'pending-resend', 'optimistic-error']) {
        expect(pc().queryByTestId(id)).toBeNull();
      }
      for (const id of ['chat-pending-retry', 'chat-pending-discard', 'chat-pending-resend', 'chat-optimistic-error']) {
        expect(phone().queryByTestId(id)).toBeNull();
      }
      expect(sendCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('[#4503 U-0 / review 2 P2-2] a 201 whose echo does not come', () => {
  it('the clock runs out: waiting, then unknown — never ［再試行］', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installFetch(created);
      await renderAndSend();
      await waitFor(() => expect(sendCalls).toBe(1));
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(pc().getByTestId('optimistic-awaiting')).toHaveTextContent(JA.awaiting);
      expect(pc().queryByTestId('pending-retry')).toBeNull();
      expect(phone().queryByTestId('chat-pending-retry')).toBeNull();
      expect(pc().queryByTestId('optimistic-error')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(pc().getByTestId('optimistic-unknown')).toBeInTheDocument();
      expect(pc().queryByTestId('pending-retry')).toBeNull();
      fireEvent.click(pc().getByTestId('pending-resend'));
      await flush(10);
      expect(sendCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('[#4503 U-0] (positive control) a send that really was not sent can be sent again', () => {
  it.each<[string, SendAnswer]>([
    ['400', () => json(400, { error: 'content is required' })],
    ['500 sendOutcome:not_sent', () => json(500, { error: 'session start failed', sendOutcome: 'not_sent' })],
    ['503 SESSION_STARTING (refused before any key; no sendOutcome)', () => json(503, { error: 'starting', code: 'SESSION_STARTING' })],
  ])('%s: the row fails and ［再試行］ sends it again directly', async (_name, answer) => {
    installFetch(answer, created);
    await renderAndSend();
    await waitFor(() => expect(pc().getByTestId('optimistic-error')).toBeInTheDocument());
    expect(pc().queryByTestId('optimistic-unknown')).toBeNull();
    fireEvent.click(pc().getByTestId('pending-retry'));
    await flush(10);
    expect(sendCalls).toBe(2);
  });

  it('offline when sent (kind offline: no request went out): held, and sent once when the connection is back', async () => {
    installFetch(created);
    setConnectivity('offline');
    // The browser says offline: `api-client` refuses before any request (`ApiError` kind `offline`).
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    await renderAndSend();
    expect(sendCalls).toBe(0);
    expect(pc().queryByTestId('optimistic-unknown')).toBeNull();
    onLine.mockReturnValue(true);
    setConnectivity('reachable');
    await waitFor(() => expect(sendCalls).toBe(1), { timeout: 2000 });
  });
});
