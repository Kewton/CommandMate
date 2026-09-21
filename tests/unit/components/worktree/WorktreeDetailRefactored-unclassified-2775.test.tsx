/**
 * The phone's agent tabs, and its composer, read an unreadable frame as
 * "cannot tell" rather than as work in progress (Issue #2775).
 *
 * Same harness as `WorktreeDetailRefactored-queued-toast-2406.test.tsx`: the
 * real screen, the real `MobileComposer` / `MessageInput` and the real toast
 * stack, with the worktree payload as the only input varied. The entries are
 * the shapes the list API publishes (`worktree-status-unclassified-2775`).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  usePathname: () => '/worktrees/wt-2775',
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
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
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
import { ToastProvider } from '@/components/common/Toast';

const WORKTREE_ID = 'wt-2775';
const QUEUED_TOAST = /Queued \(session busy\)/;

const CREATED_ROW = {
  id: 'srv-1',
  worktreeId: WORKTREE_ID,
  role: 'user',
  content: 'status please',
  timestamp: '2026-09-08T10:20:30.000Z',
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

function mockPaneState(): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'output',
      realtimeSnippet: 'output',
      isRunning: false,
      isThinking: false,
      sessionStatus: '',
      isSelectionListActive: false,
      isPagerActive: false,
      isDismissablePanelActive: false,
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

/** The active instance's status entry is the only thing varied between cases. */
function stubFetch(instanceStatus: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.endsWith('/send')) {
        return Promise.resolve(jsonResponse(CREATED_ROW, 201));
      }
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      if (typeof url === 'string' && url.includes('/current-output')) {
        return Promise.resolve(jsonResponse({ isRunning: false, content: '', thinking: false }));
      }
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'fix/2775',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          sessionStatusByInstance: {
            claude: { ...instanceStatus, isWaitingForResponse: false },
          },
        }),
      );
    }),
  );
}


const UNCLASSIFIED = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: false,
  statusEvidence: 'none',
  sessionStatusReason: 'default',
  isUnclassified: true,
};

const THINKING = {
  isRunning: true,
  isWaitingForResponse: false,
  isProcessing: true,
  statusEvidence: 'positive',
  sessionStatusReason: 'thinking_indicator',
};

async function renderPhone(): Promise<void> {
  render(
    <ToastProvider>
      <WorktreeDetailRefactored worktreeId={WORKTREE_ID} />
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
  });
}

describe('[#2775] mobile: an unclassified session', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    mockPaneState();
    useSplitMessagesMock.mockReturnValue({
      messages: [],
      isLoading: false,
      refresh: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('the agent tab dot is the "cannot tell" ring, labelled Unknown', async () => {
    stubFetch(UNCLASSIFIED);
    await renderPhone();

    const dot = await screen.findByLabelText('Claude: Unknown');
    expect(dot).toHaveAttribute('data-unclassified', 'true');
    expect(dot.className).toContain('bg-transparent');
    expect(dot.className).not.toMatch(/animate-status-glow/);
  });

  it('a positive running tab still glows, labelled Running', async () => {
    stubFetch(THINKING);
    await renderPhone();

    const dot = await screen.findByLabelText('Claude: Running');
    expect(dot).not.toHaveAttribute('data-unclassified');
    expect(dot.className).toMatch(/animate-status-glow/);
  });

  it('sending to it does not claim the session is busy', async () => {
    stubFetch(UNCLASSIFIED);
    await renderPhone();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'status please' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    // The send itself has to have happened, or "no toast" would be vacuous.
    await waitFor(() => {
      const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.map((call) => String(call[0])).some((u) => u.endsWith('/send'))).toBe(true);
    });
    expect(screen.queryByText(QUEUED_TOAST)).not.toBeInTheDocument();
  });
});
