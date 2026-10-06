/**
 * The phone's prompt sheet says "Auto-Yes sent Enter" for a window Auto-Yes
 * sent its Enter to (Issue #3397).
 *
 * `autoYes.lastEnterFallback` on `/current-output` travels through
 * `useWorktreeDetailController` (`promptAutoYesEnterSent`) to the REAL
 * `MobilePromptSheet`. Only `outcome: 'sent'` with `currentPrompt: true` turns
 * the warning into the line; `no-effect`, a record about another screen and no
 * record keep the warning and its link. Harness copied from
 * `WorktreeDetailRefactored-prompt-unanswerable-2870.test.tsx`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
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
  usePathname: () => '/worktrees/wt-3397',
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

const WORKTREE_ID = 'wt-3397';

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
  /** Issue #3397: the poll's `autoYes.lastEnterFallback`; undefined leaves `autoYes` out. */
  enterFallback: Record<string, unknown> | null | undefined;
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

function autoYesPayload(): Record<string, unknown> {
  if (scenario.enterFallback === undefined && !scenario.autoYes) return {};
  return {
    autoYes: {
      enabled: scenario.autoYes,
      expiresAt: null,
      lastSuppression: null,
      ...(scenario.enterFallback === undefined ? {} : { lastEnterFallback: scenario.enterFallback }),
    },
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
            ...autoYesPayload(),
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
    enterFallback: undefined,
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

const SENT = {
  outcome: 'sent',
  promptType: 'multiple_choice',
  refusalReason: 'unsupported_dialog_layout',
  sentAt: 1_000,
  at: 1_000,
  currentPrompt: true,
};

describe('[#3397] the phone prompt sheet and the Enter record', () => {
  beforeEach(() => {
    scenario.prompt = { multiSelect: false };
    scenario.answerable = false;
    window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
  });

  it('says Auto-Yes sent Enter, in place of the warning and the link', async () => {
    scenario.enterFallback = SENT;
    await renderScreen();

    const sheet = await screen.findByTestId('mobile-prompt-sheet');
    const line = await within(sheet).findByTestId('prompt-auto-yes-enter-sent');
    expect(line).toHaveTextContent('worktree.promptResponse.autoYesEnterSent');
    expect(within(sheet).queryByTestId('prompt-unanswerable-hint')).not.toBeInTheDocument();
    expect(within(sheet).queryByTestId('prompt-stuck-hint-link')).not.toBeInTheDocument();
  });

  it.each([
    ['no-effect', { ...SENT, outcome: 'no-effect' }],
    ['a record about another screen', { ...SENT, currentPrompt: false }],
    ['no record', null],
    ['a server older than the field', undefined],
  ])('%s: the warning and the link, as before', async (_label, record) => {
    scenario.enterFallback = record;
    await renderScreen();

    const sheet = await screen.findByTestId('mobile-prompt-sheet');
    await within(sheet).findByTestId('prompt-unanswerable-hint');
    expect(within(sheet).getByTestId('prompt-stuck-hint-link')).toBeInTheDocument();
    expect(within(sheet).queryByTestId('prompt-auto-yes-enter-sent')).not.toBeInTheDocument();
  });
});

/**
 * Review round 3: Auto-Yes ON. The sheet is hidden under Auto-Yes for a
 * prompt Auto-Yes answers, and the Enter only ever goes out under Auto-Yes —
 * so without the `answerable === false` exception none of the lines above
 * could be seen. Turning that exception off fails the first two cases here.
 */
describe('[#3397] the phone prompt sheet under Auto-Yes', () => {
  beforeEach(() => {
    scenario.prompt = { multiSelect: false };
    scenario.autoYes = true;
    window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
  });

  /** Let the polls land (the sheet's Auto-Yes gate reads both responses). */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  }

  it('unreadable screen, Enter sent: the sheet is shown and says so', async () => {
    scenario.answerable = false;
    scenario.enterFallback = SENT;
    await renderScreen();
    await settle();

    const sheet = await screen.findByTestId('mobile-prompt-sheet');
    expect(within(sheet).getByTestId('prompt-auto-yes-enter-sent')).toBeInTheDocument();
    expect(within(sheet).queryByTestId('prompt-stuck-hint-link')).not.toBeInTheDocument();
  });

  it.each([
    ['no-effect', { ...SENT, outcome: 'no-effect' }],
    ['no record', null],
  ])('unreadable screen, %s: the sheet is shown with the warning and the link', async (_label, record) => {
    scenario.answerable = false;
    scenario.enterFallback = record;
    await renderScreen();
    await settle();

    const sheet = await screen.findByTestId('mobile-prompt-sheet');
    expect(within(sheet).getByTestId('prompt-unanswerable-hint')).toBeInTheDocument();
    expect(within(sheet).getByTestId('prompt-stuck-hint-link')).toBeInTheDocument();
  });

  it.each([[true], [undefined]])('readable screen (answerable %s): hidden as before — Auto-Yes answers it', async (value) => {
    scenario.answerable = value;
    scenario.enterFallback = null;
    await renderScreen();
    await settle();

    expect(screen.queryByTestId('mobile-prompt-sheet')).not.toBeInTheDocument();
  });
});

