/**
 * Plan review ではチャット面の矢印パッドから `Enter` を外す（Issue #2793）
 *
 * #2763 の実測: `↓` を plan 本文の最終行より先へ送るとフォーカスがアクション一覧へ移り、
 * そこでの `Enter` は `❯ Approve` を実行する（24 行の plan で `↓` 24 回 → `Enter` で
 * plan が走った）。カードにはフォーカス位置が出ないので、`↵` が「コメント欄を開く」のか
 * 「plan を実行する」のか利用者には区別できない。承認は #2762 の承認ボタンに一本化する。
 *
 * 足場は ChatSurface-plan-approve-2762.test.tsx と同じ。
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

const PLAN_REVIEW = capture('command-code-plan-review-2761/plan-review-1-58-0.txt');
/** `❯ Approve  ctrl+a` にフォーカス。この画面の `Enter` が plan を実行する。 */
const FOCUS_APPROVE = capture('command-code-plan-review-2763/plan-review-action-focus-approve.txt');
const FOCUS_CANCEL = capture('command-code-plan-review-2763/plan-review-long-scrolled-cancel-focused.txt');
/** コメント付きで ctrl+a を押した後のラジオ。`enter confirm` が確定キー。 */
const APPROVE_CHOICE = capture('command-code-plan-review-2763/plan-review-approve-choice.txt');
const COMMAND_CODE_MODEL = capture('chat-dialog-card-2254/command-code-model-1-40-1.txt');

const WORKTREE_ID = 'wt-2793';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-21T10:00:00Z'),
    messageType: 'normal',
    archived: false,
    cliToolId: 'command-code',
  };
}

const SELECTION_LIST: ChatSurfaceLiveState = {
  isRunning: true,
  sessionStatus: 'waiting',
  isThinking: false,
  isPromptWaiting: false,
  promptData: null,
  isSelectionListActive: true,
  isPagerActive: false,
  isUnclassifiedActive: false,
};

function renderSurface(options: { frame: string; cliToolId?: CLIToolType }) {
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId={options.cliToolId ?? 'command-code'}
      live={SELECTION_LIST}
      onSurfaceModeChange={vi.fn()}
      frame={options.frame}
    />,
  );
}

const actions = (): HTMLElement => screen.getByTestId('chat-dialog-card-actions');
const pad = (): HTMLElement => within(actions()).getAllByRole('toolbar')[0];

let fetchMock: ReturnType<typeof vi.fn>;

function sentKeys(): string[][] {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith('/special-keys'))
    .map((call) => JSON.parse((call[1] as RequestInit).body as string).keys);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#2793] Plan review の矢印パッドに Enter を出さない', () => {
  it.each([
    ['本文にカーソル（#2761 の capture）', PLAN_REVIEW],
    ['`❯ Approve` にフォーカス', FOCUS_APPROVE],
    ['`❯ Cancel` にフォーカス', FOCUS_CANCEL],
  ])('%s: Enter は出ず、Up / Down / Esc と承認ボタンは出る', (_name, frame) => {
    renderSurface({ frame });

    expect(within(actions()).queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
    for (const name of ['Up', 'Down', 'Escape']) {
      expect(within(actions()).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(actions()).getByTestId('plan-approve-key')).toBeInTheDocument();
  });

  it('矢印パッド上の Enter キーも pane へ送らない', async () => {
    renderSurface({ frame: FOCUS_APPROVE });

    fireEvent.keyDown(pad(), { key: 'Enter' });
    fireEvent.keyDown(pad(), { key: 'ArrowUp' });

    await waitFor(() => expect(sentKeys()).toHaveLength(1));
    expect(sentKeys()).toEqual([['Up']]);
  });

  it('ツールで絞らない: 同じフレームなら C-a を宣言していないツールでも Enter は出さない', () => {
    renderSurface({ frame: FOCUS_APPROVE, cliToolId: 'claude' });

    expect(within(actions()).queryByRole('button', { name: 'Enter' })).not.toBeInTheDocument();
  });
});

describe('[#2793] Plan review 以外では Enter を残す', () => {
  it('Command Code の /model では Enter が出る（対照）', () => {
    renderSurface({ frame: COMMAND_CODE_MODEL });

    expect(within(actions()).getByRole('button', { name: 'Enter' })).toBeInTheDocument();
  });

  it('承認時のラジオ確認では Enter（= enter confirm）と ◀ ▶ が出て、承認ボタンは出ない', () => {
    renderSurface({ frame: APPROVE_CHOICE });

    for (const name of ['Left', 'Right', 'Enter', 'Escape']) {
      expect(within(actions()).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.queryByTestId('plan-approve-keys')).not.toBeInTheDocument();
  });

  // 変異注入: Enter を隠しているのがフレームのフッタの読み取りであることを示す。
  // フッタの片方の行を消すだけで、同じ capture に Enter が戻る。
  it('`❯ Approve` のフレームから `Cancel esc` 行を消すと Enter が戻る', () => {
    const mutated = FOCUS_APPROVE.replace('\nCancel esc\n', '\n');
    expect(mutated).not.toBe(FOCUS_APPROVE);
    renderSurface({ frame: mutated });

    expect(within(actions()).getByRole('button', { name: 'Enter' })).toBeInTheDocument();
    expect(screen.queryByTestId('plan-approve-keys')).not.toBeInTheDocument();
  });
});
