/**
 * PC 分割ペインのフッタ（ターミナル表示）にも Plan review の操作を出し、入力欄は
 * このペイン自身のフレームで送信を止める（Issue #3999）。
 *
 * 2026-10-30、ターミナル表示には ◀▲▼▶ と Esc しか無く、承認できなかった
 * （`resolveSelectionListOps` の `surface === 'chat'`）。入力欄は、サーバーが断る
 * 送信をそのまま送っていた。
 *
 *  - 陽性: REVIEW のフレームで、フッタに承認・取り消し・レビュー送信・コメント欄が
 *    出る（Enter は出ない）。入力欄に `planReviewActive` が渡る。
 *  - 陰性: 承認時のラジオ・ほかのツールの承認ダイアログでは操作も出さず、
 *    入力欄も止めない。
 *
 * 足場は TerminalSplitPaneContent-plan-review-enter-2809.test.tsx と同じ。
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { TerminalSplitPaneContent } from '@/components/worktree/TerminalSplitPaneContent';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import { installRadixJsdomPolyfills } from '@tests/helpers/radix-jsdom';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ splitIndex, planReviewActive }: { splitIndex: number; planReviewActive?: boolean }) => (
    <div data-testid={`message-input-${splitIndex}`} data-plan-review-active={String(!!planReviewActive)} />
  ),
}));

vi.mock('@/components/worktree/TerminalEscapeHatch', () => ({
  TerminalEscapeHatch: () => <div data-testid="terminal-escape-hatch" />,
}));

vi.mock('@/components/worktree/PromptPanel', () => ({
  PromptPanel: ({ visible }: { visible: boolean }) =>
    visible ? <div data-testid="prompt-panel" /> : null,
}));

vi.mock('@/components/worktree/AutoYesToggle', () => ({
  AutoYesToggle: () => <div data-testid="auto-yes-toggle" />,
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(),
  }),
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

vi.mock('@/hooks/useSplitMessages', () => ({
  useSplitMessages: () => ({ messages: [], isLoading: false, refresh: vi.fn() }),
}));

vi.mock('@/hooks/useHistoryPaneState', () => ({
  useHistoryPaneState: () => ({ visible: true, width: 40, toggle: vi.fn(), setWidth: vi.fn() }),
  DEFAULT_HISTORY_WIDTH: 40,
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_BREAKPOINT: 768,
}));

// 同じ足場を TerminalSplitPaneContent-chat-footer-2254.test.tsx が使っている。
const useTerminalPanePollingMock = vi.fn();
vi.mock('@/hooks/useTerminalPanePolling', () => ({
  useTerminalPanePolling: (...args: unknown[]) => useTerminalPanePollingMock(...args),
  UNCLASSIFIED_CONFIRMATION_COUNT: 2,
  UNCLASSIFIED_CONFIRMATION_DELAY_MS: 500,
}));

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

/** REVIEW（本文が長い。#3999 で観測した形）。 */
const PLAN_REVIEW_LONG = capture('command-code-plan-review-2763/plan-review-long-top.txt');
/** コメント付きで ctrl+a を押した後のラジオ。Plan review ではない。 */
const APPROVE_CHOICE = capture('command-code-plan-review-2763/plan-review-approve-choice.txt');
const CLAUDE_APPROVAL = capture('tui-frame-footer-2776/claude-2.1.278-bash-approval.txt');

const WORKTREE_ID = 'wt-3999-split';

function mockPane(frame: string, isSelectionListActive = true): void {
  useTerminalPanePollingMock.mockReturnValue({
    terminal: {
      output: frame,
      realtimeSnippet: frame,
      isRunning: true,
      isThinking: false,
      sessionStatus: 'waiting',
      isSelectionListActive,
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
}

function renderSplit(cliToolId: CLIToolType) {
  return render(
    <TerminalSplitPaneContent
      worktreeId={WORKTREE_ID}
      splitIndex={0}
      cliToolId={cliToolId}
      availableInstances={[inst(cliToolId)]}
      onInstanceChange={vi.fn()}
      onFocus={vi.fn()}
      autoYes={{ onToggle: vi.fn() }}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', `/worktrees/${WORKTREE_ID}`);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  global.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: async () => ({}) }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('[#3999] PC 分割ペインのフッタ: Plan review の操作と入力欄のガード', () => {
  it('REVIEW: フッタに操作が出て（Enter は出ない）、入力欄は止まる', async () => {
    mockPane(PLAN_REVIEW_LONG);
    renderSplit('command-code');

    const footer = screen.getByTestId('split-footer-0');
    const controls = await waitFor(() => within(footer).getByTestId('plan-review-controls'));
    for (const id of ['plan-review-comment-input', 'plan-review-submit', 'plan-review-approve', 'plan-review-cancel']) {
      expect(within(controls).getByTestId(id)).toBeInTheDocument();
    }
    // 狭い場所の形（1 行のコメント欄）。
    expect(within(controls).getByTestId('plan-review-comment-input')).toHaveAttribute('rows', '1');
    const pad = within(footer).getByRole('toolbar', { name: 'worktree.navigation.toolbarLabel' });
    expect(within(pad).queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
    expect(screen.getByTestId('message-input-0')).toHaveAttribute('data-plan-review-active', 'true');
  });

  it.each<[string, CLIToolType, string]>([
    ['Command Code の承認確認ラジオ', 'command-code', APPROVE_CHOICE],
    ['claude の承認ダイアログ', 'claude', CLAUDE_APPROVAL],
    ['承認キーを宣言していないツールの REVIEW 形のフレーム', 'claude', PLAN_REVIEW_LONG],
  ])('陰性: %s では操作を出さず、入力欄も止めない', async (_name, cliToolId, frame) => {
    mockPane(frame);
    renderSplit(cliToolId);

    const footer = screen.getByTestId('split-footer-0');
    await waitFor(() => within(footer).getByRole('toolbar', { name: 'worktree.navigation.toolbarLabel' }));
    expect(within(footer).queryByTestId('plan-review-controls')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-input-0')).toHaveAttribute('data-plan-review-active', 'false');
  });

  it('陰性: selection list が下りていれば（レビュー終了後）、同じフレームでも止めない', () => {
    mockPane(PLAN_REVIEW_LONG, false);
    renderSplit('command-code');
    expect(screen.queryByTestId('plan-review-controls')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-input-0')).toHaveAttribute('data-plan-review-active', 'false');
  });
});
