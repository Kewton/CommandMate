/**
 * The Auto Yes toggle on the worktree screen shows the answer mode, and the
 * confirm dialog's choice reaches `POST .../auto-yes` (Issue #3863).
 *
 * Drawn from both parents of the toggle: the phone composer
 * (WorktreeDetailRefactored) and the PC split (WorktreeDetailDesktop ->
 * TerminalSplitPaneContent). The mode comes from the whole-worktree map's
 * `answerModeByInstance` (re-read while armed, so another tab's change shows
 * up), the current-output poll's `autoYesAnswerMode` and the POST's answer;
 * a server that names none shows nothing. Harness copied from
 * `WorktreeDetailRefactored-auto-yes-contract-refresh-3723.test.tsx`.
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
  usePathname: () => '/worktrees/wt-3863',
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

const WORKTREE_ID = 'wt-3863';
const LABEL = 'auto-yes-answer-mode';
const EXPIRES = Date.now() + 3_600_000;

type Mode = 'recommended' | 'careful';

/** The fake server's state; tests flip it between re-reads. */
let enabled: boolean;
/** The mode the server holds; undefined with `olderServer` names none anywhere. */
let mode: Mode;
let olderServer: boolean;
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
            autoYes: { enabled, expiresAt: enabled ? EXPIRES : null, lastSuppression: null },
            ...(enabled && !olderServer ? { autoYesAnswerMode: mode } : {}),
          }),
        );
      }
      if (u.includes('/auto-yes') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        posts.push(body);
        enabled = body.enabled === true;
        if (enabled) mode = (body.answerMode as Mode | undefined) ?? 'recommended';
        return Promise.resolve(
          jsonResponse({
            enabled,
            expiresAt: enabled ? EXPIRES : null,
            ...(enabled && !olderServer ? { answerMode: mode } : {}),
          }),
        );
      }
      if (u.includes('/auto-yes')) {
        return Promise.resolve(
          jsonResponse({
            instances: { claude: { enabled, expiresAt: enabled ? EXPIRES : null } },
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
  enabled = true;
  mode = 'careful';
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

function autoYesSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'autoYes.toggleLabel' });
}

describe.each([
  ['the phone composer', true],
  ['the PC split', false],
])('[#3863] %s: the answer mode label', (_label, mobile) => {
  beforeEach(() => {
    viewport.mobile = mobile;
  });

  it('shows the server\'s mode, and follows another tab\'s change on the next re-read', async () => {
    await renderScreen();
    expect(screen.getByTestId(LABEL).getAttribute('data-answer-mode')).toBe('careful');

    mode = 'recommended'; // another tab turned it on again in おまかせ
    await nextReread();
    expect(screen.getByTestId(LABEL).getAttribute('data-answer-mode')).toBe('recommended');
  });

  it('shows nothing for a server that names no mode (negative control)', async () => {
    olderServer = true;
    await renderScreen();
    await nextReread();

    expect(autoYesSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId(LABEL)).toBeNull();
  });

  it('turning it on in 慎重 posts careful and shows it', async () => {
    enabled = false;
    await renderScreen();
    expect(screen.queryByTestId(LABEL)).toBeNull();

    fireEvent.click(autoYesSwitch());
    fireEvent.click(screen.getByTestId('auto-yes-answer-mode-careful'));
    fireEvent.click(screen.getByTestId('confirm-button'));
    await settle();

    expect(posts.at(-1)).toMatchObject({ enabled: true, instanceId: 'claude', answerMode: 'careful' });
    expect(screen.getByTestId(LABEL).getAttribute('data-answer-mode')).toBe('careful');
  });

  it('turning it on in おまかせ posts recommended explicitly and shows it', async () => {
    enabled = false;
    await renderScreen();

    fireEvent.click(autoYesSwitch());
    fireEvent.click(screen.getByTestId('auto-yes-answer-mode-recommended'));
    fireEvent.click(screen.getByTestId('confirm-button'));
    await settle();

    expect(posts.at(-1)).toMatchObject({ enabled: true, answerMode: 'recommended' });
    expect(screen.getByTestId(LABEL).getAttribute('data-answer-mode')).toBe('recommended');
  });
});
