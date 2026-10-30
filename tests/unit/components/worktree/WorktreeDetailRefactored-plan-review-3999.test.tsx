/**
 * スマホのドック（ターミナル表示）にも Plan review の操作を出し、入力欄は送信を
 * 止める（Issue #3999）。
 *
 * 2026-10-30、スマホのターミナル表示には ◀▲▼▶ と Esc しか無く、承認できなかった。
 * ドックはフレームを持たないので、controller の poll がこのインスタンスの応答から
 * 読んだ `selectionListReading` で決める（#3305）。入力欄のガードも同じ読みを使う。
 *
 *  - 陽性: REVIEW のフレームで、ドックに承認・取り消し・レビュー送信・コメント欄が
 *    出て、入力欄に案内が出る。
 *  - 陰性: 承認時のラジオでは操作も案内も出さない。
 *
 * 足場は WorktreeDetailRefactored-plan-review-enter-2809.test.tsx と同じ。
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '@/types/models';
import { buildRealtimeSnippet } from '@/lib/realtime-snippet';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3999-dock',
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

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

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
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/HistoryPane', () => ({
  HistoryPane: () => <div data-testid="history-pane" />,
  splitHistorySlotId: (idx: number) => `split-history-slot-${idx}`,
}));

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: ChatMessage[] }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
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

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

const PLAN_REVIEW_LONG = capture('command-code-plan-review-2763/plan-review-long-top.txt');
const APPROVE_CHOICE = capture('command-code-plan-review-2763/plan-review-approve-choice.txt');

const WORKTREE_ID = 'wt-3999-dock';

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

function mockPaneState(frame: string): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: frame,
      realtimeSnippet: frame,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive: true,
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
  useSplitMessagesMock.mockReturnValue({
    messages: [],
    isLoading: false,
    refresh: vi.fn(() => Promise.resolve()),
  });
}

function stubFetch(frame: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/current-output')) {
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
            cliToolId: 'command-code',
            fullOutput: frame,
            realtimeSnippet: buildRealtimeSnippet(frame),
            thinking: false,
            sessionStatus: 'waiting',
            isSelectionListActive: true,
            isPagerActive: false,
            isUnclassifiedActive: false,
            isPromptWaiting: false,
            promptData: null,
          }),
        );
      }
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(
        jsonResponse({
          id: WORKTREE_ID,
          name: 'feature/3999',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
          selectedAgents: ['command-code'],
          agentInstances: [{ id: 'command-code', cliTool: 'command-code', alias: 'command-code', order: 0 }],
          cliToolId: 'command-code',
        }),
      );
    }),
  );
}

function renderScreen(frame: string): void {
  window.localStorage.setItem(`activeCliTab-${WORKTREE_ID}`, 'command-code');
  window.localStorage.setItem(`activeInstanceId-${WORKTREE_ID}`, 'command-code');
  mockPaneState(frame);
  stubFetch(frame);
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#3999] スマホのドック: Plan review の操作と入力欄の案内', () => {
  it('REVIEW: ドックに操作が出て、入力欄に案内が出る', async () => {
    renderScreen(PLAN_REVIEW_LONG);

    const dock = await waitFor(() => screen.getByTestId('mobile-selection-dock'));
    const controls = await waitFor(() => within(dock).getByTestId('plan-review-controls'));
    for (const id of ['plan-review-comment-input', 'plan-review-submit', 'plan-review-approve', 'plan-review-cancel']) {
      expect(within(controls).getByTestId(id)).toBeInTheDocument();
    }
    const composer = screen.getByTestId('mobile-composer-wrapper');
    await waitFor(() => {
      expect(within(composer).getByTestId('composer-plan-review-notice')).toBeInTheDocument();
    });
  });

  it('陰性: 承認時のラジオでは操作も案内も出さない', async () => {
    renderScreen(APPROVE_CHOICE);

    const dock = await waitFor(() => screen.getByTestId('mobile-selection-dock'));
    await waitFor(() => {
      expect(within(dock).getByRole('button', { name: 'Enter' })).toBeInTheDocument();
    });
    expect(within(dock).queryByTestId('plan-review-controls')).not.toBeInTheDocument();
    expect(screen.queryByTestId('composer-plan-review-notice')).not.toBeInTheDocument();
  });
});
