/**
 * Issue #4031 (item 3, review P2-1): the phone tells an answer stopped
 * part-way from any other failure, on both of its routes.
 *
 * Rendered through the parent (`WorktreeDetailRefactored`), as
 * `../prompt-response-outcome-3292/phone-respond.test.tsx` does:
 *
 * - an ordinary dialog read off the screen goes to `/prompt-response` through
 *   `useWorktreeDetailController`'s `handlePromptRespond`;
 * - an approval the agent named by id goes to `/respond`
 *   (`handleMobilePromptRespond`).
 *
 * Positive: a 500 with `reason: answer_input_lost` and `keysSent: true` shows
 * the `partial` toast (warning) and keeps the sheet. Negative: a plain 500
 * shows the `failed` toast as before. Before #4031 (and on the controller,
 * before its review fix) both showed `failed` — "please try again", which can
 * type the keys twice.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  buildStructuredPromptData,
  STRUCTURED_DECISION_OPTIONS,
  type StructuredPromptFacts,
} from '@/lib/session/structured-prompt';
import {
  jsonReply,
  promptResponseToast,
  replyOf,
  type PromptResponseCase,
  type PromptResponseObserved,
} from '../prompt-response-outcome-3292/cases';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-4031',
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

const { useTerminalPanePollingMock, useSplitMessagesMock, showToast } = vi.hoisted(() => ({
  useTerminalPanePollingMock: vi.fn(),
  useSplitMessagesMock: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: useTerminalPanePollingMock,
}));
vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: useSplitMessagesMock,
  SPLIT_MESSAGES_POLL_INTERVAL_MS: 5000,
}));

// Every `useToast()` on the screen hands out the one spy, so what the handler
// said is read off it rather than off a portal.
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useToast: () => ({ toasts: [], showToast, removeToast: vi.fn(), clearToasts: vi.fn() }),
  };
});

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';

const WORKTREE_ID = 'wt-4031';
const DECISION_ID = 'per_4031probePermission0000000';

/** The approval as the structured layer publishes it: no screen options, one decision id. */
const APPROVAL = buildStructuredPromptData(WORKTREE_ID, {
  source: 'notification',
  message: 'edit hello.txt',
  toolName: 'edit',
  decisionOptions: STRUCTURED_DECISION_OPTIONS,
  decisionId: DECISION_ID,
  patterns: ['*'],
} as StructuredPromptFacts);

const WORKTREE = {
  id: WORKTREE_ID,
  name: 'fix/4031',
  path: '/tmp/wt',
  repositoryPath: '/tmp/repo',
  repositoryName: 'CommandMate',
  selectedAgents: ['claude', 'codex'],
  agentInstances: [
    { id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 },
    { id: 'codex', cliTool: 'codex', alias: 'Codex', order: 1 },
  ],
  sessionStatusByCli: {
    claude: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
    codex: { isRunning: true, isWaitingForResponse: false, isProcessing: false },
  },
};

/** The ordinary dialog: read off the screen, answered through `/prompt-response`. */
const YES_NO = { type: 'yes_no', question: 'Overwrite hello.txt?', status: 'pending', options: ['yes', 'no'] };

const PARTIAL = ['worktree.promptResponse.partial', 'warning'] as const;
const FAILED = ['worktree.promptResponse.failed', 'error'] as const;

const INPUT_LOST: PromptResponseCase = {
  name: 'input lost',
  reply: {
    status: 500,
    body: { error: 'Failed to send answer to tmux: stopped part-way', reason: 'answer_input_lost', keysSent: true },
  },
  outcome: 'failed',
  expected: { toast: PARTIAL, cardKept: true, refetched: true },
};
const PLAIN_500: PromptResponseCase = {
  name: 'plain 500',
  reply: { status: 500, body: { error: 'Failed to send answer to tmux: no server running' } },
  outcome: 'failed',
  expected: { toast: FAILED, cardKept: true, refetched: true },
};

type Route = 'prompt-response' | 'respond';

/** Answer the phone's sheet whose POST gets `testCase.reply`; report what the user was left with. */
async function observe(route: Route, testCase: PromptResponseCase): Promise<PromptResponseObserved> {
  let answered = false;
  let refetchesAfterAnswer = 0;
  const posted: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/respond') || u.includes('/prompt-response')) {
        posted.push(u);
        answered = true;
        return replyOf(testCase);
      }
      if (u.includes('/current-output')) {
        if (answered) {
          refetchesAfterAnswer += 1;
          return Promise.resolve(jsonReply(503, {}));
        }
        return Promise.resolve(
          jsonReply(200, {
            isRunning: true,
            fullOutput: 'row 1\nrow 2',
            realtimeSnippet: 'row 2',
            thinking: false,
            sessionStatus: 'waiting',
            isSelectionListActive: false,
            isPagerActive: false,
            isUnclassifiedActive: false,
            isPromptWaiting: true,
            promptData: route === 'respond' ? APPROVAL : YES_NO,
          }),
        );
      }
      if (u.includes('/auto-yes')) {
        return Promise.resolve(jsonReply(200, { instances: { claude: { enabled: false, expiresAt: null } } }));
      }
      if (u.includes('/messages')) return Promise.resolve(jsonReply(200, []));
      if (u.includes('/tasks')) return Promise.resolve(jsonReply(200, { tasks: [] }));
      if (u.includes('/verify/runs')) return Promise.resolve(jsonReply(200, { runs: [] }));
      return Promise.resolve(jsonReply(200, WORKTREE));
    }),
  );

  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
  await screen.findByTestId('mobile-more-actions-button');
  const button =
    route === 'respond'
      ? await screen.findByTestId('mobile-structured-decision-option-1')
      : await screen.findByRole('button', { name: 'prompt.yes' });
  await waitFor(() => expect(button).toBeEnabled());

  fireEvent.click(button);

  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]).toBe(`/api/worktrees/${WORKTREE_ID}/${route}`);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  return {
    toast: promptResponseToast(showToast),
    cardKept: screen.queryByTestId('mobile-prompt-sheet') !== null,
    refetched: refetchesAfterAnswer > 0,
  };
}

describe('[#4031] an answer stopped part-way, on the phone', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
    showToast.mockClear();
    useTerminalPanePollingMock.mockReturnValue({
      terminal: {
        output: 'row 1\nrow 2',
        realtimeSnippet: 'row 2',
        isRunning: true,
        isThinking: false,
        sessionStatus: 'waiting',
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
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it.each(['prompt-response', 'respond'] as const)('positive: %s — the partial toast', async (route) => {
    expect(await observe(route, INPUT_LOST)).toEqual(INPUT_LOST.expected);
  });

  it.each(['prompt-response', 'respond'] as const)('negative: %s — a plain 500 keeps the failed toast', async (route) => {
    expect(await observe(route, PLAIN_500)).toEqual(PLAIN_500.expected);
  });
});
