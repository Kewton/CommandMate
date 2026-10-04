/**
 * The prompt-response route's send and what follows it (Issue #3171, split out
 * of the route; the behaviour is Issues #287, #1548, #1681, #1685, #1726,
 * #2033, #2573, #2583, #2755 and #3093).
 *
 * @module app/api/worktrees/[id]/prompt-response/answer-delivery
 */

import { NextResponse } from 'next/server';
import { recordAnsweredPrompt } from '@/lib/db';
import { broadcastMessage } from '@/lib/ws-server';
import type { PromptDetectionResult } from '@/lib/detection/prompt-detector';
import {
  sendPromptAnswer,
  PromptAnswerRejectedError,
  FreeTextAnswerRejectedError,
  FreeTextAtChoiceOnlyPromptError,
  MultiSelectAnswerRejectedError,
} from '@/lib/prompt-answer-sender';
import type { AnswerResolution } from '@/lib/prompt-answer-semantic';
import { startPolling } from '@/lib/polling/response-poller';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { findTextFollowUp } from './text-follow-up';
import { logger, logRefused, type PromptResponseContext } from './context';
import type { ValidatedPromptResponse } from './request-validation';
import type { ResolvedAnswer } from './answer-resolution';

/** The response for an error `sendPromptAnswer` threw. */
function sendErrorResponse(
  ctx: PromptResponseContext,
  error: unknown,
  answer: string | undefined,
  resolution: AnswerResolution,
): NextResponse {
  // Issue #2033: a refusal is not a transport failure. Nothing was typed and
  // the dialog is untouched, so it is reported the same way this route's
  // other pre-send refusals are — `success: false` with a reason code — and
  // not as a 500 that would leave the operator unsure whether a key landed.
  if (error instanceof PromptAnswerRejectedError) {
    logRefused(ctx, {
      reason: error.reason,
      dialogKind: error.dialogKind,
      answerMode: error.answerMode,
    });
    return NextResponse.json({
      success: false,
      reason: error.reason,
      message: error.message,
      answer: answer ?? '',
    });
  }
  // Issue #2573: the same guarantee for text aimed at a menu row — the
  // "No, tell … what to do differently" row PromptPanel used to send the
  // reason at. Issue #2583 extends it to the dialog with no such row at all
  // (claude's and agy's Bash approvals), where a refusal typed as free text
  // used to answer `success: true` and run the command. Both are refused
  // before a key, so the dialog is still up and the operator can answer it
  // with the option number. They share a reason code on purpose; what
  // differs is only the evidence each can log.
  // Issue #2755: the checkbox arm gave up. Unlike the three above it does
  // not always promise an untouched pane — ticking boxes is the first half
  // of this answer — so `keysSent` is logged and the message says which of
  // the two the operator is looking at. What it does promise is that the
  // question was never submitted, which is why this is a refusal and not a
  // 500.
  if (error instanceof MultiSelectAnswerRejectedError) {
    logRefused(ctx, {
      reason: error.reason,
      stage: error.stage,
      keysSent: error.keysSent,
    });
    return NextResponse.json({
      success: false,
      reason: error.reason,
      message: error.message,
      answer: resolution.input,
    });
  }
  if (error instanceof FreeTextAnswerRejectedError || error instanceof FreeTextAtChoiceOnlyPromptError) {
    logRefused(ctx, {
      reason: error.reason,
      ...(error instanceof FreeTextAnswerRejectedError
        ? { optionNumbers: error.optionNumbers }
        : { optionCount: error.optionCount }),
    });
    return NextResponse.json({
      success: false,
      reason: error.reason,
      message: error.message,
      answer: answer ?? '',
    });
  }
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  return NextResponse.json(
    { error: `Failed to send answer to tmux: ${errorMessage}` },
    { status: 500 }
  );
}

/**
 * Send the resolved answer to tmux. Null once it was sent; otherwise the
 * refusal or the transport failure to return.
 */
