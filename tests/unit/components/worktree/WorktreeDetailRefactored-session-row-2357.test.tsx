/**
 * The session row's wiring on the phone screen (Issue #2357).
 *
 * `MobileTerminalTab` is unit-tested with the worktrees cache mocked
 * (`MobileTerminalTab-session-row-2357.test.tsx`). What that suite cannot
 * prove is that the row is fed on the REAL screen: the model rides on the
 * `/api/worktrees` list the app-wide `WorktreesCacheProvider` polls, and the
 * tab sits several components below the screen inside `MobileContent`, which
 * builds its props and knows nothing about the cache. So the whole screen is
 * rendered under the real provider, the API is the only thing mocked, and the
 * assertion is that the row shows the label the PC split header would show
 * for the same `sessionStatusByInstance` entry.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { formatAgentModelLabel } from '@/components/worktree/WorktreeDetailSubComponents';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2357-screen',
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
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
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
import { WorktreesCacheProvider } from '@/components/providers/WorktreesCacheProvider';

const WORKTREE_ID = 'wt-2357-screen';

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
      output: '',
      realtimeSnippet: '',
      isRunning: true,
      isThinking: false,
      sessionStatus: 'ready',
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
  useSplitMessagesMock.mockReturnValue({
    messages: [],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  });
}

/** The worktree row, with what the status probe knows about each instance. */
function worktreePayload(sessionStatusByInstance: Record<string, unknown>) {
  return {
    id: WORKTREE_ID,
    name: 'feature/2357',
    path: '/tmp/wt',
    repositoryPath: '/tmp/repo',
    repositoryName: 'CommandMate',
    selectedAgents: ['claude'],
    agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
    sessionStatusByCli: {
      claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
    },
    sessionStatusByInstance,
  };
}

function stubApi(sessionStatusByInstance: Record<string, unknown>): void {
  const worktree = worktreePayload(sessionStatusByInstance);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      // The list the cache polls — the row's source.
      if (url === '/api/worktrees') {
        return Promise.resolve(jsonResponse({ worktrees: [worktree], repositories: [] }));
      }
      if (typeof url === 'string' && url.includes('/current-output')) {
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
            fullOutput: '',
            realtimeSnippet: '',
            thinking: false,
            sessionStatus: 'ready',
            isSelectionListActive: false,
            isPagerActive: false,
            isUnclassifiedActive: false,
            isPromptWaiting: false,
            promptData: null,
          }),
        );
      }
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(jsonResponse(worktree));
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  mockPaneState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#2357] the phone screen feeds the session row from the worktrees cache', () => {
  it('shows the active instance’s model and effort in the PC split header’s words', async () => {
    stubApi({
      claude: {
        isRunning: true,
        isWaitingForResponse: false,
        isProcessing: false,
        model: 'claude-opus-5[1m]',
        reasoningEffort: 'xhigh',
      },
    });
    render(
      <WorktreesCacheProvider>
        <WorktreeDetailRefactored worktreeId={WORKTREE_ID} />
      </WorktreesCacheProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('mobile-session-row')).toBeInTheDocument();
    });
    // Exactly what `WorktreeDetailDesktop` hands `TerminalSplitPaneContent`.
    const expected = formatAgentModelLabel('claude-opus-5[1m]', 'xhigh')!;
    expect(screen.getByTestId('mobile-session-model')).toHaveTextContent(expected);
    expect(screen.getByTestId('mobile-session-model')).toHaveTextContent('claude-opus-5[1m] · xhigh');
  });

  it('shows no row while the active instance has reported no model', async () => {
    stubApi({
      claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
    });
    render(
      <WorktreesCacheProvider>
        <WorktreeDetailRefactored worktreeId={WORKTREE_ID} />
      </WorktreesCacheProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('mobile-terminal-region')).toBeInTheDocument();
    });
    // Give the cache's first poll time to land; the row must still be absent.
    await waitFor(() => {
      expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([u]) => u === '/api/worktrees')).toBe(true);
    });
    expect(screen.queryByTestId('mobile-session-row')).not.toBeInTheDocument();
  });
});
