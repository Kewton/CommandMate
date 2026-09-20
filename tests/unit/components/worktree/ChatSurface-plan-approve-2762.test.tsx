/**
 * Command Code の Plan review に「承認 (Ctrl+A)」ボタンを出す（Issue #2762）
 *
 * 足場は ChatSurface-selection-keys-2297.test.tsx と同じ。
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
import { PLAN_APPROVE_KEY } from '@/types/terminal-keys';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

const PLAN_REVIEW = capture('command-code-plan-review-2761/plan-review-1-58-0.txt');
const COMMAND_CODE_MODEL = capture('chat-dialog-card-2254/command-code-model-1-40-1.txt');

const WORKTREE_ID = 'wt-2762';

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-09-20T10:00:00Z'),
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

function renderSurface(options: { frame?: string; cliToolId?: CLIToolType; instanceId?: string } = {}) {
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId={options.cliToolId ?? 'command-code'}
      instanceId={options.instanceId}
      live={SELECTION_LIST}
      onSurfaceModeChange={vi.fn()}
      frame={options.frame ?? PLAN_REVIEW}
    />,
  );
}

const actions = (): HTMLElement => screen.getByTestId('chat-dialog-card-actions');

let fetchMock: ReturnType<typeof vi.fn>;

function keyCalls(): Array<[string, RequestInit]> {
  return fetchMock.mock.calls
    .filter((call) => !String(call[0]).startsWith('/api/relays'))
    .map((call) => [String(call[0]), (call[1] ?? {}) as RequestInit]);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#2762] Plan review の承認ボタン', () => {
  it('Plan review のフレームで、矢印パッドの下に承認ボタンを出す', () => {
    renderSurface();

    expect(within(actions()).getByTestId('plan-approve-keys')).toBeInTheDocument();
    expect(within(actions()).getByTestId('plan-approve-key')).toBeInTheDocument();
    expect(within(actions()).getByTestId('plan-approve-note')).toBeInTheDocument();
    // 矢印パッド（Esc = Cancel を含む）はそのまま残る。
    expect(within(actions()).getByRole('button', { name: 'Escape' })).toBeInTheDocument();
  });

  it('押すと C-a を 1 つだけ special-keys へ送る', () => {
    renderSurface();

    fireEvent.click(screen.getByTestId('plan-approve-key'));

    expect(keyCalls()).toHaveLength(1);
    const [url, init] = keyCalls()[0];
    expect(url).toBe(`/api/worktrees/${WORKTREE_ID}/special-keys`);
    expect(JSON.parse(init.body as string)).toEqual({
      cliToolId: 'command-code',
      keys: [PLAN_APPROVE_KEY],
    });
  });

  it('非プライマリのインスタンスには instanceId を付けて送る', () => {
    renderSurface({ instanceId: 'command-code-2' });

    fireEvent.click(screen.getByTestId('plan-approve-key'));

    expect(JSON.parse(keyCalls()[0][1].body as string)).toEqual({
      cliToolId: 'command-code',
      keys: [PLAN_APPROVE_KEY],
      instanceId: 'command-code-2',
    });
  });

  it('plan 本文に番号付きの行があっても、番号ボタンは出さない', () => {
    renderSurface({ frame: PLAN_REVIEW.replace('       12,11.', '       1. then merge') });

    expect(screen.queryByTestId('selection-number-keys')).not.toBeInTheDocument();
    expect(screen.getByTestId('plan-approve-key')).toBeInTheDocument();
  });

  it('Plan review でない selection list（/model）には出さない', () => {
    renderSurface({ frame: COMMAND_CODE_MODEL });

    expect(screen.queryByTestId('plan-approve-keys')).not.toBeInTheDocument();
  });

  it('C-a を宣言していないツールには、同じフレームでも出さない', () => {
    renderSurface({ cliToolId: 'claude' });

    expect(screen.queryByTestId('plan-approve-keys')).not.toBeInTheDocument();
  });
});
