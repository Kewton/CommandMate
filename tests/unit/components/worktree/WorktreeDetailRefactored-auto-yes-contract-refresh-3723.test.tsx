/**
 * The Auto Yes toggle's "blocked by contract" note follows a contract that
 * starts or ends while the worktree detail is open (Issue #3723, review P2).
 *
 * The current-output poll does not carry the contract verdict, so
 * `useWorktreeDetailController` re-reads the whole-worktree Auto-Yes map every
 * AUTO_YES_CONTRACT_REFRESH_MS while any instance is armed. Drawn from both
 * parents of the toggle: the phone composer (WorktreeDetailRefactored) and the
 * PC split (WorktreeDetailDesktop -> TerminalSplitPaneContent). Harness copied
 * from `WorktreeDetailRefactored-auto-yes-enter-sent-3397.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3723',
  useSearchParams: () => new URLSearchParams(),
}));

const viewport = vi.hoisted(() => ({ mobile: true }));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => viewport.mobile,
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
  TerminalDisplay: () => (
    <div data-testid="terminal-display">
      <div role="log" />
    </div>
  ),
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: () => (
    <div data-testid="chat-transcript">
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

vi.mock('@/components/worktree/NavigationButtons', () => ({
  NavigationButtons: () => <div data-testid="navigation-buttons" />,
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
import { AUTO_YES_CONTRACT_REFRESH_MS } from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-3723';
const NOTE = 'auto-yes-blocked-by-contract';

/** What the fetch stub answers; tests flip it between re-reads. */
let autoYesEnabled: boolean;
let blocked: boolean;
let autoYesMapGets: number;

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

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/current-output')) {
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
            fullOutput: 'row 1',
            realtimeSnippet: 'row 1',
            thinking: false,
            sessionStatus: 'ready',
            isSelectionListActive: false,
            isPagerActive: false,
            isUnclassifiedActive: false,
            isPromptWaiting: false,
            promptData: null,
            // No contract verdict here: the route does not carry one.
            autoYes: { enabled: autoYesEnabled, expiresAt: null, lastSuppression: null },
          }),
        );
      }
      if (u.includes('/auto-yes') && (init?.method ?? 'GET') === 'GET') {
        autoYesMapGets += 1;
        return Promise.resolve(
          jsonResponse({
            instances: {
              claude: {
                enabled: autoYesEnabled,
                expiresAt: null,
                ...(autoYesEnabled && blocked ? { blockedByContract: true } : {}),
              },
            },
          }),
        );
      }
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      if (u.includes('/tasks')) return Promise.resolve(jsonResponse({ tasks: [] }));
      if (u.includes('/verify/runs')) return Promise.resolve(jsonResponse({ runs: [] }));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/3723',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          selectedAgents: ['claude'],
          agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
          sessionStatusByCli: {
            claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
          },
        }),
      );
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  autoYesEnabled = true;
  blocked = false;
  autoYesMapGets = 0;
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'row 1',
      realtimeSnippet: 'row 1',
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
  useSplitMessagesMock.mockReturnValue({ messages: [], isLoading: false, refresh: vi.fn(() => Promise.resolve()) });
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

/** Let pending responses land without crossing a re-read. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

async function nextReread(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_YES_CONTRACT_REFRESH_MS);
  });
  await settle();
}

async function renderScreen(): Promise<void> {
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await settle();
  await screen.findAllByRole('switch');
}

describe.each([
  ['the phone composer', true],
  ['the PC split', false],
])('[#3723] %s: the note follows the contract', (_label, mobile) => {
  beforeEach(() => {
    viewport.mobile = mobile;
  });

  it('appears when a re-read says blocked, and goes when it no longer does', async () => {
    await renderScreen();
    expect(screen.queryByTestId(NOTE)).toBeNull();

    blocked = true; // a mode: off task starts running
    await nextReread();
    expect(screen.getByTestId(NOTE)).toBeInTheDocument();

    // The current-output poll in between keeps it (it carries no verdict).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(screen.getByTestId(NOTE)).toBeInTheDocument();

    blocked = false; // the task ends
    await nextReread();
    expect(screen.queryByTestId(NOTE)).toBeNull();
  });

  it('re-reads nothing while Auto-Yes is off on every instance', async () => {
    autoYesEnabled = false;
    blocked = true;
    await renderScreen();
    const afterMount = autoYesMapGets;

    await nextReread();
    await nextReread();

    expect(autoYesMapGets).toBe(afterMount);
    expect(screen.queryByTestId(NOTE)).toBeNull();
  });
});
