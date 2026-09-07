/**
 * The phone's composer and the "Queued (session busy)" toast (Issue #2406).
 *
 * Two properties, and they are opposite sides of the same wire:
 *
 *  1. Before #2406 `MobileComposer` never passed `isProcessing` at all, so
 *     `MessageInput` fell back to its `= false` default and the #806 toast could
 *     not fire on a phone even mid-turn. That is the defect this suite's
 *     "generating" case pins.
 *  2. It must not overshoot into PC's bug either: a live-but-idle session
 *     (`isRunning: true`, `isProcessing: false`) must stay silent.
 *
 * Rendered with the REAL `ToastProvider` / `ToastContainer`, the real
 * `MobileComposer` and the real `MessageInput`, so the assertion is the toast a
 * user would see rather than a prop's value. The screen's own status payload
 * (`sessionStatusByInstance`) is the only thing varied between the two cases.
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
  usePathname: () => '/worktrees/wt-2406',
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

const WORKTREE_ID = 'wt-2406';
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

/**
 * The one thing the two cases differ on: the active instance's status triple.
 * `isProcessing` here is `sessionStatusToActivityFlags(status).isProcessing` —
 * true for exactly `status === 'running'` (`lib/session/status-mapping.ts`).
 * `isRunning` stays true in BOTH so neither case can pass merely because the
 * pane looks dead.
 */
function stubFetch(instanceStatus: { isRunning: boolean; isProcessing: boolean }): void {
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
          name: 'fix/2406',
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

async function sendFromPhoneComposer(text: string): Promise<void> {
  render(
    <ToastProvider>
      <WorktreeDetailRefactored worktreeId={WORKTREE_ID} />
    </ToastProvider>,
  );
  await waitFor(() => {
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
  });
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /send message/i }));
}

describe('[#2406] mobile composer: the queued-send toast follows the generating verdict', () => {
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

  it('toasts when the agent is generating (the case the phone could never show)', async () => {
    stubFetch({ isRunning: true, isProcessing: true });
    await sendFromPhoneComposer('status please');

    expect(await screen.findByText(QUEUED_TOAST)).toBeInTheDocument();
  });

  it('stays silent when the session is alive but the agent is idle', async () => {
    stubFetch({ isRunning: true, isProcessing: false });
    await sendFromPhoneComposer('status please');

    // The send itself has to have happened, or "no toast" would be vacuous.
    await waitFor(() => {
      const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const urls = calls.map((call) => String(call[0]));
      expect(urls.some((u) => u.endsWith('/send'))).toBe(true);
    });
    expect(screen.queryByText(QUEUED_TOAST)).not.toBeInTheDocument();
  });
});
