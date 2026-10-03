/**
 * Command Code's plan review overlay from the CLI side (Issue #3125):
 * the key planner, the sender, and `send` stopping at once instead of waiting
 * out the composer timeout.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('@/lib/tmux/session-ownership', () => ({
  assertSessionNotForeign: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  CommandCodeTool,
  COMMAND_CODE_PLAN_REVIEW_SEND_MESSAGE,
} from '@/lib/cli-tools/command-code';
import {
  planCommandCodePlanReviewKeys,
  sendCommandCodePlanReviewKeys,
  isPlanReviewAction,
  PLAN_REVIEW_REFUSAL,
} from '@/lib/cli-tools/command-code-plan-review';
import type { CommandCodePlanReviewState } from '@/lib/detection/tools/command-code/plan-review-state';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

const body = (pendingComments = 0): CommandCodePlanReviewState => ({
  phase: 'body',
  pendingComments,
  approveChoice: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('planCommandCodePlanReviewKeys (Issue #3125)', () => {
  it('a comment opens the box with Enter, types the text, and pins it with Enter', () => {
    expect(planCommandCodePlanReviewKeys(body(), { text: 'Add tests.' })).toEqual({
      ok: true,
      action: 'comment',
      comment: 'Add tests.',
      steps: [
        { kind: 'key', key: 'Enter' },
        { kind: 'text', text: 'Add tests.' },
        { kind: 'key', key: 'Enter' },
      ],
    });
  });

  it('submit is ctrl+r, after the comment when one is given', () => {
    const plan = planCommandCodePlanReviewKeys(body(), { action: 'submit', text: '? why' });
    expect(plan.ok && plan.steps.map((s) => (s.kind === 'key' ? s.key : `text:${s.text}`))).toEqual([
      'Enter',
      'text:? why',
      'Enter',
      'C-r',
    ]);
    const bare = planCommandCodePlanReviewKeys(body(2), { action: 'submit' });
    expect(bare.ok && bare.steps).toEqual([{ kind: 'key', key: 'C-r' }]);
  });

  it('approve is ctrl+a and cancel is Escape — and never without being asked', () => {
    expect(planCommandCodePlanReviewKeys(body(), { action: 'approve' })).toMatchObject({
      ok: true,
      steps: [{ kind: 'key', key: 'C-a' }],
    });
    expect(planCommandCodePlanReviewKeys(body(), { action: 'cancel' })).toMatchObject({
      ok: true,
      steps: [{ kind: 'key', key: 'Escape' }],
    });
    // No answer shape reaches ctrl+a implicitly: text is always a comment.
    for (const text of ['approve', 'Approve the plan', 'ok']) {
      const plan = planCommandCodePlanReviewKeys(body(), { text });
      expect(plan.ok && plan.steps.some((s) => s.kind === 'key' && s.key === 'C-a')).toBe(false);
    }
  });

  it.each([
    ['action-focus', PLAN_REVIEW_REFUSAL.BUSY],
    ['comment-box', PLAN_REVIEW_REFUSAL.BUSY],
    ['unknown', PLAN_REVIEW_REFUSAL.BUSY],
  ] as const)('refuses every action on the %s phase', (phase, reason) => {
    for (const action of ['comment', 'submit', 'approve', 'cancel'] as const) {
      const plan = planCommandCodePlanReviewKeys(
        { phase, pendingComments: 1, approveChoice: null },
        { action, text: action === 'comment' || action === 'submit' ? 'x' : undefined },
      );
      expect(plan).toMatchObject({ ok: false, reason });
    }
  });

  it('on the approve-with-comments radio only approve (Enter) and cancel (Escape) go', () => {
    const state: CommandCodePlanReviewState = {
      phase: 'approve-choice',
      pendingComments: 4,
      approveChoice: 'with-comments',
    };
    expect(planCommandCodePlanReviewKeys(state, { action: 'approve' })).toMatchObject({
      ok: true,
      steps: [{ kind: 'key', key: 'Enter' }],
    });
    expect(planCommandCodePlanReviewKeys(state, { action: 'cancel' })).toMatchObject({
      ok: true,
      steps: [{ kind: 'key', key: 'Escape' }],
    });
    expect(planCommandCodePlanReviewKeys(state, { text: 'more' })).toMatchObject({ ok: false });
  });

  it('isPlanReviewAction is a closed set', () => {
    expect(['comment', 'submit', 'approve', 'cancel'].every(isPlanReviewAction)).toBe(true);
    expect(isPlanReviewAction('merge')).toBe(false);
    expect(isPlanReviewAction(undefined)).toBe(false);
  });
});

describe('sendCommandCodePlanReviewKeys (Issue #3125)', () => {
  it('sends one tmux call per step, text with -l, ctrl+r by name', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await sendCommandCodePlanReviewKeys(
      'sess',
      [
        { kind: 'key', key: 'Enter' },
        { kind: 'text', text: 'Escape' },
        { kind: 'key', key: 'Enter' },
        { kind: 'key', key: 'C-r' },
      ],
      sleep,
    );
    expect(vi.mocked(sendSpecialKeys).mock.calls).toEqual([
      ['sess', ['Enter']],
      ['sess', ['Enter']],
      ['sess', ['C-r']],
    ]);
    expect(vi.mocked(sendKeys).mock.calls).toEqual([
      ['sess', 'Escape', false, { literal: true }],
    ]);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(invalidateCache).toHaveBeenCalledWith('sess');
  });
});

describe('send at the plan review (Issue #3125)', () => {
  it.each([
    'command-code-plan-review-3125/plan-review-1-74-0-initial.txt',
    'command-code-plan-review-3125/plan-review-1-74-0-one-comment.txt',
    'command-code-plan-review-2763/plan-review-action-focus-approve.txt',
  ])('stops at once with a pointer to respond instead of waiting out the composer: %s', async (rel) => {
    vi.mocked(capturePane).mockResolvedValue(read(rel));
    const tool = new CommandCodeTool();
    const started = Date.now();
    await expect(tool.sendMessage('test-wt', 'hello')).rejects.toThrow(
      COMMAND_CODE_PLAN_REVIEW_SEND_MESSAGE,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('one stale plan review frame (the redraw just after Esc) does not stop the send', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(read('command-code-live-2250/boot-idle.txt'))
      .mockResolvedValueOnce(read('command-code-plan-review-2763/after-cancel-partial-redraw.txt'))
      .mockResolvedValue(read('command-code-live-2250/boot-idle.txt'));
    const tool = new CommandCodeTool();
    await tool.sendMessage('test-wt', 'hello');
    expect(sendMessageWithSubmitVerification).toHaveBeenCalledTimes(1);
  });
});
