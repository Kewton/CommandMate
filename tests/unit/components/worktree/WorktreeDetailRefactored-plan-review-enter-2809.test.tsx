/**
 * スマホのドックの矢印パッドも、Plan review では `Enter` を出さない（Issue #2809）
 *
 * ドックの `NavigationButtons` は `WorktreeDetailRefactored` にあり、ターミナルのフレームを
 * 持っていない（#736 以降、`useWorktreeDetailController` は `output` を mirror しない）。
 * そこで controller の `/current-output` 取得で `realtimeSnippet || fullOutput` を
 * `readSelectionListShape` で読み、`offersPlanApprove` の boolean だけを公開する（案 A）。
 *
 * 画面全体（本物の controller・本物の `NavigationButtons`）を描き、配線をまるごと見る。
 * ドックの pad を立てるのは controller 自身の poll なので、fetch の応答にフレームを載せる。
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
import { CODEX_APPROVAL_PANE } from '../../../fixtures/codex-hooks-review-0148';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2809-dock',
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

/** `❯ Approve  ctrl+a` にフォーカス。この画面の `Enter` が plan を実行する。 */
const FOCUS_APPROVE = capture('command-code-plan-review-2763/plan-review-action-focus-approve.txt');
/** コメント付きで ctrl+a を押した後のラジオ。`enter confirm` が確定キー。 */
const APPROVE_CHOICE = capture('command-code-plan-review-2763/plan-review-approve-choice.txt');
const CLAUDE_APPROVAL = capture('tui-frame-footer-2776/claude-2.1.278-bash-approval.txt');

const WORKTREE_ID = 'wt-2809-dock';

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

/**
 * タブ側（`MobileTerminalTab`）の pane 状態。ドックの pad とは別の経路なので、
 * ここで同じフレームを与えても、ドックの判定には効かない。
 */
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

/**
 * 画面自身の `/current-output` poll。ドックの pad を立てるのも、その `Enter` を
 * 外すのもこの応答。`realtimeSnippet` はサーバと同じ関数で作る。
 */
function stubFetch(frame: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/current-output')) {
        return Promise.resolve(
          jsonResponse({
            isRunning: true,
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
          name: 'feature/2809',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
        }),
      );
    }),
  );
}

function renderScreen(frame: string): void {
  mockPaneState(frame);
  stubFetch(frame);
  render(<WorktreeDetailRefactored worktreeId={WORKTREE_ID} />);
}

/** ドックの矢印パッド（ターミナル表示ではこれ 1 つだけ）。 */
async function dockedPad(): Promise<HTMLElement> {
  const pads = await waitFor(() => {
    const found = screen.getAllByRole('toolbar', { name: 'worktree.navigation.toolbarLabel' });
    expect(found.length).toBeGreaterThan(0);
    return found;
  });
  expect(pads).toHaveLength(1);
  return pads[0];
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

describe('[#2809] スマホのドック: Plan review では Enter を出さない', () => {
  it('`❯ Approve` にフォーカスした Plan review: Enter は出ず、Up / Down / Esc は出る', async () => {
    renderScreen(FOCUS_APPROVE);

    const pad = await dockedPad();
    for (const name of ['Up', 'Down', 'Escape']) {
      expect(within(pad).getByRole('button', { name })).toBeInTheDocument();
    }
    await waitFor(() => {
      expect(within(pad).queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
    });
    // ターミナル表示のまま（チャット面のカードの pad ではない）。
    expect(screen.getByTestId('terminal-display')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-dialog-card')).not.toBeInTheDocument();
  });
});

describe('[#2809] スマホのドック: Plan review 以外の選択リストでは Enter を残す', () => {
  it.each<[string, string]>([
    ['Command Code の承認確認ラジオ（`enter confirm`）', APPROVE_CHOICE],
    ['codex の承認ダイアログ', CODEX_APPROVAL_PANE],
    ['claude の承認ダイアログ', CLAUDE_APPROVAL],
  ])('%s: Enter が出る', async (_name, frame) => {
    renderScreen(frame);

    const pad = await dockedPad();
    for (const name of ['Up', 'Down', 'Enter', 'Escape']) {
      expect(within(pad).getByRole('button', { name })).toBeInTheDocument();
    }
  });
});
