/**
 * Turning Auto-Yes on for 5h / 24h from the worktree screen (Issue #3913).
 *
 * Drawn from both parents of the toggle: the phone composer
 * (WorktreeDetailRefactored) and the PC split (WorktreeDetailDesktop ->
 * TerminalSplitPaneContent). "その他" → 5h / 24h must reach
 * `POST .../auto-yes` as that many ms for the instance on screen, and the
 * remaining time is drawn from the `expiresAt` the POST answers. Cancelling
 * and reopening starts at 1h again. Harness copied from
 * `WorktreeDetailRefactored-auto-yes-answer-mode-3863.test.tsx`.
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
  usePathname: () => '/worktrees/wt-3913',
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

const WORKTREE_ID = 'wt-3913';

type Mode = 'recommended' | 'careful';

/** The fake server's state; tests flip it between re-reads. */
let enabled: boolean;
/** The mode the server holds; undefined with `olderServer` names none anywhere. */
let mode: Mode;
let olderServer: boolean;
/** The deadline the fake server holds for the claude instance. */
let expires: number;
let posts: Array<Record<string, unknown>>;

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
      const method = init?.method ?? 'GET';
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
            autoYes: { enabled, expiresAt: enabled ? expires : null, lastSuppression: null },
            ...(enabled && !olderServer ? { autoYesAnswerMode: mode } : {}),
          }),
        );
      }
      if (u.includes('/auto-yes') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        posts.push(body);
        enabled = body.enabled === true;
        if (enabled) mode = (body.answerMode as Mode | undefined) ?? 'recommended';
        if (enabled) expires = Date.now() + Number(body.duration ?? 3_600_000);
        return Promise.resolve(
          jsonResponse({
            enabled,
            expiresAt: enabled ? expires : null,
            ...(enabled && !olderServer ? { answerMode: mode } : {}),
          }),
        );
      }
      if (u.includes('/auto-yes')) {
        return Promise.resolve(
          jsonResponse({
            instances: { claude: { enabled, expiresAt: enabled ? expires : null } },
            ...(olderServer ? {} : { answerModeByInstance: enabled ? { claude: mode } : {} }),
          }),
        );
      }
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      if (u.includes('/tasks')) return Promise.resolve(jsonResponse({ tasks: [] }));
      if (u.includes('/verify/runs')) return Promise.resolve(jsonResponse({ runs: [] }));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/3863',
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
  enabled = false;
  expires = 0;
  mode = 'recommended';
  olderServer = false;
  posts = [];
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

function autoYesSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'autoYes.toggleLabel' });
}

const HOUR = 3_600_000;

function chooseOther(hours: number): void {
  fireEvent.click(screen.getByTestId('auto-yes-duration-other'));
  fireEvent.change(screen.getByTestId('auto-yes-duration-select'), { target: { value: String(hours * HOUR) } });
}

function remaining(): string | null {
  return screen.queryByLabelText('autoYes.timeRemaining')?.textContent ?? null;
}

describe.each([
  ['the phone composer', true],
  ['the PC split', false],
])('[#3913] %s: Auto-Yes duration', (_label, mobile) => {
  beforeEach(() => {
    viewport.mobile = mobile;
  });

  it.each([5, 24])('"その他" → %ih posts that many ms for the instance and shows the remaining time', async (hours) => {
    await renderScreen();

    fireEvent.click(autoYesSwitch());
    chooseOther(hours);
    fireEvent.click(screen.getByTestId('confirm-button'));
    await settle();

    const enables = posts.filter((p) => p.enabled === true);
    expect(enables).toHaveLength(1);
    expect(enables[0]).toMatchObject({ enabled: true, instanceId: 'claude', duration: hours * HOUR });
    expect(autoYesSwitch().getAttribute('aria-checked')).toBe('true');
    expect(remaining()).toMatch(new RegExp(`^(${hours}:00:00|${hours - 1}:59:[0-5]\\d)$`));
  });

  it('cancelling after choosing 24h and reopening posts 1h (negative control: the default)', async () => {
    await renderScreen();

    fireEvent.click(autoYesSwitch());
    chooseOther(24);
    fireEvent.click(screen.getByText('common.cancel'));
    fireEvent.click(autoYesSwitch());
    fireEvent.click(screen.getByTestId('confirm-button'));
    await settle();

    expect(posts.at(-1)).toMatchObject({ enabled: true, instanceId: 'claude', duration: HOUR });
  });
});
