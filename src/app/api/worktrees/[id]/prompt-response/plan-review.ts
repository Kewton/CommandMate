/**
 * The prompt-response route's answer for Command Code's plan review overlay
 * (Issue #3125).
 *
 * Before this the route ran the overlay through `assessPromptAnswerability`,
 * which finds no dialog on it and answers `prompt_no_longer_active` — while
 * `wait` reported the same screen as `command_code_plan_review` (exit 10) and
 * told the operator to `respond`. The keys themselves are decided in
 * `lib/cli-tools/command-code-plan-review`; this file only turns that plan into
 * a response body.
 */

import {
  PlanReviewInputLostError,
  planCommandCodePlanReviewKeys,
  sendCommandCodePlanReviewKeys,
  type PlanReviewAction,
  type PlanReviewPlan,
} from '@/lib/cli-tools/command-code-plan-review';
import {
  readCommandCodePlanReviewState,
  type CommandCodePlanReviewState,
} from '@/lib/detection/tools/command-code/plan-review-state';
import { answerUnderInstanceInputLock, instanceInputReadMark } from '@/lib/session/instance-input-lock';
import { ANSWER_NOT_DELIVERED_REASON } from '@/lib/prompt-answer-sender';
import { PromptAnswerInputLostError, PromptAnswerNotDeliveredError } from '@/lib/prompt-answer-errors';

/** The reason for a plan review action asked of a screen that is not one. */
export const PLAN_REVIEW_NOT_ACTIVE_REASON = 'plan_review_not_active';

export interface PlanReviewAnswer {
  /** Whether keys were sent (a refusal sends none). */
  sent: boolean;
  action: PlanReviewAction | null;
  body: Record<string, unknown>;
}

/** Whether two plans send the same keys for the same action. */
function samePlan(a: PlanReviewPlan & { ok: true }, b: PlanReviewPlan): boolean {
  return b.ok && a.action === b.action && JSON.stringify(a.steps) === JSON.stringify(b.steps);
}

/**
 * Answer the overlay on `sessionName`.
 *
 * Issue #3952: the keys — a comment's text among them — are typed as the
 * session's input writer, so a message send cannot type between them. When
 * another writer was admitted after `readMark` (taken before the frame `state`
 * was read from), the overlay is read again with `recapture` and the keys go
 * out only if the same request still plans the same keys on it; otherwise
 * nothing is sent and the body says so (`answer_not_delivered`).
 *
 * @throws whatever the tmux transport throws once keys are being sent
 */
export async function answerCommandCodePlanReview(args: {
  sessionName: string;
  state: CommandCodePlanReviewState;
  action: PlanReviewAction | undefined;
  answer: string | undefined;
  useDefault: boolean;
  readMark?: number;
  recapture?: () => Promise<string>;
}): Promise<PlanReviewAnswer> {
  const { sessionName, state, action, answer, useDefault } = args;
  const plan = planCommandCodePlanReviewKeys(state, { action, text: answer, useDefault });
  if (!plan.ok) {
    return {
      sent: false,
      action: null,
      body: { success: false, reason: plan.reason, message: plan.message, answer: answer ?? '' },
    };
  }
  const recapture = args.recapture;
  const outcome = await answerUnderInstanceInputLock(
    sessionName,
    args.readMark ?? instanceInputReadMark(),
    async () => {
      if (recapture === undefined) return false;
      const now = readCommandCodePlanReviewState(await recapture());
      return now !== null && now.phase === state.phase &&
        samePlan(plan, planCommandCodePlanReviewKeys(now, { action, text: answer, useDefault }));
    },
    // Issue #3952 review P2-3: every step is sent only while the ticket is current.
    (ticket) => sendCommandCodePlanReviewKeys(sessionName, plan.steps, undefined, () => ticket.isCurrent())
  );
  if (!outcome.answered) {
    return {
      sent: false,
      action: null,
      body: {
        success: false,
        reason: ANSWER_NOT_DELIVERED_REASON,
        message:
          `The plan review answer was not sent: another input held the session, and after it ${
            outcome.reason === 'target-changed' ? 'the review no longer asked for the same keys' : `(${outcome.reason})`
          }. Nothing was typed.`,
        answer: answer ?? '',
      },
    };
  }
  return {
    sent: true,
    action: plan.action,
    body: {
      success: true,
      answer: plan.comment ?? '',
      planReview: {
        action: plan.action,
        comment: plan.comment,
        phase: state.phase,
        pendingCommentsBefore: state.pendingComments,
        ...(state.approveChoice ? { approveChoice: state.approveChoice } : {}),
      },
    },
  };
}

/**
 * The answer error a plan review's keys stopped with (Issue #4031), for the
 * route to answer through `promptAnswerErrorResponse` like every other answer.
 *
 * {@link PlanReviewInputLostError} stays where the keys are sent
 * (`lib/cli-tools`); it is turned into the answer errors here. With at least
 * one step sent, keys are on the pane: {@link PromptAnswerInputLostError}
 * (500, `answer_input_lost`, `keysSent: true`). With none sent, nothing was
 * typed: {@link PromptAnswerNotDeliveredError} (`session-replaced`,
 * `keysSent: false`). The original error is kept as `cause`. Any other error
 * is returned as it is (the route keeps its own 500).
 */
export function planReviewAnswerError(error: unknown, sessionName: string): unknown {
  if (!(error instanceof PlanReviewInputLostError)) return error;
  const wrapped =
    error.stepsSent > 0
      ? new PromptAnswerInputLostError(sessionName)
      : new PromptAnswerNotDeliveredError('session-replaced', sessionName);
  return Object.assign(wrapped, { cause: error });
}

/** The refusal for `planReviewAction` on a screen with no plan review. */
export function planReviewNotActiveBody(answer: string | undefined, captureFailed: boolean): Record<string, unknown> {
  return {
    success: false,
    reason: PLAN_REVIEW_NOT_ACTIVE_REASON,
    message: captureFailed
      ? 'The screen could not be re-read, so no key was sent. Retry once the pane responds.'
      : 'No Command Code plan review (REVIEW) is on screen, so no key was sent.',
    answer: answer ?? '',
  };
}
