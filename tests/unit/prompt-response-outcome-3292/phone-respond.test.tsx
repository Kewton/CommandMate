/**
 * The phone's `/respond` column of the shared table (Issue #3292) — see
 * `./cases`.
 *
 * An approval the agent named by id (opencode, OpenCode V2) is answered from
 * the phone's sheet by `WorktreeDetailRefactored`'s `handleMobilePromptRespond`,
 * which POSTs `/respond` itself rather than going through the controller. So
 * the screen is rendered end to end with the REAL `MobilePromptSheet`.
 *
 * Once the answer has been posted every `/current-output` is answered 503:
 * the fetch is counted, and it moves nothing. The sheet can then only close if
 * the handler closes it.
 *
 * Harness copied from `WorktreeDetailRefactored-prompt-stuck-2869.test.tsx`.
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
  PROMPT_RESPONSE_ROWS,
  jsonReply,
  promptResponseToast,
  replyOf,
  type PromptResponseCase,
  type PromptResponseObserved,
} from './cases';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3292',
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

const WORKTREE_ID = 'wt-3292';
const DECISION_ID = 'per_3292probePermission0000000';

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
  name: 'fix/3292',
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

/** Press `Allow once` on a sheet whose POST gets `testCase.reply`; report what the user was left with. */
async function observe(testCase: PromptResponseCase): Promise<PromptResponseObserved> {
  let answered = false;
  let refetchesAfterAnswer = 0;
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/respond') || u.includes('/prompt-response')) {
        posted.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) });
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
            promptData: APPROVAL,
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
  const allowOnce = await screen.findByTestId('mobile-structured-decision-option-1');
  await waitFor(() => expect(allowOnce).toBeEnabled());

  fireEvent.click(allowOnce);

  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0].url).toBe(`/api/worktrees/${WORKTREE_ID}/respond`);
  expect(posted[0].body).toMatchObject({ decisionId: DECISION_ID, answer: '1' });
  // Let the handler run to its end and the screen settle on what it did.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  return {
    toast: promptResponseToast(showToast),
    cardKept: screen.queryByTestId('mobile-prompt-sheet') !== null,
    refetched: refetchesAfterAnswer > 0,
  };
}

describe("[#3292] an answer from the phone's sheet to /respond", () => {
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
    // The handler logs a request that got no reply; that line is not the result.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it.each(PROMPT_RESPONSE_ROWS)('%s', async (_name, testCase) => {
    expect(await observe(testCase)).toEqual(testCase.expected);
  });
});
