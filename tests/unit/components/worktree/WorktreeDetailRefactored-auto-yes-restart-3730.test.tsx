/**
 * The Auto Yes toggle says "released by restart" when the server reports the
 * last restart released this instance's grant (Issue #3730).
 *
 * Seeded by the whole-worktree `GET .../auto-yes` map (the first read when the
 * screen opens), kept by the current-output poll while that poll still reports
 * `stopReason: 'server-restart'`, and gone once it does not. Drawn from both
 * parents of the toggle: the phone composer (WorktreeDetailRefactored) and the
 * PC split (WorktreeDetailDesktop -> TerminalSplitPaneContent). Harness copied
 * from `WorktreeDetailRefactored-auto-yes-contract-refresh-3723.test.tsx`.
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
  usePathname: () => '/worktrees/wt-3730',
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

const WORKTREE_ID = 'wt-3730';
const LABEL = 'auto-yes-released-by-restart';

/** What the server says about claude's Auto-Yes; tests flip it between polls. */
let released: boolean;
/**
 * The deadline of an alias (`claude-2`) restart notice, or null for no alias
 * state. The fake server says `server-restart` until then, as the real one does
 * (the notice lives until the released grant's own deadline).
 */
let aliasDeadline: number | null;
type RosterEntry = { id: string; cliTool: string; alias: string; order: number };
let roster: RosterEntry[];

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
            autoYes: {
              enabled: false,
              expiresAt: null,
              lastSuppression: null,
              ...(released ? { stopReason: 'server-restart' } : {}),
            },
          }),
        );
      }
      if (u.includes('/auto-yes') && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(
          jsonResponse({
            instances: {
              claude: {
                enabled: false,
                expiresAt: null,
                ...(released ? { stopReason: 'server-restart' } : {}),
              },
              ...(aliasDeadline !== null && Date.now() < aliasDeadline
                ? { 'claude-2': { enabled: false, expiresAt: aliasDeadline, stopReason: 'server-restart' } }
                : {}),
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
          name: 'feature/3730',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          selectedAgents: ['claude'],
          agentInstances: roster,
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
  released = true;
  aliasDeadline = null;
  roster = [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }];
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

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

async function renderScreen(): Promise<void> {
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await settle();
  await screen.findAllByRole('switch');
}

describe.each([
  ['the phone composer', true],
  ['the PC split', false],
])('[#3730] %s: the restart label', (_label, mobile) => {
  beforeEach(() => {
    viewport.mobile = mobile;
  });

  it('shows on open, survives the current-output poll, and goes when the server stops saying it', async () => {
    await renderScreen();
    expect(screen.getByTestId(LABEL)).toBeInTheDocument();
    expect(screen.getAllByRole('switch')[0].getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(screen.getByTestId(LABEL)).toBeInTheDocument();

    released = false; // the grant's deadline passed, or it was toggled elsewhere
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    await settle();
    expect(screen.queryByTestId(LABEL)).toBeNull();
  });

  it('negative control: a plain OFF shows no label', async () => {
    released = false;
    await renderScreen();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(screen.queryByTestId(LABEL)).toBeNull();
  });
});

describe('[#3730 review] the PC split: an alias notice ends at its own deadline with everything OFF', () => {
  const DEADLINE_IN = 60_000;

  beforeEach(() => {
    viewport.mobile = false;
    // The split shows the alias; the parent's current-output poll is about the
    // primary and says nothing about claude-2.
    released = false;
    roster = [
      { id: 'claude-2', cliTool: 'claude', alias: 'Claude 2', order: 0 },
      { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 1 },
    ];
    aliasDeadline = Date.now() + DEADLINE_IN;
  });

  it('positive: the alias label goes once its deadline has passed', async () => {
    await renderScreen();
    expect(screen.getByTestId(LABEL)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEADLINE_IN + 15_000);
    });
    await settle();
    expect(screen.queryByTestId(LABEL)).toBeNull();
  });

  it('negative: before the deadline the alias label stays', async () => {
    await renderScreen();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEADLINE_IN - 10_000);
    });
    await settle();
    expect(screen.getByTestId(LABEL)).toBeInTheDocument();
  });
});
