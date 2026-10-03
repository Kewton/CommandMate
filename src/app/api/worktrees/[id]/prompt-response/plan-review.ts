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
  planCommandCodePlanReviewKeys,
  sendCommandCodePlanReviewKeys,
  type PlanReviewAction,
} from '@/lib/cli-tools/command-code-plan-review';
import type { CommandCodePlanReviewState } from '@/lib/detection/tools/command-code/plan-review-state';

/** The reason for a plan review action asked of a screen that is not one. */
export const PLAN_REVIEW_NOT_ACTIVE_REASON = 'plan_review_not_active';

export interface PlanReviewAnswer {
  /** Whether keys were sent (a refusal sends none). */
  sent: boolean;
  action: PlanReviewAction | null;
  body: Record<string, unknown>;
}

/**
 * Answer the overlay on `sessionName`.
 *
 * @throws whatever the tmux transport throws once keys are being sent
 */
export async function answerCommandCodePlanReview(args: {
  sessionName: string;
  state: CommandCodePlanReviewState;
  action: PlanReviewAction | undefined;
  answer: string | undefined;
  useDefault: boolean;
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
  await sendCommandCodePlanReviewKeys(sessionName, plan.steps);
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
