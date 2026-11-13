/**
 * Issue #4303 (#4303-A): Command Code's plan-review answer (a
 * `/prompt-response` answer) types nothing into a pane whose agent is not
 * known to hold it. Right before its first step it reads PR1's
 * `readPaneForeground` (#4300); `shell` / `unknown` throw the not-delivered
 * refusal, which the route answers as `answer_not_delivered` with
 * `keysSent: false`. `other` (positive control) sends the keys as before.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const h = vi.hoisted(() => ({ foreground: 'other' as 'shell' | 'other' | 'unknown', events: [] as string[] }));

vi.mock('@/lib/tmux/tmux', () => ({
  readPaneForeground: vi.fn(async () => h.foreground),
  sendKeys: vi.fn(async (_s: string, text: string) => {
    h.events.push(`text:${text}`);
  }),
  sendSpecialKeys: vi.fn(async (_s: string, keys: string[]) => {
    h.events.push(...keys);
  }),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { answerCommandCodePlanReview, planReviewAnswerError } from '@/app/api/worktrees/[id]/prompt-response/plan-review';
import { readCommandCodePlanReviewState } from '@/lib/detection/tools/command-code/plan-review-state';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { PromptAnswerAgentNotInForegroundError } from '@/lib/prompt-answer-sender';
import { ANSWER_NOT_DELIVERED_REASON, promptAnswerErrorResponse } from '@/lib/prompt-answer-errors';

const SESSION = 'mcbd-command-code-wt-4303';
const FIXTURES = path.resolve(__dirname, '../../fixtures/command-code-plan-review-3125');
const INITIAL = readFileSync(path.join(FIXTURES, 'plan-review-1-74-0-initial.txt'), 'utf8');
const state = readCommandCodePlanReviewState(INITIAL)!;

function approve(): ReturnType<typeof answerCommandCodePlanReview> {
  return answerCommandCodePlanReview({ sessionName: SESSION, state, action: 'approve', answer: undefined, useDefault: false });
}

beforeEach(() => {
  h.events = [];
  h.foreground = 'other';
  resetInstanceInputLocks();
});

describe('[#4303] plan-review answer and the pane foreground', () => {
  it('fixture sanity: the overlay is read as a plan review', () => {
    expect(state).not.toBeNull();
  });

  it.each(['shell', 'unknown'] as const)('%s: no key, answered as answer_not_delivered', async (foreground) => {
    h.foreground = foreground;
    const error = await approve().then(
      () => null,
      (e: unknown) => e
    );
    expect(h.events).toEqual([]);
    expect(error).toBeInstanceOf(PromptAnswerAgentNotInForegroundError);
    const mapped = promptAnswerErrorResponse(planReviewAnswerError(error, SESSION), 'prompt-response');
    expect(mapped).toEqual({
      status: 200,
      body: expect.objectContaining({ success: false, reason: ANSWER_NOT_DELIVERED_REASON, keysSent: false }),
    });
  });

  it('positive control: other — the keys go out', async () => {
    const result = await approve();
    expect(result.sent).toBe(true);
    expect(h.events).toEqual(['C-a']);
  });
});
