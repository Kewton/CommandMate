/**
 * PC 分割ペインのフッタの矢印パッドも、Plan review では `Enter` を出さない（Issue #2809）
 *
 * #2793 はチャット面のカードの矢印パッドから `Enter` を外した。この画面の `Enter` は、
 * フォーカスがアクション一覧（`❯ Approve`）にあると plan を実行する（#2763 の実測）。
 * ターミナル表示のフッタにも同じパッドがあり、同じフレームを見ているので、同じ関数
 * （`readSelectionListShape(...).offersPlanApprove`）で同じ判定をする。
 *
 * `NavigationButtons` はモックしない。「Enter ボタンが画面に出ない」ことそのものを見る。
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
import { CODEX_APPROVAL_PANE } from '../../../fixtures/codex-hooks-review-0148';

beforeAll(() => installRadixJsdomPolyfills());

function inst(cliTool: CLIToolType): AgentInstance {
  return { id: cliTool, cliTool, alias: cliTool, order: 0 };
}

vi.mock('@/components/worktree/TerminalDisplay', () => ({
  TerminalDisplay: () => <div data-testid="terminal-display" />,
}));

vi.mock('@/components/worktree/MessageInput', () => ({
  MessageInput: ({ splitIndex }: { splitIndex: number }) => (
    <div data-testid={`message-input-${splitIndex}`} />
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

/** `❯ Approve  ctrl+a` にフォーカス。この画面の `Enter` が plan を実行する。 */
const FOCUS_APPROVE = capture('command-code-plan-review-2763/plan-review-action-focus-approve.txt');
/** コメント付きで ctrl+a を押した後のラジオ。`enter confirm` が確定キー。 */
const APPROVE_CHOICE = capture('command-code-plan-review-2763/plan-review-approve-choice.txt');
const CLAUDE_APPROVAL = capture('tui-frame-footer-2776/claude-2.1.278-bash-approval.txt');

const WORKTREE_ID = 'wt-2809-split';

function mockPane(frame: string): void {
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

/** フッタに描かれた矢印パッド。 */
async function footerPad(): Promise<HTMLElement> {
  const footer = screen.getByTestId('split-footer-0');
  return waitFor(() =>
    within(footer).getByRole('toolbar', { name: 'worktree.navigation.toolbarLabel' }),
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

describe('[#2809] PC 分割ペインのフッタ: Plan review では Enter を出さない', () => {
  it('`❯ Approve` にフォーカスした Plan review: Enter は出ず、Up / Down / Esc は出る', async () => {
    mockPane(FOCUS_APPROVE);
    renderSplit('command-code');

    const pad = await footerPad();
    expect(within(pad).queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
    for (const name of ['Up', 'Down', 'Escape']) {
      expect(within(pad).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  // 変異注入: Enter を隠しているのがフレームのフッタの読み取りであることを示す。
  // フッタの片方の行を消すだけで、同じ capture に Enter が戻る。
  it('`❯ Approve` のフレームから `Cancel esc` 行を消すと Enter が戻る', async () => {
    const mutated = FOCUS_APPROVE.replace('\nCancel esc\n', '\n');
    expect(mutated).not.toBe(FOCUS_APPROVE);
    mockPane(mutated);
    renderSplit('command-code');

    const pad = await footerPad();
    expect(within(pad).getByRole('button', { name: 'Enter' })).toBeInTheDocument();
  });
});

describe('[#2809] PC 分割ペインのフッタ: Plan review 以外の選択リストでは Enter を残す', () => {
  it.each<[string, CLIToolType, string]>([
    ['Command Code の承認確認ラジオ（`enter confirm`）', 'command-code', APPROVE_CHOICE],
    ['codex の承認ダイアログ', 'codex', CODEX_APPROVAL_PANE],
    ['claude の承認ダイアログ', 'claude', CLAUDE_APPROVAL],
  ])('%s: Enter が出る', async (_name, cliToolId, frame) => {
    mockPane(frame);
    renderSplit(cliToolId);

    const pad = await footerPad();
    for (const name of ['Up', 'Down', 'Enter', 'Escape']) {
      expect(within(pad).getByRole('button', { name })).toBeInTheDocument();
    }
  });
});
