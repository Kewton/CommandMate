/**
 * The phone's prompt sheet points at the direct-input keyboard once Send has
 * stopped working (Issue #2869).
 *
 * Rendered end to end with the REAL `MobilePromptSheet`, `MobileTerminalTab`
 * and keyboard, because the link's whole job crosses seams: the sheet is drawn
 * by `WorktreeDetailRefactored`, the chat/terminal surface is owned by
 * `MobileTerminalTab`, and the keyboard is closed by an effect of the screen
 * whenever the surface reads chat. `/prompt-response` refuses every answer
 * (`{ success: false }`), so the window stays; each refusal is followed by a
 * `/current-output` fetch, which hands over a freshly parsed `promptData` —
 * the "next display" the counter waits for.
 *
 * Harness copied from `WorktreeDetailRefactored-direct-input-2799.test.tsx`.
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
  usePathname: () => '/worktrees/wt-2869',
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

const WORKTREE_ID = 'wt-2869';

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

/** Press the sheet's Send and wait for the refusal and the re-fetch it triggers. */
async function pressSend(): Promise<void> {
  const before = promptResponsePosts.length;
  const sheet = await screen.findByTestId('mobile-prompt-sheet');
  await waitFor(() => expect(within(sheet).getByRole('button', { name: 'prompt.submit' })).toBeEnabled());
  fireEvent.click(within(sheet).getByRole('button', { name: 'prompt.submit' }));
  await waitFor(() => expect(promptResponsePosts).toHaveLength(before + 1));
  // The sheet is answerable again: the refusal landed and the re-fetch ran.
  await waitFor(() =>
    expect(within(screen.getByTestId('mobile-prompt-sheet')).getByRole('button', { name: 'prompt.submit' })).toBeEnabled(),
  );
}

describe('[#2869] the stuck-prompt hint on the phone', () => {
  beforeEach(() => {
    scenario.prompt = { multiSelect: false };
    window.localStorage.setItem(getMobileSurfaceModeStorageKey(WORKTREE_ID), 'chat');
  });

  it('is not shown after one Send that left the window up', async () => {
    await renderScreen();
    await screen.findByTestId('mobile-chat-surface');
    await pressSend();
    // Give the next poll a chance to be the one that miscounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId('prompt-stuck-hint')).not.toBeInTheDocument();
  });

  it('appears after the second Send on the chat surface; the link opens the keyboard on the terminal surface', async () => {
    await renderScreen();
    await screen.findByTestId('mobile-chat-surface');

    await pressSend();
    await pressSend();

    const hint = await screen.findByTestId('prompt-stuck-hint');
    expect(hint).toHaveTextContent('worktree.promptResponse.stuckHint');
    const link = within(hint).getByRole('button', { name: 'worktree.promptResponse.stuckHintLink' });
    expect(link).toHaveAttribute('type', 'button');

    fireEvent.click(link);

    const keyboard = await screen.findByTestId('mobile-direct-input-keyboard');
    // Terminal tab, terminal surface — and it stays open past the effects that
    // close it on the chat surface.
    expect(screen.getByTestId('mobile-tab-terminal')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.queryByTestId('mobile-chat-surface')).not.toBeInTheDocument());
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(keyboard).toBeInTheDocument();
    expect(screen.getByTestId('mobile-direct-input-keyboard')).toBe(keyboard);
    expect(window.localStorage.getItem(getMobileSurfaceModeStorageKey(WORKTREE_ID))).toBe('terminal');
    expect(directInputPosts).toHaveLength(0);
  });

  it('clears a stale ?view=chat from the URL so the terminal surface does not bounce back to chat (Issue #2888)', async () => {
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}?view=chat`);
    await renderScreen();
    await screen.findByTestId('mobile-chat-surface');

    await pressSend();
    await pressSend();

    fireEvent.click(await screen.findByRole('button', { name: 'worktree.promptResponse.stuckHintLink' }));

    const keyboard = await screen.findByTestId('mobile-direct-input-keyboard');
    expect(screen.getByTestId('mobile-tab-terminal')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.queryByTestId('mobile-chat-surface')).not.toBeInTheDocument());
    // The remount that follows re-reads `resolveSurfaceMode`, which lets a live
    // `?view=` out-rank the localStorage write above; without clearing it first
    // the surface (and the keyboard it gates) would bounce straight back to chat.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(keyboard).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('opens the keyboard on the Terminal tab when the sheet was answered from another tab', async () => {
    await renderScreen();
    fireEvent.click(screen.getByTestId('mobile-tab-history'));

    await pressSend();
    await pressSend();
    fireEvent.click(await screen.findByRole('button', { name: 'worktree.promptResponse.stuckHintLink' }));

    await screen.findByTestId('mobile-direct-input-keyboard');
    expect(screen.getByTestId('mobile-tab-terminal')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('terminal-display')).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByTestId('mobile-direct-input-keyboard')).toBeInTheDocument();
  });

  it('offers no link while the session is not running', async () => {
    scenario.claudeRunning = false;
    await renderScreen();
    await pressSend();
    await pressSend();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId('prompt-stuck-hint')).not.toBeInTheDocument();
  });
});
