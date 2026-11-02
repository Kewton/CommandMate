/**
 * Issue #3772: the plan review refusal of `send` comes before the body is
 * typed, so `lastSend` reads `not-sent (plan-review)`, not `indeterminate`.
 * Matched by the error's code, never by its wording.
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

import { CommandCodeTool, commandCodePlanReviewSendMessage } from '@/lib/cli-tools/command-code';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { capturePane } from '@/lib/tmux/tmux';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#3772] send refused by the plan review is not-sent', () => {
  it('positive: the real refusal on a plan review fixture classifies as not-sent (plan-review)', async () => {
    vi.mocked(capturePane).mockResolvedValue(
      read('command-code-plan-review-3125/plan-review-1-74-0-initial.txt'),
    );
    const error = await new CommandCodeTool().sendMessage('test-wt', 'hello').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(commandCodePlanReviewSendMessage('test-wt'));
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'plan-review' });
  });

  it('negative: the same wording without the code stays indeterminate', () => {
    expect(classifySendFailure(new Error(commandCodePlanReviewSendMessage('test-wt')))).toEqual({
      state: 'indeterminate',
      reason: 'send-error',
    });
  });

  it('negative: other Command Code failures stay indeterminate', () => {
    expect(classifySendFailure(new Error('Failed to send message to Command Code: boom'))).toEqual({
      state: 'indeterminate',
      reason: 'send-error',
    });
  });
});
