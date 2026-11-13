/**
 * Issue #4304 F1-a (the contract after §6-6, §3.3-1 and acceptance table §3.4
 * T7 / T11): what a keystroke answer did, read once at one boundary
 * (`deliverAnswer`) and carried with the pane its keys went to.
 *
 * - T7: between two keys of a cursor answer (a delay the pane can be replaced
 *   across, with the input ticket and the session epoch unchanged) the session
 *   must still show the pane the answer was decided for. Runs the real sender
 *   and the real tmux module against the fake tmux server
 *   (`fake-pane-tmux.ts`): `send-keys -t =<session>:` reaches whatever pane the
 *   session shows, so before the fix the Enter after the Down went to H.
 * - T11: every way a send ends is one delivery — known not sent, sent,
 *   partial, indeterminate — and a plain `Error` or a non-Error throw is not
 *   taken for "not sent".
 *
 * The type negatives at the end are checked by `tsc`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

vi.mock('child_process', async (importOriginal) =>
  (await import('./fake-pane-tmux')).fakePaneChildProcess(importOriginal),
);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        name: id,
        getSessionName: (worktreeId: string) => `mcbd-${id}-${worktreeId}`,
      }),
    }),
  },
}));

import { fakePaneTmux } from './fake-pane-tmux';
import { captureBoundFrame, type BoundFrame } from '@/lib/session/cli-session';
import { resetCacheForTesting } from '@/lib/tmux/tmux-capture-cache';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import {
  deliverAnswer,
  deliveryMayBeOnPane,
  paneAnswerContextOf,
  type AnswerDelivery,
  type AnswerOrigin,
  type PaneAnswerContext,
} from '@/lib/session/pane-answer-context';
import {
  FreeTextAnswerRejectedError,
  PromptAnswerInputLostError,
  PromptAnswerNotDeliveredError,
  PromptAnswerRejectedError,
} from '@/lib/prompt-answer-errors';
import type { PromptData } from '@/types/models';
import { answerCommandCodePlanReview } from '@/app/api/worktrees/[id]/prompt-response/plan-review';
import { readCommandCodePlanReviewState } from '@/lib/detection/tools/command-code/plan-review-state';
import { PlanReviewInputLostError, planCommandCodePlanReviewKeys } from '@/lib/cli-tools/command-code-plan-review';

const WT = 'wt-4304-delivery';
const S = `mcbd-claude-${WT}`;

/** A live Claude approval (#1708): `2` is Down, then Enter. */
const CLAUDE_APPROVAL = readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt'),
  'utf8',
);
const CLAUDE_APPROVAL_PROMPT = assessPromptAnswerability('claude', CLAUDE_APPROVAL).promptCheck?.promptData as PromptData;

async function boundContext(): Promise<PaneAnswerContext> {
  const captured = await captureBoundFrame({ sessionName: S }, { lines: 200, window: 'tmux' });
  if (captured.kind !== 'bound') throw new Error(`not bound: ${captured.reason}`);
  return paneAnswerContextOf(captured, S);
}

beforeEach(() => {
  fakePaneTmux.reset();
  resetCacheForTesting();
  resetInstanceInputLocks();
});

afterEach(() => {
  resetCacheForTesting();
  resetInstanceInputLocks();
});

describe('[#4304 F1-a T7] the cursor keys stop when the pane is replaced between two of them', () => {
  it('positive: G replaced by H after the Down — the Enter reaches neither; a partial delivery to G', async () => {
    const g = fakePaneTmux.addSession(S, CLAUDE_APPROVAL);
    const context = await boundContext();
    let h = '';
    fakePaneTmux.onceAfter('send-keys', () => {
      h = fakePaneTmux.replacePane(S, CLAUDE_APPROVAL);
    });

    const delivery = await deliverAnswer({ kind: 'pane', context }, () =>
      sendPromptAnswer({ sessionName: S, answer: '2', cliToolId: 'claude', promptData: CLAUDE_APPROVAL_PROMPT, frame: context.frame }),
    );

    expect(fakePaneTmux.keysTo(g).map((k) => k.argv[k.argv.length - 1])).toEqual(['Down']);
    expect(fakePaneTmux.keysTo(h)).toEqual([]);
    expect(delivery.kind).toBe('partial');
    expect(delivery.origin).toMatchObject({ kind: 'pane', context: { generation: { paneId: g } } });
    expect(delivery.kind === 'partial' ? delivery.error : null).toBeInstanceOf(PromptAnswerInputLostError);
  });

  it('negative: the same pane throughout — Down, then Enter, to G; sent', async () => {
    const g = fakePaneTmux.addSession(S, CLAUDE_APPROVAL);
    const context = await boundContext();

    const delivery = await deliverAnswer({ kind: 'pane', context }, () =>
      sendPromptAnswer({ sessionName: S, answer: '2', cliToolId: 'claude', promptData: CLAUDE_APPROVAL_PROMPT, frame: context.frame }),
    );

    expect(fakePaneTmux.keysTo(g).map((k) => k.argv[k.argv.length - 1])).toEqual(['Down', 'Enter']);
    expect(delivery.kind).toBe('sent');
  });
});

