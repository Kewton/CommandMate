/**
 * Issue #4503 (review 3, P2-1): the worktree page (`WorktreeDetailRefactored`, on a phone) sends
 * through a surface whose `usePendingMessages` has #4503's flags — rendered as the page itself, with
 * the real `MobileComposer` / `MessageInput`, `MobileTerminalTab` and `worktreeApi.sendMessage`
 * (`fetch` answers `/send` the way the route does):
 *
 * - `isOutcomeUnknown`: a 500 `sendOutcome: 'unknown'` is `unknown`, not `error` (+ ［再試行］).
 * - `holdInFlightOnTimeout`: a 201 whose echo has not come, and a request still in flight, are
 *   waiting once the 30 s clock runs out — not `error` (+ ［再試行］).
 *
 * Positive control: a 400 still fails. The harness is `WorktreeDetailRefactored-mobile-pending-2213`'s;
 * the surfaces alone (PC split and phone tab) are `send-unknown-surfaces-4503`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ChatMessage } from '@/types/models';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2213',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => true,
  MOBILE_BREAKPOINT: 768,
}));

const drawerMock = vi.hoisted(() => ({ openMobileDrawer: vi.fn() }));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: drawerMock.openMobileDrawer,
    closeMobileDrawer: vi.fn(),
  }),
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

vi.mock('@/hooks/useFileTabs', () => ({
  useFileTabs: () => [
    { tabs: [], activeIndex: null },
    {
      dispatch: vi.fn(),
      openFile: vi.fn().mockReturnValue('opened'),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      onFileRenamed: vi.fn(),
      onFileDeleted: vi.fn(),
      moveToFront: vi.fn(),
    },
  ],
}));

vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="history-pane" data-message-count={String(messages.length)}>
      {messages.map((m) => (
        <div key={m.id} data-testid={`row-${m.id}`} data-optimistic={m.optimisticState ?? ''}>
          {m.content}
        </div>
      ))}
    </div>
  ),
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

// The chat surface's body (#2232): it reports each row's send state and whether it waits for the
// answer — the assertion surface here. (`HistoryPane` above is the phone's History TAB.)
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      {messages.map((m) => (
        <div
          key={m.id}
          data-testid={`row-${m.id}`}
          data-optimistic={m.optimisticState ?? ''}
          data-awaiting={m.optimisticAwaitingResponse ? 'true' : ''}
        >
          {m.content}
        </div>
      ))}
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

// The phone's Agent pane is not what this file is about (as in the 2213 page test).
vi.mock('@/components/worktree/MobileAgentInstancesPane', () => ({
  MobileAgentInstancesPane: () => <div data-testid="mobile-agent-instances-pane" />,
}));

const { useTerminalPanePollingMock, useSplitMessagesMock } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-2213';
const TEXT = 'deploy please';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const CREATED_ROW = {
  id: 'srv-1',
  worktreeId: WORKTREE_ID,
  role: 'user',
  content: TEXT,
  timestamp: '2026-09-01T10:20:30.000Z',
  messageType: 'normal',
  archived: false,
  cliToolId: 'claude',
};

function mockPaneState(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output', realtimeSnippet: 'output', isRunning: false, isThinking: false,
      isSelectionListActive: false, isPagerActive: false, isUnclassifiedActive: false,
      composerText: '', attaching: false, autoScroll: true,
    },
    prompt: { visible: false, data: null, messageId: null, answering: false },
    agentSession: { session: null, context: null },
    setAutoScroll: vi.fn(), setPromptAnswering: vi.fn(), clearPrompt: vi.fn(), refresh: vi.fn(),
  });
}

let sendCalls = 0;
/** `/send` answers with `answer`; everything else answers the way the 2213 page test does. */
function installFetch(answer: () => Promise<Response>): void {
  sendCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.endsWith('/send')) {
        sendCalls += 1;
        return answer();
      }
      if (typeof url === 'string' && url.includes('/messages')) return Promise.resolve(jsonResponse([]));
      if (typeof url === 'string' && url.includes('/current-output')) {
        return Promise.resolve(jsonResponse({ isRunning: false, content: '', thinking: false }));
      }
      return Promise.resolve(
        jsonResponse({ id: WORKTREE_ID, name: 'feature/2213', path: '/tmp/wt', repositoryPath: '/tmp/repo', repositoryName: 'CommandMate' }),
      );
    }),
  );
}

const row = () => screen.getByText(TEXT, { selector: '[data-optimistic]' });

async function sendFromPage(): Promise<void> {
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await waitFor(() => expect(screen.getByTestId('mobile-surface-mode-chat')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
  await waitFor(() => expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: TEXT } });
  fireEvent.click(screen.getByRole('button', { name: /send message/i }));
  await waitFor(() => expect(sendCalls).toBe(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('[#4503 review 3 P2-1] the worktree page (phone): the flags reach the hook', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    mockPaneState();
    useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('isOutcomeUnknown: a 500 sendOutcome:unknown is unknown, not a failure', async () => {
    installFetch(() => Promise.resolve(jsonResponse({ error: 'submit could not be confirmed', sendOutcome: 'unknown' }, 500)));
    await sendFromPage();
    await waitFor(() => expect(row()).toHaveAttribute('data-optimistic', 'unknown'));
    expect(sendCalls).toBe(1);
  });

  it('holdInFlightOnTimeout: a 201 whose echo has not come waits once 30 s pass — not error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetch(() => Promise.resolve(jsonResponse(CREATED_ROW, 201)));
    await sendFromPage();
    expect(row()).toHaveAttribute('data-optimistic', 'sending');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(row()).toHaveAttribute('data-optimistic', 'sending');
    expect(row()).toHaveAttribute('data-awaiting', 'true');
    expect(sendCalls).toBe(1);
  });

  it('holdInFlightOnTimeout: a request still in flight waits once 30 s pass — not error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetch(() => new Promise<Response>(() => undefined));
    await sendFromPage();
    expect(row()).toHaveAttribute('data-optimistic', 'sending');
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(row()).toHaveAttribute('data-optimistic', 'sending');
    expect(row()).toHaveAttribute('data-awaiting', 'true');
    expect(sendCalls).toBe(1);
  });

  it('(positive control) a 400 still fails', async () => {
    installFetch(() => Promise.resolve(jsonResponse({ error: 'content is required' }, 400)));
    await sendFromPage();
    await waitFor(() => expect(row()).toHaveAttribute('data-optimistic', 'error'));
  });
});
