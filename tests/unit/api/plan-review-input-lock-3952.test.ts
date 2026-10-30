/**
 * Issue #3952: Command Code's plan-review keys — a comment's text among them —
 * are typed as a writer of the session's input (`answerCommandCodePlanReview`).
 *
 * - A send in progress is waited for; after it the overlay is read again, and
 *   the keys go out only if the same request still plans the same keys on it.
 * - A send that starts during the keys waits for the last of them.
 * - Negative controls: the overlay unchanged after the send is answered;
 *   nothing holding the composer means no second read.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let events: string[] = [];

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn(async (_s: string, text: string) => {
    events.push(`text:${text}`);
  }),
  sendSpecialKeys: vi.fn(async (_s: string, keys: string[]) => {
    events.push(...keys);
  }),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { answerCommandCodePlanReview } from '@/app/api/worktrees/[id]/prompt-response/plan-review';
import { readCommandCodePlanReviewState } from '@/lib/detection/tools/command-code/plan-review-state';
import {
  instanceInputReadMark,
  invalidateInstanceInput,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import {
  PlanReviewInputLostError,
  sendCommandCodePlanReviewKeys,
  type PlanReviewKeyStep,
} from '@/lib/cli-tools/command-code-plan-review';

const SESSION = 'mcbd-command-code-wt-3952';
const FIXTURES = path.resolve(__dirname, '../../fixtures/command-code-plan-review-3125');
const INITIAL = readFileSync(path.join(FIXTURES, 'plan-review-1-74-0-initial.txt'), 'utf8');
const COMPOSER = '❯ Ask anything\n';

function holdSend(): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const done = withInstanceInputLock(SESSION, async () => {
    events.push('<send>');
    await new Promise<void>((resolve) => (release = resolve));
  });
  return { release: () => release(), done };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const state = readCommandCodePlanReviewState(INITIAL)!;

beforeEach(() => {
  events = [];
  resetInstanceInputLocks();
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('[#3952] plan-review keys and the input lock', () => {
  it('fixture sanity: the overlay is read as a plan review in its body phase', () => {
    expect(state).not.toBeNull();
    expect(state.phase).toBe('body');
  });

  it('positive: the overlay is gone once the send is over — nothing is sent', async () => {
    const readMark = instanceInputReadMark();
    const held = holdSend();
    const recapture = vi.fn(async () => COMPOSER);
    const answering = answerCommandCodePlanReview({
      sessionName: SESSION,
      state,
      action: 'approve',
      answer: undefined,
      useDefault: false,
      readMark,
      recapture,
    });
    await flush();
    expect(events).toEqual(['<send>']);
    held.release();
    await held.done;
    const result = await answering;
    expect(result.sent).toBe(false);
    expect(result.body).toMatchObject({ success: false, reason: 'answer_not_delivered' });
    expect(events).toEqual(['<send>']);
    expect(recapture).toHaveBeenCalledTimes(1);
  });

  it('negative: the same overlay once the send is over — the keys go out', async () => {
    const readMark = instanceInputReadMark();
    const held = holdSend();
    const answering = answerCommandCodePlanReview({
      sessionName: SESSION,
      state,
      action: 'approve',
      answer: undefined,
      useDefault: false,
      readMark,
      recapture: async () => INITIAL,
    });
    await flush();
    held.release();
    await held.done;
    const result = await answering;
    expect(result.sent).toBe(true);
    expect(events).toEqual(['<send>', 'C-a']);
  });

  it('a send that starts during a comment’s keys waits for the last one', async () => {
    vi.useFakeTimers();
    const answering = answerCommandCodePlanReview({
      sessionName: SESSION,
      state,
      action: 'comment',
      answer: 'please split this step',
      useDefault: false,
      readMark: instanceInputReadMark(),
      recapture: async () => INITIAL,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual(['Enter']);
    const send = withInstanceInputLock(SESSION, async () => {
      events.push('<send>');
    });
    await vi.runAllTimersAsync();
    await answering;
    await send;
    expect(events).toEqual(['Enter', 'text:please split this step', 'Enter', '<send>']);
  });

  it('negative: nothing holds the composer — sent without a second read', async () => {
    const recapture = vi.fn(async () => COMPOSER);
    const result = await answerCommandCodePlanReview({
      sessionName: SESSION,
      state,
      action: 'cancel',
      answer: undefined,
      useDefault: false,
      readMark: instanceInputReadMark(),
      recapture,
    });
    expect(result.sent).toBe(true);
    expect(events).toEqual(['Escape']);
    expect(recapture).not.toHaveBeenCalled();
  });
});

describe('[#3952 review P2-3] a plan review answer whose input was taken mid-keys', () => {
  it('positive: the session is replaced between the comment’s keys — the rest are not sent', async () => {
    vi.useFakeTimers();
    const answering = answerCommandCodePlanReview({
      sessionName: SESSION,
      state,
      action: 'comment',
      answer: 'please split this step',
      useDefault: false,
      readMark: instanceInputReadMark(),
      recapture: async () => INITIAL,
    });
    const settled = answering.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual(['Enter']);
    invalidateInstanceInput(SESSION);
    await vi.runAllTimersAsync();
    const error = await settled;
    expect(error).toBeInstanceOf(PlanReviewInputLostError);
    expect(error).toMatchObject({ stepsSent: 1 });
    expect(events).toEqual(['Enter']);
  });

  it('negative: the ticket stays current — every step is sent', async () => {
    vi.useFakeTimers();
    const answering = answerCommandCodePlanReview({
      sessionName: SESSION,
      state,
      action: 'comment',
      answer: 'please split this step',
      useDefault: false,
      readMark: instanceInputReadMark(),
      recapture: async () => INITIAL,
    });
    await vi.runAllTimersAsync();
    await answering;
    expect(events).toEqual(['Enter', 'text:please split this step', 'Enter']);
  });

  it('sendCommandCodePlanReviewKeys: asked before each step; no check given, all steps go out', async () => {
    const steps: PlanReviewKeyStep[] = [
      { kind: 'key', key: 'Enter' },
      { kind: 'text', text: 'x' },
      { kind: 'key', key: 'C-r' },
    ];
    let current = true;
    const sleep = vi.fn(async () => {
      current = false;
    });
    await expect(sendCommandCodePlanReviewKeys(SESSION, steps, sleep, () => current)).rejects.toBeInstanceOf(
      PlanReviewInputLostError,
    );
    expect(events).toEqual(['Enter']);

    events = [];
    await sendCommandCodePlanReviewKeys(SESSION, steps, async () => {});
    expect(events).toEqual(['Enter', 'text:x', 'C-r']);
  });
});