describe('[#4304 F1-a T7] the plan review\'s steps stop when the pane is replaced between two of them', () => {
  const CC = `mcbd-command-code-${WT}`;
  const PLAN_REVIEW = readFileSync(
    path.resolve(__dirname, '../../fixtures/command-code-plan-review-3125/plan-review-1-74-0-initial.txt'),
    'utf8',
  );
  const state = readCommandCodePlanReviewState(PLAN_REVIEW)!;
  const request = { action: 'comment' as const, text: 'tighten the tests', useDefault: false };

  async function frameOf(session: string): Promise<BoundFrame> {
    const captured = await captureBoundFrame({ sessionName: session }, { lines: 200, window: 'tmux' });
    if (captured.kind !== 'bound') throw new Error(`not bound: ${captured.reason}`);
    return captured;
  }

  it('the comment takes more than one step (so there is a wait between two)', () => {
    const plan = planCommandCodePlanReviewKeys(state, request);
    expect(plan.ok && plan.steps.length).toBeGreaterThan(1);
  });

  it('positive: G replaced by H after the first step — no further step reaches either pane', async () => {
    const g = fakePaneTmux.addSession(CC, PLAN_REVIEW);
    const frame = await frameOf(CC);
    let h = '';
    fakePaneTmux.onceAfter('send-keys', () => {
      h = fakePaneTmux.replacePane(CC, PLAN_REVIEW);
    });

    const result = await answerCommandCodePlanReview({
      sessionName: CC, state, action: request.action, answer: request.text, useDefault: false, frame,
    }).then((value) => ({ value }), (error: unknown) => ({ error }));

    expect(fakePaneTmux.keysTo(g)).toHaveLength(1);
    expect(fakePaneTmux.keysTo(h)).toEqual([]);
    expect('error' in result ? result.error : null).toBeInstanceOf(PlanReviewInputLostError);
    expect('error' in result ? result.error : null).toMatchObject({ stepsSent: 1 });
  });

  it('negative: the same pane throughout — every step goes to G', async () => {
    const g = fakePaneTmux.addSession(CC, PLAN_REVIEW);
    const frame = await frameOf(CC);
    const plan = planCommandCodePlanReviewKeys(state, request);

    const result = await answerCommandCodePlanReview({
      sessionName: CC, state, action: request.action, answer: request.text, useDefault: false, frame,
    });

    expect(result.sent).toBe(true);
    expect(fakePaneTmux.keysTo(g)).toHaveLength(plan.ok ? plan.steps.length : -1);
  });
});

describe('[#4304 F1-a T11] every way a send ends is one delivery', () => {
  const origin: AnswerOrigin = { kind: 'sender-bound', sessionName: S };
  const transport = (delivery: 'not-started' | 'indeterminate', extra: object = {}): Error =>
    Object.assign(new Error('tmux send-keys failed'), { name: 'TmuxSendError', answerDelivery: delivery, ...extra });

  it.each<[string, () => unknown, AnswerDelivery['kind'], boolean]>([
    ['the sender came back', () => undefined, 'sent', false],
    ['a refusal before any key (keysSent: false)', () => new PromptAnswerNotDeliveredError('target-changed', S), 'not-sent', false],
    ['the dialog\'s own rules refused (no keysSent on the error)', () => new PromptAnswerRejectedError('claude', '1', { kind: 'permission', answerMode: 'keys' } as never), 'not-sent', false],
    ['free text at a menu row', () => new FreeTextAnswerRejectedError('claude', [1]), 'not-sent', false],
    ['tmux refused before it started', () => Object.assign(transport('not-started'), { keysSent: false }), 'not-sent', false],
    ['keys on the pane, the rest not sent', () => new PromptAnswerInputLostError(S), 'partial', true],
    ['a tmux call with no exit status, after a key', () => Object.assign(transport('indeterminate'), { keysSent: true }), 'indeterminate', true],
    ['a tmux call with no exit status, no key known', () => transport('indeterminate'), 'indeterminate', true],
    ['a plain Error that says nothing of its keys', () => new Error('boom'), 'indeterminate', false],
    ['a non-Error throw', () => 'boom', 'indeterminate', false],
  ])('%s', async (_label, outcome, kind, mayBeOnPane) => {
    const thrown = outcome();
    const delivery = await deliverAnswer(origin, async () => {
      if (thrown !== undefined) throw thrown;
    });
    expect(delivery.kind).toBe(kind);
    expect(delivery.origin).toBe(origin);
    expect(deliveryMayBeOnPane(delivery)).toBe(mayBeOnPane);
  });
});

describe('[#4304 F1-a] type negatives', () => {
  it('a delivery is made by deliverAnswer only, and needs an origin with a pane or the sender\'s', () => {
    const unreached = (context: PaneAnswerContext, frame: BoundFrame): void => {
      // @ts-expect-error a delivery is not spelled by hand
      const forged: AnswerDelivery = { kind: 'sent', origin: { kind: 'pane', context } };
      void forged;
      // @ts-expect-error an unconfirmed pane is no origin: it cannot be `sent`
      void deliverAnswer({ kind: 'unconfirmed' }, async () => undefined);
      // @ts-expect-error a raw bound frame is no origin either
      void deliverAnswer({ kind: 'pane', context: frame }, async () => undefined);
      // @ts-expect-error nor a generation alone
      void deliverAnswer({ kind: 'pane', generation: frame.generation }, async () => undefined);
    };
    expect(typeof unreached).toBe('function');
  });
});
