/**
 * Command Code の計画レビュー（REVIEW）をチャット面から操作する（Issue #3139）
 *
 * - REVIEW のときだけ「コメント欄＋レビューを送信＋承認＋取り消し」が出る（陰性対照つき）
 * - comment → submit の 2 段、approve（確認つき）、cancel が、それぞれ正しい
 *   `planReviewAction` で `/prompt-response` を呼ぶ
 * - API の `plan_review_*` 拒否の文言を画面に出す
 *
 * fetch は差し替える。足場は ChatSurface-plan-approve-2762.test.tsx と同じ。
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import type { ChatMessage } from '@/types/models';

vi.mock('@/components/worktree/ChatTranscript', () => ({
  ChatTranscript: ({ messages }: { messages: Array<{ id: string }> }) => (
    <div data-testid="chat-transcript" data-message-count={String(messages.length)}>
      <div data-testid="chat-transcript-scroll-container" />
    </div>
  ),
  CHAT_TRANSCRIPT_SCROLL_CONTAINER_TESTID: 'chat-transcript-scroll-container',
}));

import { ChatSurface, type ChatSurfaceLiveState } from '@/components/worktree/ChatSurface';
import {
  PlanReviewControls,
  buildPlanReviewRequestBody,
} from '@/components/worktree/PlanReviewControls';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

const PLAN_REVIEW = capture('command-code-plan-review-2761/plan-review-1-58-0.txt');
const APPROVE_CHOICE = capture('command-code-plan-review-2763/plan-review-approve-choice.txt');
const COMMAND_CODE_MODEL = capture('chat-dialog-card-2254/command-code-model-1-40-1.txt');

const WORKTREE_ID = 'wt-3139';
const PROMPT_RESPONSE_URL = `/api/worktrees/${WORKTREE_ID}/prompt-response`;

function msg(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role,
    content: `content-${id}`,
    timestamp: new Date('2026-10-03T10:00:00Z'),
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

function renderSurface(live: ChatSurfaceLiveState, frame: string) {
  return render(
    <ChatSurface
      messages={[msg('u1', 'user'), msg('a1', 'assistant')]}
      worktreeId={WORKTREE_ID}
      cliToolId="command-code"
      live={live}
      onSurfaceModeChange={vi.fn()}
      frame={frame}
    />,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

function okResponse(body: Record<string, unknown> = { success: true }) {
  return { ok: true, json: async () => body };
}

function promptResponseBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]) === PROMPT_RESPONSE_URL)
    .map((call) => JSON.parse(((call[1] ?? {}) as RequestInit).body as string));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#3139] REVIEW のときだけ出る', () => {
  it('REVIEW のフレームでは、カードにコメント欄と 4 つの操作が出る', () => {
    renderSurface(SELECTION_LIST, PLAN_REVIEW);

    const controls = within(screen.getByTestId('chat-dialog-card-actions')).getByTestId('plan-review-controls');
    for (const id of [
      'plan-review-comment-input',
      'plan-review-comment',
      'plan-review-submit',
      'plan-review-approve',
      'plan-review-cancel',
    ]) {
      expect(within(controls).getByTestId(id)).toBeInTheDocument();
    }
  });

  it('陰性対照: REVIEW でない selection list（/model）には出ない', () => {
    renderSurface(SELECTION_LIST, COMMAND_CODE_MODEL);

    expect(screen.queryByTestId('plan-review-controls')).not.toBeInTheDocument();
  });

  it('陰性対照: 承認時のラジオ確認（approve-choice）には出ない（Enter / Esc で答える）', () => {
    renderSurface(SELECTION_LIST, APPROVE_CHOICE);

    expect(screen.queryByTestId('plan-review-controls')).not.toBeInTheDocument();
  });

  it('陰性対照: ダイアログの無い画面（selection list でない）には出ない', () => {
    renderSurface({ ...SELECTION_LIST, sessionStatus: 'ready', isSelectionListActive: false }, PLAN_REVIEW);

    expect(screen.queryByTestId('plan-review-controls')).not.toBeInTheDocument();
  });
});

describe('[#3139] 各操作が正しい planReviewAction で API を呼ぶ', () => {
  it('コメント → レビューを送信 の 2 段', async () => {
    renderSurface(SELECTION_LIST, PLAN_REVIEW);

    // 空のうちはコメントを追加できない。
    expect(screen.getByTestId('plan-review-comment')).toBeDisabled();

    fireEvent.change(screen.getByTestId('plan-review-comment-input'), {
      target: { value: 'テストを先に書く手順にして' },
    });
    fireEvent.click(screen.getByTestId('plan-review-comment'));

    await waitFor(() => expect(promptResponseBodies()).toHaveLength(1));
    expect(promptResponseBodies()[0]).toEqual({
      planReviewAction: 'comment',
      cliTool: 'command-code',
      answer: 'テストを先に書く手順にして',
    });
    // ピン留めできたら欄は空に戻る。
    await waitFor(() =>
      expect((screen.getByTestId('plan-review-comment-input') as HTMLTextAreaElement).value).toBe(''),
    );

    fireEvent.click(screen.getByTestId('plan-review-submit'));

    await waitFor(() => expect(promptResponseBodies()).toHaveLength(2));
    expect(promptResponseBodies()[1]).toEqual({ planReviewAction: 'submit', cliTool: 'command-code' });
  });

  it('承認は確認を挟む: 1 回目の押下では送らず、確認で approve を送る', async () => {
    renderSurface(SELECTION_LIST, PLAN_REVIEW);

    fireEvent.click(screen.getByTestId('plan-review-approve'));
    expect(fetchMock.mock.calls.filter((c) => String(c[0]) === PROMPT_RESPONSE_URL)).toHaveLength(0);
    expect(screen.getByTestId('plan-review-approve-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('plan-review-approve-confirm-yes'));

    await waitFor(() => expect(promptResponseBodies()).toHaveLength(1));
    expect(promptResponseBodies()[0]).toEqual({ planReviewAction: 'approve', cliTool: 'command-code' });
    expect(screen.queryByTestId('plan-review-approve-confirm')).not.toBeInTheDocument();
  });

  it('承認の確認で「やめる」を選ぶと何も送らない', () => {
    renderSurface(SELECTION_LIST, PLAN_REVIEW);

    fireEvent.click(screen.getByTestId('plan-review-approve'));
    fireEvent.click(screen.getByTestId('plan-review-approve-confirm-no'));

    expect(screen.queryByTestId('plan-review-approve-confirm')).not.toBeInTheDocument();
    expect(promptResponseBodies()).toHaveLength(0);
  });

  it('取り消しは確認なしで cancel を送る', async () => {
    renderSurface(SELECTION_LIST, PLAN_REVIEW);

    fireEvent.click(screen.getByTestId('plan-review-cancel'));

    await waitFor(() => expect(promptResponseBodies()).toHaveLength(1));
    expect(promptResponseBodies()[0]).toEqual({ planReviewAction: 'cancel', cliTool: 'command-code' });
  });
});

describe('[#3139] API の plan_review_* 拒否を画面に出す', () => {
  it('plan_review_ambiguous_answer: 訳文と API の文言の両方を出し、欄は消さない', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        success: false,
        reason: 'plan_review_ambiguous_answer',
        message: 'The plan review has no numbered options, and "1" would be pinned to the plan as a comment, so no key was sent.',
        answer: '1',
      }),
    );
    render(<PlanReviewControls worktreeId={WORKTREE_ID} cliToolId="command-code" />);

    fireEvent.change(screen.getByTestId('plan-review-comment-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('plan-review-comment'));

    const error = await screen.findByTestId('plan-review-error');
    expect(error).toHaveTextContent('worktree.planReview.refusal.ambiguousAnswer');
    expect(within(error).getByTestId('plan-review-error-detail')).toHaveTextContent(
      'The plan review has no numbered options',
    );
    expect((screen.getByTestId('plan-review-comment-input') as HTMLTextAreaElement).value).toBe('1');
  });

  it('plan_review_busy の文言を出し、onKeysSent は呼ばない', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ success: false, reason: 'plan_review_busy', message: 'Move the focus back into the plan.' }),
    );
    const onKeysSent = vi.fn();
    render(<PlanReviewControls worktreeId={WORKTREE_ID} cliToolId="command-code" onKeysSent={onKeysSent} />);

    fireEvent.click(screen.getByTestId('plan-review-cancel'));

    const error = await screen.findByTestId('plan-review-error');
    expect(error).toHaveTextContent('worktree.planReview.refusal.busy');
    expect(error).toHaveTextContent('Move the focus back into the plan.');
    expect(onKeysSent).not.toHaveBeenCalled();
  });

  it('HTTP エラー（400）は error 文言を出す', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'planReviewAction is only valid for command-code' }),
    });
    render(<PlanReviewControls worktreeId={WORKTREE_ID} cliToolId="command-code" />);

    fireEvent.click(screen.getByTestId('plan-review-submit'));

    const error = await screen.findByTestId('plan-review-error');
    expect(error).toHaveTextContent('worktree.planReview.refusal.generic');
    expect(error).toHaveTextContent('planReviewAction is only valid for command-code');
  });

  it('成功すると onKeysSent を呼び、前の拒否表示を消す', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ success: false, reason: 'plan_review_nothing_to_submit', message: 'x' }))
      .mockResolvedValueOnce(okResponse());
    const onKeysSent = vi.fn();
    render(<PlanReviewControls worktreeId={WORKTREE_ID} cliToolId="command-code" onKeysSent={onKeysSent} />);

    fireEvent.click(screen.getByTestId('plan-review-submit'));
    expect(await screen.findByTestId('plan-review-error')).toHaveTextContent(
      'worktree.planReview.refusal.nothingToSubmit',
    );

    fireEvent.click(screen.getByTestId('plan-review-cancel'));
    await waitFor(() => expect(onKeysSent).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('plan-review-error')).not.toBeInTheDocument();
  });
});

describe('[#3139] buildPlanReviewRequestBody', () => {
  it('submit は欄に文字があればコメントとして同送し、approve / cancel は本文を持たない', () => {
    expect(buildPlanReviewRequestBody('submit', 'command-code', '  直して  ')).toEqual({
      planReviewAction: 'submit',
      cliTool: 'command-code',
      answer: '直して',
    });
    expect(buildPlanReviewRequestBody('approve', 'command-code', '残っている文字')).toEqual({
      planReviewAction: 'approve',
      cliTool: 'command-code',
    });
    expect(buildPlanReviewRequestBody('cancel', 'command-code', 'x', 'command-code')).toEqual({
      planReviewAction: 'cancel',
      cliTool: 'command-code',
    });
  });
});
