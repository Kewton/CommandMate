/**
 * The phone's prompt sheet offers no Send for a window `/prompt-response`
 * would refuse (Issue #2870).
 *
 * `promptAnswerable: false` on `/current-output` travels through
 * `useWorktreeDetailController` to the REAL `MobilePromptSheet`: the options
 * stay, Send is disabled, and the direct-input hint and its link are drawn with
 * no failed Send first. Harness copied from
 * `WorktreeDetailRefactored-prompt-stuck-2869.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getMobileSurfaceModeStorageKey } from '@/config/surface-mode-config';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2870',
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

const WORKTREE_ID = 'wt-2870';

/** What the fetch stub answers; each test edits it before (or while) rendering. */
interface Scenario {
  claudeRunning: boolean;
  autoYes: boolean;
  prompt: null | { multiSelect: boolean };
  selectionList: boolean;
  /** The worktree has a task row, so the verification strip is drawn (Issue #2824). */
  hasTask: boolean;
  /** The worktree's branch differs from its initial one, so the mismatch alert is drawn (Issue #2824). */
  branchMismatch: boolean;
  /** Issue #2870: the poll's `promptAnswerable`; undefined leaves the key out. */
  answerable: boolean | undefined;
}
let scenario: Scenario;
let directInputPosts: Array<{ cliToolId: string; events: unknown[]; instanceId?: string }>;
let promptResponsePosts: unknown[];

/** `GET /tasks?limit=1` row for `scenario.hasTask` (Issue #2824). */
const TASK_ROW = {
  id: 'task-2799',
  worktreeId: WORKTREE_ID,
  cliToolId: 'claude',
  instanceId: 'claude',
  title: 'Issue #2799: direct input',
  goal: 'goal',
  contractPath: '.commandmate/tasks/issue-2799.yaml',
  contract: {
    version: 1,
    title: 'Issue #2799: direct input',
    goal: 'goal',
    scope: { allow: ['src/**'], deny: [] },
    verify: { gates: ['lint'], gateDefinitions: [] },
    autoYes: { mode: null, allowPromptTypes: [], denyPatterns: [] },
    success: {
      requireWorkEvidence: true,
      requireScopeClean: true,
      requireCommit: false,
      requireEnvClean: false,
      autoVerifyOnStop: false,
    },
  },
  status: 'succeeded',
  lastVerificationRunId: null,
  createdAt: '2026-09-21T06:04:23.075Z',
  updatedAt: '2026-09-21T07:29:36.969Z',
  startedAt: '2026-09-21T06:04:26.451Z',
  finishedAt: '2026-09-21T07:29:36.969Z',
};

