/**
 * The prompt-response route's re-verification of the screen (Issue #3171,
 * split out of the route; the behaviour is Issues #161, #2033, #2522, #2755,
 * #2870 and #3125).
 *
 * @module app/api/worktrees/[id]/prompt-response/frame-verification
 */

import { NextResponse } from 'next/server';
import { captureSessionOutputFresh } from '@/lib/session/cli-session';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';
import { assessPromptAnswerability } from '@/lib/polling/auto-yes-dialog-gate';
import { startPolling } from '@/lib/polling/response-poller';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import {
  readCommandCodePlanReviewState,
  type CommandCodePlanReviewState,
} from '@/lib/detection/tools/command-code/plan-review-state';
import {
  answerCommandCodePlanReview,
  planReviewNotActiveBody,
} from './plan-review';
import { logger, logRefused, type PromptResponseContext, type StageResult } from './context';
import type { ValidatedPromptResponse } from './request-validation';

/** What the fresh capture gave, before anything was read off it. */
interface CapturedFrame {
  /**
   * Issue #2033: kept so the answerMode guard judges the SAME frame this
   * verification passed, rather than taking a second capture of a screen that
   * may have moved on.
   */
  verifiedFrame: string | null;
  /**
   * Issue #2755: whether the re-verification could not be done at all. Every
   * other answer keeps the #1699 policy of carrying on (see the catch), and a
   * checkbox answer is the one exception — see `MULTI_SELECT_UNVERIFIED_MESSAGES`.
   */
  verificationFailed: boolean;
  /** Issue #3125: Command Code's plan review overlay, when that is the screen. */
  planReviewState: CommandCodePlanReviewState | null;
}

/** The verified screen the answer is resolved and sent against. */
export interface VerifiedPrompt {
  promptCheck: PromptDetectionResult | null;
  verifiedFrame: string | null;
  /**
   * Issue #2522: whether THIS prompt came from Command Code's question reader —
   * about the frame that was actually verified, not about a screen that may
   * have moved on.
   */
  isCommandCodeQuestion: boolean;
  verificationFailed: boolean;
}

/**
 * Issue #161: Re-verify that a prompt is still active before sending keys.
 * This prevents a race condition where the prompt disappears between
 * detection (in current-output API) and sending (here), causing "1" to
 * be typed at the Claude user input prompt instead of a tool permission prompt.
 */
async function captureFrame(ctx: PromptResponseContext): Promise<CapturedFrame> {
  const captured: CapturedFrame = { verifiedFrame: null, verificationFailed: false, planReviewState: null };
  try {
    const currentOutput = await captureSessionOutputFresh(ctx.id, ctx.cliToolId, undefined, ctx.instanceId);
    captured.verifiedFrame = currentOutput;
    if (ctx.cliToolId === 'command-code') {
      captured.planReviewState = readCommandCodePlanReviewState(currentOutput);
    }
  } catch {
    // If capture fails, proceed with caution - don't block manual responses
    captured.verificationFailed = true;
    logger.warn('failed-to-verify-prompt');
  }
  return captured;
}

/**
 * Issue #3125: the plan review overlay is neither an options dialog nor the
 * composer, so the reading below finds no prompt on it and answers
 * `prompt_no_longer_active` — while `wait` reports it as
 * `command_code_plan_review`. It is answered here instead, and never on a
 * frame that could not be read. Null when this is not a plan review answer.
 */
