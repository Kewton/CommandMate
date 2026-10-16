/**
 * A whole-worktree Auto-Yes GET begun before a toggle POST does not roll the
 * toggle back when it lands after it (Issue #3723, re-review P2).
 *
 * The 12 s contract re-read made this reachable: a GET in flight reads an
 * alias's expired arming, the operator re-arms it, the POST answers ON, and the
 * late GET then wrote OFF — which also stopped the re-read (nothing armed). A
 * successful POST now advances the GETs' latest-request counter, so a GET begun
 * before it is discarded and one begun after it is adopted. Drawn from both
 * parents of the toggle: the phone composer and the PC split.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

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
const ALIAS = 'claude-2';
const NOTE = 'auto-yes-blocked-by-contract';

/** The server's state for the alias, as a GET begun NOW would read it. */
let armed: boolean;
let blocked: boolean;
/** While true, auto-yes GETs are parked in `held` instead of answered. */
let holdGets: boolean;
let held: Array<() => void>;
let autoYesGets: number;

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

function autoYesMap(): unknown {
  // Read when the GET starts: a held GET answers what the server said then.
  return {
    instances: {
      [ALIAS]: {
        enabled: armed,
        expiresAt: armed ? Date.now() + 3_600_000 : null,
        ...(armed && blocked ? { blockedByContract: true } : {}),
      },
    },
  };
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
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
          }),
        );
      }
      if (u.includes('/auto-yes') && method === 'POST') {
        armed = true;
        return Promise.resolve(
          jsonResponse({ enabled: true, expiresAt: Date.now() + 3_600_000, contractPolicy: null }),
        );
      }
      if (u.includes('/auto-yes')) {
        autoYesGets += 1;
        const body = autoYesMap();
        if (holdGets) {
          return new Promise<Response>((resolve) => {
            held.push(() => resolve(jsonResponse(body)));
          });
        }
        return Promise.resolve(jsonResponse(body));
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
          agentInstances: [{ id: ALIAS, cliTool: 'claude', alias: 'Claude 2', order: 0 }],
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
  window.localStorage.setItem(`activeInstanceId-${WORKTREE_ID}`, ALIAS);
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  armed = false;
  blocked = false;
  holdGets = false;
  held = [];
  autoYesGets = 0;
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

async function settle(ms = 300): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function toggle(): HTMLElement {
  return screen.getByRole('switch', { name: 'autoYes.toggleLabel' });
}

/** OFF -> ON through the confirm dialog, i.e. the arming POST. */
async function armThroughDialog(): Promise<void> {
  fireEvent.click(toggle());
  fireEvent.click(await screen.findByText('autoYes.agreeAndEnable'));
  await settle();
}

async function renderScreen(): Promise<void> {
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await settle();
  await screen.findByRole('switch', { name: 'autoYes.toggleLabel' });
}

describe.each([
  ['the phone composer', true],
  ['the PC split', false],
])('[#3723] %s: a GET older than the toggle', (_label, mobile) => {
  beforeEach(() => {
    viewport.mobile = mobile;
  });

  it('does not turn the toggle back OFF, and the contract re-read keeps running', async () => {
    holdGets = true; // the mount-time GETs read the alias's expired arming
    await renderScreen();
    expect(held.length).toBeGreaterThan(0);

    await armThroughDialog();
    expect(toggle().getAttribute('aria-checked')).toBe('true');

    holdGets = false;
    await act(async () => {
      for (const release of held.splice(0)) release();
    });
    await settle();
    expect(toggle().getAttribute('aria-checked')).toBe('true');

    const before = autoYesGets;
    await settle(AUTO_YES_CONTRACT_REFRESH_MS);
    await settle();
    expect(autoYesGets).toBeGreaterThan(before);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('adopts a GET begun after the toggle: a contract that started shows the note', async () => {
    await renderScreen();
    await armThroughDialog();
    expect(screen.queryByTestId(NOTE)).toBeNull();

    blocked = true; // a mode: off task starts running after the toggle
    await settle(AUTO_YES_CONTRACT_REFRESH_MS);
    await settle();

    expect(screen.getByTestId(NOTE)).toBeInTheDocument();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});
