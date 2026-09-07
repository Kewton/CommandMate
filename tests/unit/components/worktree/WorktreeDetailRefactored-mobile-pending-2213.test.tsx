/**
 * The phone's real send path shows a pending row (Issue #2213).
 *
 * The other #2213 suites pin the pieces: the context's registration rules, the
 * surface's `usePendingMessages` wiring, and the composer's payload. This one
 * renders the actual screen — `WorktreeDetailRefactored` with its
 * `WorktreeChatSendProvider`, the real `MobileComposer` / `MessageInput`, and the
 * real `MobileTerminalTab` → `MobileChatSurface` — because the whole point of
 * #2213 is that those two are SIBLINGS with no common owner, and only rendering
 * them together proves the seam actually joins them.
 *
 * `fetch` is left real-ish (a stub that answers `/send` with the 201 body the
 * route returns), so `worktreeApi.sendMessage` runs for real too.
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

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
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

vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => ({ data: null, loading: false, error: null }),
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

// Issue #2232: the chat surface's body is `ChatTranscript`. The `HistoryPane`
// stub above stays because this screen also owns the phone's History TAB, which
// this Issue left on the old component — keeping both is what lets the terminal-
// mode case below assert that neither transcript is mounted.
vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      {messages.map((m) => (
        <div key={m.id} data-testid={`row-${m.id}`} data-optimistic={m.optimisticState ?? ''}>
          {m.content}
        </div>
      ))}
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

// Issue #2395: the phone's Agent pane, stubbed down to the ONE prop this file
// is about. The pane's own behaviour (which row loses the delegation item) is
// pinned in `AgentInstancesPane-delegation-2376.test.tsx`; what only this render
// can show is that the composer's live target actually travels
// `WorktreeDetailRefactored` -> `MobileContent` -> `NotesAndLogsPane` -> here.
vi.mock('@/components/worktree/MobileAgentInstancesPane', () => ({
  MobileAgentInstancesPane: ({
    composerTargetInstanceId,
  }: {
    composerTargetInstanceId?: string;
  }) => (
    <div data-testid="mobile-agent-instances-pane">
      {/* A sentinel for "absent": absent is what leaves the shared pane on its
          DOM read, which on a phone can never answer. */}
      <span data-testid="agent-pane-composer-target">
        {composerTargetInstanceId ?? '(none)'}
      </span>
    </div>
  ),
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
import {
  CommandPaletteProvider,
  useCommandPalette,
} from '@/contexts/CommandPaletteContext';

const WORKTREE_ID = 'wt-2213';

const CREATED_ROW = {
  id: 'srv-1',
  worktreeId: WORKTREE_ID,
  role: 'user',
  content: 'deploy please',
  timestamp: '2026-09-01T10:20:30.000Z',
  messageType: 'normal',
  archived: false,
  cliToolId: 'claude',
};

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

const sendCalls: Array<{ url: string; body: unknown }> = [];
let resolveSend: (() => void) | null = null;

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

describe('[#2213] mobile screen: composer send → pending row on the chat surface', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    sendCalls.length = 0;
    resolveSend = null;
    mockPaneState();
    useSplitMessagesMock.mockReturnValue({
      messages: [],
      isLoading: false,
      refresh: vi.fn(() => Promise.resolve()),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.endsWith('/send')) {
          sendCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
          // Held open so the assertion below is unambiguously about the
          // OPTIMISTIC row: it is on screen while the API is still in flight.
          return new Promise<Response>((resolve) => {
            resolveSend = () => resolve(jsonResponse(CREATED_ROW, 201));
          });
        }
        if (typeof url === 'string' && url.includes('/messages')) {
          return Promise.resolve(jsonResponse([]));
        }
        if (typeof url === 'string' && url.includes('/current-output')) {
          return Promise.resolve(
            jsonResponse({ isRunning: false, isGenerating: false, content: '', thinking: false }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            id: WORKTREE_ID,
            name: 'feature/2213',
            path: '/tmp/wt',
            repositoryPath: '/tmp/repo',
            repositoryName: 'CommandMate',
          }),
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  async function showChatSurface(): Promise<void> {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('mobile-surface-mode-chat')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
    await waitFor(() => {
      expect(screen.getByTestId('mobile-chat-surface')).toBeInTheDocument();
    });
  }

  function sendFromComposer(text: string): void {
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
  }

  it('renders the sent line as a pending row while the API is still in flight', async () => {
    await showChatSurface();
    expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-message-count', '0');

    sendFromComposer('deploy please');

    await waitFor(() => {
      expect(screen.getByTestId('chat-transcript')).toHaveAttribute('data-message-count', '1');
    });
    expect(screen.getByText('deploy please')).toHaveAttribute('data-optimistic', 'sending');

    // One send, over the existing route — the composer delegated rather than
    // opening a path of its own.
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].url).toBe(`/api/worktrees/${WORKTREE_ID}/send`);
    expect(sendCalls[0].body).toEqual({ content: 'deploy please', cliToolId: 'claude' });

    await act(async () => {
      resolveSend?.();
    });
  });

  it('keeps the composer on its await-then-clear path in terminal mode', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    await waitFor(() => {
      expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    });

    sendFromComposer('deploy please');

    await waitFor(() => {
      expect(sendCalls).toHaveLength(1);
    });
    // No transcript is mounted, so there is nothing to hold a bubble — and the
    // history poll the chat surface owns has not been started either.
    expect(screen.queryByTestId('chat-transcript')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-pane')).not.toBeInTheDocument();
    expect(useSplitMessagesMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveSend?.();
    });
  });
});

