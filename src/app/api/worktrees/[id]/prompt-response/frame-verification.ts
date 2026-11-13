/**
 * The prompt-response route's re-verification of the screen (Issue #3171,
 * split out of the route; the behaviour is Issues #161, #2033, #2522, #2755,
 * #2870 and #3125).
 *
 * @module app/api/worktrees/[id]/prompt-response/frame-verification
 */

import { NextResponse } from 'next/server';
import { captureBoundFrame, type BoundFrame, type BoundCapture } from '@/lib/session/cli-session';
import { PromptAnswerGenerationUnconfirmedError } from '@/lib/prompt-answer-sender';
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
  planReviewAnswerError,
  planReviewNotActiveBody,
} from './plan-review';
import { promptAnswerErrorResponse } from '@/lib/prompt-answer-errors';
import { logger, logRefused, type PromptResponseContext, type StageResult } from './context';
import { instanceInputReadMark } from '@/lib/session/instance-input-lock';
import type { ValidatedPromptResponse } from './request-validation';

/** What the fresh capture gave, before anything was read off it. */
interface CapturedFrame {
  /**
   * Issue #2033: kept so the answerMode guard judges the SAME frame this
   * verification passed, rather than taking a second capture of a screen that
   * may have moved on. Issue #4304 F1-a: bound to the pane generation it was
   * read from, which every key of the answer then goes to.
   */
  verifiedFrame: BoundFrame;
  /** Issue #3125: Command Code's plan review overlay, when that is the screen. */
  planReviewState: CommandCodePlanReviewState | null;
  /** Issue #3952: the session's input order, taken right before the capture. */
  readMark: number;
}

/** The verified screen the answer is resolved and sent against. */
export interface VerifiedPrompt {
  promptCheck: PromptDetectionResult | null;
  /** Issue #4304 F1-a: the verified frame, bound to its pane generation. */
  verifiedFrame: BoundFrame;
  /**
   * Issue #2522: whether THIS prompt came from Command Code's question reader —
   * about the frame that was actually verified, not about a screen that may
   * have moved on.
   */
  isCommandCodeQuestion: boolean;
  /**
   * Whether the frame could not be READ as a prompt (the reading threw).
   * Issue #4304 F1-a: no longer set by a failed capture — a capture that
   * cannot be bound is refused before this (`answer_not_delivered`).
   */
  verificationFailed: boolean;
  /**
   * Issue #3952 review P2-1: the session's input order, taken right before the
   * capture, for the send — so an answer a message send came between is read
   * again, as the plan review's is.
   */
  readMark: number;
}

/**
 * Issue #161: Re-verify that a prompt is still active before sending keys.
 * This prevents a race condition where the prompt disappears between
 * detection (in current-output API) and sending (here), causing "1" to
 * be typed at the Claude user input prompt instead of a tool permission prompt.
 *
 * Issue #4304 F1-a (design §4.2, the person's decision of 2026-11-14): the
 * capture is bound to its pane generation, and one that cannot be bound is NOT
 * carried on with any more — the old "If capture fails, proceed with caution -
 * don't block manual responses" sent the answer at a screen nobody had read.
 * It is refused with nothing typed (`answer_not_delivered`; send it again).
 */
async function captureFrame(ctx: PromptResponseContext): Promise<CapturedFrame | { unbound: BoundCapture & { kind: 'unknown' } }> {
  const readMark = instanceInputReadMark();
  const bound = await captureBoundFrame({ worktreeId: ctx.id, cliToolId: ctx.cliToolId, instanceId: ctx.instanceId });
  if (bound.kind === 'unknown') {
    logger.warn('failed-to-verify-prompt', { generationCheck: bound.reason });
    return { unbound: bound };
  }
  return {
    verifiedFrame: bound,
    planReviewState: ctx.cliToolId === 'command-code' ? readCommandCodePlanReviewState(bound.frame) : null,
    readMark,
  };
}

/** The refusal for a frame that could not be bound (Issue #4304 F1-a): nothing typed, send again. */
function unboundFrameResponse(
  ctx: PromptResponseContext,
  answer: string | undefined,
  unbound: BoundCapture & { kind: 'unknown' },
): NextResponse {
  const error = new PromptAnswerGenerationUnconfirmedError(unbound.reason, unbound.sessionName);
  const mapped = promptAnswerErrorResponse(error, 'prompt-response');
  if (mapped === null) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  logRefused(ctx, { reason: mapped.body.reason, generationCheck: unbound.reason });
  mapped.body.answer = answer ?? '';
  return NextResponse.json(mapped.body, { status: mapped.status });
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
    return NextResponse.json(planReviewNotActiveBody(answer, false));
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
      // Issue #3952: read again, as above, if a send typed after this capture.
      readMark: captured.readMark,
      // Issue #4304 F1-a: the frame the state was read off, whose pane every
      // step goes to, and a re-read of that pane only.
      frame: captured.verifiedFrame,
      recapture: (expected) =>
        captureBoundFrame({ worktreeId: ctx.id, cliToolId: ctx.cliToolId, instanceId: ctx.instanceId }, { expected }),
    });
  } catch (error: unknown) {
    // Issue #4031: through the same table as every other answer error, so a
    // review stopped part-way says `answer_input_lost` / `keysSent` (the
    // CLI's InputLost warning), and one stopped before its first step says
    // `answer_not_delivered` — not a bare 500.
    const answerError = planReviewAnswerError(error, sessionName);
    const mapped = promptAnswerErrorResponse(answerError, 'prompt-response');
    if (mapped !== null) {
      if (mapped.status === 200) {
        logRefused(ctx, { reason: mapped.body.reason, phase: planReviewState.phase });
        mapped.body.answer = answer ?? '';
      }
      return NextResponse.json(mapped.body, { status: mapped.status });
    }
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
    verificationFailed: false,
    readMark: captured.readMark,
  };

  const currentOutput = verified.verifiedFrame.frame;
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
    // The frame is bound to its pane; only its READING failed. Proceed with
    // caution (#1699) — what Issue #4304 F1-a stopped is a capture that failed.
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
  if ('unbound' in captured) return { response: unboundFrameResponse(ctx, request.answer, captured.unbound) };
  const planReviewResponse = await answerPlanReviewIfShown(ctx, request, sessionName, captured);
  if (planReviewResponse) return { response: planReviewResponse };
  if (request.deferredSelectionError !== null) {
    return { response: NextResponse.json({ error: request.deferredSelectionError }, { status: 400 }) };
  }
  return assessFrame(ctx, request.answer, captured);
}