export async function sendResolvedAnswer(
  ctx: PromptResponseContext,
  request: ValidatedPromptResponse,
  sessionName: string,
  resolved: ResolvedAnswer,
  verifiedFrame: string | null,
): Promise<NextResponse | null> {
  const { resolution, effectivePromptData } = resolved;
  // Send answer to tmux
  // Issue #287 Bug2: Uses shared sendPromptAnswer() to unify logic
  // with auto-yes-manager.ts, including fallback handling.
  try {
    await sendPromptAnswer({
      sessionName,
      answer: resolution.input,
      cliToolId: ctx.cliToolId,
      promptData: effectivePromptData,
      fallbackPromptType: request.bodyPromptType,
      fallbackDefaultOptionNumber: request.bodyDefaultOptionNumber,
      fallbackSubmitMode: request.validSubmitMode,
      // Issue #2033: the frame the prompt was re-verified against, raw. Undefined
      // only when that capture failed, where the sender reads the pane itself.
      frame: verifiedFrame ?? undefined,
    });
  } catch (error: unknown) {
    return sendErrorResponse(ctx, error, request.answer, resolution);
  }
  return null;
}

/**
 * Issue #1685: persist question/options/answer for the audit trail. Skipped
 * when the pre-send capture failed (promptCheck null) — there is nothing
 * trustworthy to record. Shares the useAutoYes attribution caveat in
 * {@link finishAnsweredPrompt}.
 */
function recordAnswerForAudit(
  ctx: PromptResponseContext,
  promptCheck: PromptDetectionResult | null,
  resolved: ResolvedAnswer,
): void {
  const { resolution, effectivePromptData } = resolved;
  if (!promptCheck?.isPrompt || !effectivePromptData) return;
  try {
    // Issue #1681 resolved semantic answers to a concrete input before
    // sending — record what actually reached the terminal. Issue #1726: with
    // the agent's own labels, so the audit trail says which choice was made
    // rather than which line the pane happened to be showing.
    const record = recordAnsweredPrompt(ctx.db, {
      worktreeId: ctx.id,
      cliToolId: ctx.cliToolId,
      instanceId: ctx.instanceId ?? ctx.cliToolId,
      promptData: effectivePromptData,
      answer: resolution.input,
      answeredBy: 'human',
      content: promptCheck.rawContent || promptCheck.cleanContent,
    });
    broadcastMessage(record.created ? 'message' : 'message_updated', {
      worktreeId: ctx.id,
      message: record.message,
    });
  } catch (recordError) {
    // Audit persistence must never fail a response that already reached tmux.
    logger.warn('prompt-audit-record-failed', {
      error: recordError instanceof Error ? recordError.message : String(recordError),
    });
  }
}

/** Everything after the answer reached tmux, ending in the success body. */
export function finishAnsweredPrompt(
  ctx: PromptResponseContext,
  promptCheck: PromptDetectionResult | null,
  resolved: ResolvedAnswer,
): NextResponse {
  const { id, db, cliToolId, instanceId } = ctx;
  const { resolution, structuredResolution, effectivePromptData } = resolved;
  // Issue #1548: a person answered. Attributed to the instance that was asked
  // — `instanceId` is undefined for the primary, which `getActiveTaskForInstance`
  // expects to be named by the tool id.
  //
  // Caveat: the browser-side Auto-Yes fallback (`useAutoYes`) posts here too,
  // and is recorded as human. It only runs when the server poller is absent,
  // which is also when nothing else would record the answer at all — an
  // over-count is preferable to a gap in the log.
  applyEventToActiveTask(db, id, cliToolId, instanceId ?? cliToolId, 'prompt_answered_human', {
    promptType: effectivePromptData?.type,
  });

  recordAnswerForAudit(ctx, promptCheck, resolved);

  // The prompt poller normally stops while waiting for input. Resume response
  // persistence and independently push the TUI redraw after this interaction.
  startPolling(id, cliToolId, instanceId);
  void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);

  // Issue #3093: a "No, tell … what to do differently" row continues as text
  // in the composer, which only `send` reaches — say so in the answer itself.
  const textFollowUp = findTextFollowUp(effectivePromptData, resolution.input);

  return NextResponse.json({
    success: true,
    answer: resolution.input,
    ...(textFollowUp ? { textFollowUp } : {}),
    // Issue #1681: audit trail — which option a semantic/default answer
    // selected. Issue #1726 adds the label match against the agent's own
    // options, which resolves before `resolvePromptAnswer` ever sees the
    // answer and therefore has to be merged in here.
    ...(structuredResolution ?? resolution.resolved
      ? { resolved: structuredResolution ?? resolution.resolved }
      : {}),
  });
}