// ============================================================================
// Issue #2395: the two things the phone's worktree screen was missing
// ============================================================================

/**
 * Both halves of #2395 are SEAMS, and a seam is only visible when the whole
 * screen is rendered:
 *
 *   - the command palette is mounted by `AppShell` on every mobile route, but
 *     `/worktrees/*` is the one route that hides `GlobalMobileNav` — the only
 *     thing that could open it. The trigger therefore has to live on this
 *     screen's own header;
 *   - the roster pane's "do not delegate to yourself" guard reads the chat
 *     surface, and on a phone that surface belongs to a DIFFERENT tab. The
 *     composer's target has to be handed down instead, and it is handed down
 *     through three components that each own none of it.
 */
describe('[#2395] mobile screen: palette entry point and composer target', () => {
  /** Reports the palette open state `AppShell`'s `<CommandPalette />` reads. */
  function PaletteProbe() {
    const { open } = useCommandPalette();
    return <span data-testid="palette-open">{open ? 'open' : 'closed'}</span>;
  }

  const ROSTER = [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  ];

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    mockPaneState();
    useSplitMessagesMock.mockReturnValue({
      messages: [],
      isLoading: false,
      refresh: vi.fn(() => Promise.resolve()),
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (typeof url === 'string' && url.includes('/messages')) {
          return Promise.resolve(jsonResponse([]));
        }
        if (typeof url === 'string' && url.includes('/current-output')) {
          return Promise.resolve(
            jsonResponse({ isRunning: false, isGenerating: false, content: '', thinking: false }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            id: WORKTREE_ID,
            name: 'feature/2395',
            path: '/tmp/wt',
            repositoryPath: '/tmp/repo',
            repositoryName: 'CommandMate',
            agentInstances: ROSTER,
          }),
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  async function openToolsAgentTab(): Promise<void> {
    await waitFor(() => {
      expect(screen.getByTestId('mobile-tab-memo')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('mobile-tab-memo'));
    fireEvent.click(await screen.findByRole('button', { name: 'Agent' }));
  }

  it('carries a command palette trigger on the header, and it opens the palette', async () => {
    render(
      <CommandPaletteProvider>
        <PaletteProbe />
        <WorktreeDetailRefactored worktreeId={WORKTREE_ID} />
      </CommandPaletteProvider>,
    );

    // The route that hides GlobalMobileNav still renders this header.
    const trigger = await screen.findByTestId('mobile-header-command-palette-trigger');
    expect(screen.getByTestId('palette-open').textContent).toBe('closed');

    fireEvent.click(trigger);

    expect(screen.getByTestId('palette-open').textContent).toBe('open');
  });

  it('hands the Agent pane the instance the docked composer is addressing', async () => {
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
    await openToolsAgentTab();

    // `activeInstanceId` — the composer's send target — is the primary instance
    // until a tab is switched.
    await waitFor(() => {
      expect(screen.getByTestId('agent-pane-composer-target').textContent).toBe('claude');
    });
  });

  it('follows the composer when the operator switches agent tabs', async () => {
    // The value has to be the LIVE target, not the roster's first row: a
    // constant would pass the assertion above and still hide the wrong item.
    render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);

    fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));
    await openToolsAgentTab();

    await waitFor(() => {
      expect(screen.getByTestId('agent-pane-composer-target').textContent).toBe('codex');
    });
  });
});