async function answerPlanReviewIfShown(
  ctx: PromptResponseContext,
  request: ValidatedPromptResponse,
  sessionName: string,
  captured: CapturedFrame,
): Promise<NextResponse | null> {
  const { planReviewState } = captured;
  const { answer, planReviewAction } = request;
  if (planReviewState === null && planReviewAction !== undefined) {
    logRefused(ctx, { reason: 'plan_review_not_active' });
    return NextResponse.json(planReviewNotActiveBody(answer, captured.verificationFailed));
  }
  if (planReviewState === null) return null;

  let planReview;
  try {
    planReview = await answerCommandCodePlanReview({
      sessionName,
      state: planReviewState,
      action: planReviewAction,
      answer,
      useDefault: request.useDefault,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: `Failed to send answer to tmux: ${errorMessage}` },
      { status: 500 }
    );
  }
  if (!planReview.sent) {
    logRefused(ctx, { reason: planReview.body.reason, phase: planReviewState.phase });
    return NextResponse.json(planReview.body);
  }
  const { id, db, cliToolId, instanceId } = ctx;
  // A comment leaves the agent waiting on the same review; every other
  // action is the human's decision about the plan.
  if (planReview.action !== 'comment') {
    applyEventToActiveTask(db, id, cliToolId, instanceId ?? cliToolId, 'prompt_answered_human', {});
  }
  startPolling(id, cliToolId, instanceId);
  void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);
  return NextResponse.json(planReview.body);
}

/**
 * Read the prompt off the captured frame, or refuse the answer when that frame
 * says it may not be answered.
 */
function assessFrame(
  ctx: PromptResponseContext,
  answer: string | undefined,
  captured: CapturedFrame,
): StageResult<VerifiedPrompt> {
  const verified: VerifiedPrompt = {
    promptCheck: null,
    verifiedFrame: captured.verifiedFrame,
    isCommandCodeQuestion: false,
    verificationFailed: captured.verificationFailed,
  };
  if (verified.verificationFailed || verified.verifiedFrame === null) return { value: verified };

  const currentOutput = verified.verifiedFrame;
  try {
    // Issue #2870: the reading is `assessPromptAnswerability`, the SAME one
    // the status API publishes as `promptAnswerable`, so the UI never offers
    // Send for a frame this route would refuse (#2868). In order: the tool's
    // own reader first — agy's `↑/↓ Navigate` dialog (#2364) and Command
    // Code's footer-less question, read off the capture itself (#2522) — then
    // the generic parser, then the shared presence gate the response poller
    // saves through (#2457, handed the capture, not the cleaned text), then
    // the refusal that says WHICH of "gone" and "unverifiable" it is (#2486).
    // This is the FRESH frame the answer is about to be sent at, which is the
    // whole point of re-verifying here.
    //
    // A Command Code question that is up and could not be read comes back as
    // `unsupported_dialog_layout` before the generic parser runs (確定仕様 B):
    // its partial list is exactly what must not reach a keystroke. Its
    // `presence` is unvouched, so the log line below still says `vouched: false`.
    const assessment = assessPromptAnswerability(ctx.cliToolId, currentOutput);
    const { presence, refusal } = assessment;
    verified.isCommandCodeQuestion = assessment.isCommandCodeQuestion;
    verified.promptCheck = assessment.promptCheck;
    if (refusal) {
      logRefused(ctx, { reason: refusal.reason, vouched: presence.present });
      return {
        response: NextResponse.json({
          success: false,
          reason: refusal.reason,
          ...(refusal.message ? { message: refusal.message } : {}),
          answer: answer ?? '',
        }),
      };
    }
  } catch {
    // Proceed with caution - don't block manual responses
    verified.verificationFailed = true;
    logger.warn('failed-to-verify-prompt');
  }
  return { value: verified };
}

/**
 * Re-read the screen and decide what the answer is sent against: a plan review
 * answered here, a deferred comma refusal, a refusal of the frame, or the
 * verified prompt the rest of the route resolves the answer against.
 */
export async function verifyPromptOnScreen(
  ctx: PromptResponseContext,
  request: ValidatedPromptResponse,
  sessionName: string,
): Promise<StageResult<VerifiedPrompt>> {
  const captured = await captureFrame(ctx);
  const planReviewResponse = await answerPlanReviewIfShown(ctx, request, sessionName, captured);
  if (planReviewResponse) return { response: planReviewResponse };
  if (request.deferredSelectionError !== null) {
    return { response: NextResponse.json({ error: request.deferredSelectionError }, { status: 400 }) };
  }
  return assessFrame(ctx, request.answer, captured);
}