/** `gitStatus` for `scenario.branchMismatch` (Issue #2824). */
const MISMATCHED_GIT_STATUS = {
  currentBranch: 'main',
  initialBranch: 'feature/2799',
  isBranchMismatch: true,
  commitHash: 'abc1234',
  isDirty: false,
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

function promptPayload(): Record<string, unknown> {
  if (scenario.prompt === null) return { isPromptWaiting: false, promptData: null };
  return {
    isPromptWaiting: true,
    promptData: {
      type: 'multiple_choice',
      question: 'Which caches should I clear?',
      status: 'pending',
      isAskUserQuestion: true,
      ...(scenario.prompt.multiSelect ? { multiSelect: true } : {}),
      options: [
        { number: 1, label: 'node_modules', isDefault: true },
        { number: 2, label: 'dist', isDefault: false },
      ],
    },
    ...(scenario.answerable !== undefined ? { promptAnswerable: scenario.answerable } : {}),
  };
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/prompt-response')) {
        promptResponsePosts.push(JSON.parse(String(init?.body ?? '{}')));
        return Promise.resolve(
          jsonResponse({ success: false, reason: 'prompt_no_longer_active', answer: '1' }),
        );
      }
      if (u.includes('/direct-input')) {
        directInputPosts.push(JSON.parse(String(init?.body ?? '{}')));
        return Promise.resolve(jsonResponse({ success: true }));
      }
      if (u.includes('/current-output')) {
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
            fullOutput: 'row 1\nrow 2',
            realtimeSnippet: 'row 2',
            thinking: false,
            sessionStatus: 'ready',
            isSelectionListActive: scenario.selectionList,
            isPagerActive: false,
            isUnclassifiedActive: false,
            ...promptPayload(),
          }),
        );
      }
      if (u.includes('/auto-yes')) {
        return Promise.resolve(
          jsonResponse({ instances: { claude: { enabled: scenario.autoYes, expiresAt: null } } }),
        );
      }
      if (u.includes('/messages')) return Promise.resolve(jsonResponse([]));
      if (u.includes('/tasks')) {
        return Promise.resolve(jsonResponse({ tasks: scenario.hasTask ? [TASK_ROW] : [] }));
      }
      if (u.includes('/verify/runs')) return Promise.resolve(jsonResponse({ runs: [] }));
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/2799',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          selectedAgents: ['claude', 'codex'],
          agentInstances: [
            { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
            { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
          ],
          sessionStatusByCli: {
            claude: { isRunning: scenario.claudeRunning, isWaitingForResponse: false, isProcessing: false },
            codex: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
          },
          ...(scenario.branchMismatch ? { gitStatus: MISMATCHED_GIT_STATUS } : {}),
        }),
      );
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  scenario = {
    claudeRunning: true,
    autoYes: false,
    prompt: null,
    selectionList: false,
    hasTask: false,
    branchMismatch: false,
    answerable: undefined,
  };
  directInputPosts = [];
  promptResponsePosts = [];
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: 'row 1\nrow 2',
      realtimeSnippet: 'row 2',
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

async function renderScreen() {
  const utils = render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await screen.findByTestId('mobile-more-actions-button');
  return utils;
}

describe('[#2870] an unanswerable prompt on the phone', () => {
  beforeEach(() => {
    scenario.prompt = { multiSelect: false };
    window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
  });

  it('keeps the options, disables Send and shows the hint with no Send first', async () => {
    scenario.answerable = false;
    await renderScreen();

    const sheet = await screen.findByTestId('mobile-prompt-sheet');
    const hint = await within(sheet).findByTestId('prompt-unanswerable-hint');
    expect(hint).toHaveTextContent('worktree.promptResponse.unanswerable');
    expect(within(sheet).getByText(/node_modules/)).toBeInTheDocument();
    const send = within(sheet).getByRole('button', { name: 'prompt.submit' });
    expect(send).toBeDisabled();
    const radios = within(sheet).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    for (const radio of radios) expect(radio).toBeDisabled();

    fireEvent.click(send);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(promptResponsePosts).toHaveLength(0);
    expect(screen.queryByTestId('prompt-stuck-hint')).not.toBeInTheDocument();
  });

  it('opens the direct-input keyboard on the terminal surface from the link', async () => {
    scenario.answerable = false;
    await renderScreen();
    await screen.findByTestId('mobile-chat-surface');

    const hint = await screen.findByTestId('prompt-unanswerable-hint');
    fireEvent.click(within(hint).getByRole('button', { name: 'worktree.promptResponse.stuckHintLink' }));

    await screen.findByTestId('mobile-direct-input-keyboard');
    expect(screen.getByTestId('mobile-tab-terminal')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.queryByTestId('mobile-chat-surface')).not.toBeInTheDocument());
    expect(window.localStorage.getItem(getMobileSurfaceModeStorageKey(WORKTREE_ID))).toBe('terminal');
    expect(directInputPosts).toHaveLength(0);
  });

  it.each([[undefined], [true]])('is unchanged when promptAnswerable is %s', async (value) => {
    scenario.answerable = value;
    await renderScreen();

    const sheet = await screen.findByTestId('mobile-prompt-sheet');
    await waitFor(() => expect(within(sheet).getByRole('button', { name: 'prompt.submit' })).toBeEnabled());
    expect(screen.queryByTestId('prompt-unanswerable-hint')).not.toBeInTheDocument();
  });
});
