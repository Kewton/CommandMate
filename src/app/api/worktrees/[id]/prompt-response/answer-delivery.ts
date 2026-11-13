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
  PromptAnswerNotDeliveredError,
  PromptAnswerAgentNotInForegroundError,
} from '@/lib/prompt-answer-sender';
import { promptAnswerErrorResponse } from '@/lib/prompt-answer-errors';
import type { PromptData } from '@/types/models';
import {
  abandonManualSend,
  noteManualPaneSendStarting,
  settleManualAnswer,
  settleManualPaneAnswer,
  type ManualAnswerOutcome,
  type ManualAnswerTicket,
} from '@/lib/polling/auto-yes-manual-answer';
import {
  applyWhilePaneIsCurrent,
  deliverAnswer,
  paneAnswerContextOf,
  type AnswerDelivery,
  type PaneAnswerContext,
} from '@/lib/session/pane-answer-context';
import type { AnswerResolution } from '@/lib/prompt-answer-semantic';
import { startPolling } from '@/lib/polling/response-poller';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { captureTopOf, promptDataForStorage } from '@/lib/polling/prompt-screen-reading';
import { findTextFollowUp } from './text-follow-up';
import { logger, logRefused, type PromptResponseContext } from './context';
import type { ValidatedPromptResponse } from './request-validation';
import type { ResolvedAnswer } from './answer-resolution';
import type { BoundFrame } from '@/lib/session/cli-session';

/** The refusal's own evidence, for the log line (Issue #2033, #2573, #2583, #2755, #3952). */
function logSendRefusal(ctx: PromptResponseContext, error: unknown): void {
  if (error instanceof PromptAnswerRejectedError) {
    logRefused(ctx, {
      reason: error.reason,
      dialogKind: error.dialogKind,
      answerMode: error.answerMode,
    });
  } else if (error instanceof MultiSelectAnswerRejectedError) {
    logRefused(ctx, {
      reason: error.reason,
      stage: error.stage,
      keysSent: error.keysSent,
    });
  } else if (error instanceof FreeTextAnswerRejectedError || error instanceof FreeTextAtChoiceOnlyPromptError) {
    logRefused(ctx, {
      reason: error.reason,
      ...(error instanceof FreeTextAnswerRejectedError
        ? { optionNumbers: error.optionNumbers }
        : { optionCount: error.optionCount }),
    });
  } else if (error instanceof PromptAnswerNotDeliveredError) {
    logRefused(ctx, {
      reason: error.reason,
      skip: error.skip,
      // Issue #4303: refused before the first key — the agent did not hold the pane.
      ...(error instanceof PromptAnswerAgentNotInForegroundError ? { foreground: error.foreground } : {}),
    });
  }
}

/** The response for an error `sendPromptAnswer` threw. */
function sendErrorResponse(
  ctx: PromptResponseContext,
  error: unknown,
  answer: string | undefined,
  resolution: AnswerResolution,
): NextResponse {
  // Issue #3982: one table (`promptAnswerErrorResponse`) for this route and
  // `/respond`, so every error `prompt-answer-errors` defines carries `reason`
  // and `keysSent` on both.
  //
  // Issue #2033: a refusal is not a transport failure. Nothing was typed and
  // the dialog is untouched, so it is reported the same way this route's
  // other pre-send refusals are — `success: false` with a reason code — and
  // not as a 500 that would leave the operator unsure whether a key landed.
  // Issue #2573 / #2583: the same guarantee for free text aimed at a menu row
  // or at a dialog with no text field. Issue #2755: the checkbox arm gave up —
  // some boxes may be ticked (`keysSent`), but the question was never
  // submitted, which is why it is a refusal and not a 500. Issue #3952: the
  // answer waited for a send holding the session's input and was not typed
  // after it. Issue #3975 / #3982: the answer stopped part-way — keys are on
  // the pane — is a 500 with `reason: answer_input_lost` and `keysSent: true`.
  const mapped = promptAnswerErrorResponse(error, 'prompt-response');
  if (mapped !== null) {
    if (mapped.status === 200) {
      logSendRefusal(ctx, error);
      // The checkbox arm reports the resolved selection; the others the answer as sent.
      mapped.body.answer = error instanceof MultiSelectAnswerRejectedError ? resolution.input : (answer ?? '');
    }
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  return NextResponse.json(
    { error: `Failed to send answer to tmux: ${errorMessage}` },
    { status: 500 }
  );
}

/**
 * What a failed manual verdict over the agent's API left, for the answer
 * Auto-Yes holds there (Issue #3880 / #3925): the structured branches' thrown
 * delivery. A keystroke answer is read off its {@link AnswerDelivery} instead
 * (Issue #4304 F1-a, `settleManualPaneAnswer`). The refusals are before any
 * key; a transport failure says what it did (`keysSent`, `answerDelivery`).
 * Null for an error that says neither: the hold is left as it was.
 */
export function manualOutcomeOfSendError(error: unknown): ManualAnswerOutcome | null {
  if (
    error instanceof PromptAnswerRejectedError ||
    error instanceof FreeTextAnswerRejectedError ||
    error instanceof FreeTextAtChoiceOnlyPromptError
  ) {
    return 'not-sent';
  }
  if (!(error instanceof Error)) return null;
  const keysSent = 'keysSent' in error ? error.keysSent : undefined;
  const delivery = 'answerDelivery' in error ? error.answerDelivery : undefined;
  if (keysSent === true || delivery === 'indeterminate') return 'may-be-on-pane';
  if (keysSent === false) return 'not-sent';
  return null;
}

/**
 * A person's verdict over the agent's API threw (Issue #3880 / #3925): settled
 * by what the error says of it ({@link manualOutcomeOfSendError}), or only
 * abandoned when it says nothing. The structured stages of both routes; a
 * keystroke answer settles through its delivery (Issue #4304 F1-a).
 */
export function settleManualSendError(manualAnswer: ManualAnswerTicket, error: unknown): void {
  const outcome = manualOutcomeOfSendError(error);
  if (outcome !== null) settleManualAnswer(manualAnswer, outcome);
  else abandonManualSend(manualAnswer);
}

/**
 * A person's verdict delivered over the agent's API ended with this receipt
 * (Issue #3925), for `/respond`'s structured branch and this route's
 * structured stage alike: `true` (it reached the agent) is `answered`, `false`
 * (the source says it did not) is `not-sent`, and no receipt (`null`) says
 * nothing of the outcome, so the send is only abandoned.
 */
export function settleManualVerdictReceipt(manualAnswer: ManualAnswerTicket, delivered: boolean | null): void {
  if (delivered === null) abandonManualSend(manualAnswer);
  else settleManualAnswer(manualAnswer, delivered ? 'answered' : 'not-sent');
}

/**
 * A keystroke answer that went out in full (Issue #4304 F1-a): its delivery,
 * with the pane its keys went to, for {@link finishAnsweredPrompt}.
 */
export interface SentManualAnswer {
  readonly delivery: AnswerDelivery & { kind: 'sent' };
  readonly context: PaneAnswerContext;
  /** When the send began: an audit row adopts no pending row saved after it once the pane moved. */
  readonly startedAt: number;
}

/**
 * Send the resolved answer to tmux. The sent answer once it went out;
 * otherwise the refusal or the transport failure to return.
 *
 * Issue #3880: how the send ended is reported to Auto-Yes
 * (`settleManualPaneAnswer`), so a manual send that may have left keys on the
 * pane keeps the confirmation off Auto-Yes's hands after the manual hold, as
 * one of Auto-Yes's own would. `screenPromptData` is the prompt the fresh
 * capture read — the screen such a hold is recorded at, fixed with the session
 * epoch right before the first key.
 *
 * Issue #4304 F1-a (§3.3-1 / -2): the answer's context is the verified frame
 * (`PaneAnswerContext`): the send, the hold it records or releases and its
 * delivery all carry that pane's generation.
 */
export async function sendResolvedAnswer(
  ctx: PromptResponseContext,
  request: ValidatedPromptResponse,
  sessionName: string,
  resolved: ResolvedAnswer,
  verifiedFrame: BoundFrame,
  manualAnswer: ManualAnswerTicket,
  screenPromptData?: PromptData | null,
  readMark?: number,
): Promise<{ response: NextResponse } | { sent: SentManualAnswer }> {
  const { resolution, effectivePromptData } = resolved;
  const context = paneAnswerContextOf(verifiedFrame, sessionName);
  noteManualPaneSendStarting(manualAnswer, screenPromptData ?? effectivePromptData, context);
  const startedAt = Date.now();
  // Send answer to tmux
  // Issue #287 Bug2: Uses shared sendPromptAnswer() to unify logic
  // with auto-yes-manager.ts, including fallback handling.
  const delivery = await deliverAnswer({ kind: 'pane', context }, () =>
    sendPromptAnswer({
      sessionName,
      answer: resolution.input,
      cliToolId: ctx.cliToolId,
      promptData: effectivePromptData,
      fallbackPromptType: request.bodyPromptType,
      fallbackDefaultOptionNumber: request.bodyDefaultOptionNumber,
      fallbackSubmitMode: request.validSubmitMode,
      // Issue #2033: the frame the prompt was re-verified against, raw.
      // Issue #4304 F1-a: bound to its pane generation — every key goes there.
      frame: context.frame,
      // Issue #3952 review P2-1: taken before that frame's capture, so a send
      // admitted between the capture and the answer's keys makes it read again.
      readMark,
    })
  );
  settleManualPaneAnswer(manualAnswer, delivery);
  if (delivery.kind !== 'sent') {
    return { response: sendErrorResponse(ctx, delivery.error, request.answer, resolution) };
  }
  return { sent: { delivery, context, startedAt } };
}

/**
 * The window `frame-verification`'s `captureFrame` takes the verified frame
 * with: `captureBoundFrame`'s default (`BOUND_FRAME_DEFAULT_LINES`, the same
 * 5000 as `captureSessionOutputFresh`'s), which it does not override
 * (pinned by `tests/unit/api/prompt-response-audit-reading-3881.test.ts`).
 */
const VERIFIED_FRAME_WINDOW_LINES = 5000;

/**
 * The `promptData` a person's answer is recorded with (Issue #3881 second
 * review N2): the answered prompt with `promptDataForStorage`'s reading of the
 * frame the answer was verified against — the same reading the Auto-Yes
 * poller's audit row and the response poller's save store. A pending row the
 * response poller saved keeps its own reading (`recordAnsweredPrompt` spreads
 * it); this is what a row created here, or one saved without a reading, gets.
 * Without the verified frame there is nothing to read, and the prompt is
 * recorded as before.
 */
function auditPromptData(
  ctx: PromptResponseContext,
  promptCheck: PromptDetectionResult,
  effectivePromptData: PromptData,
  verifiedFrame: BoundFrame | null,
): PromptData {
  if (verifiedFrame === null) return effectivePromptData;
  return (
    promptDataForStorage(
      ctx.cliToolId,
      verifiedFrame.frame,
      { ...promptCheck, promptData: effectivePromptData },
      captureTopOf(verifiedFrame.frame, VERIFIED_FRAME_WINDOW_LINES, ctx.cliToolId),
    ) ?? effectivePromptData
  );
}

/**
 * Issue #1685: persist question/options/answer for the audit trail. Skipped
 * when the pre-send capture failed (promptCheck null) — there is nothing
 * trustworthy to record. Shares the attribution caveat in
 * {@link finishAnsweredPrompt}.
 */
function recordAnswerForAudit(
  ctx: PromptResponseContext,
  promptCheck: PromptDetectionResult | null,
  resolved: ResolvedAnswer,
  verifiedFrame: BoundFrame | null,
  pendingSavedAtOrBefore: number | null,
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
      // Issue #3881 (second review N2): with the reading of the verified frame.
      promptData: auditPromptData(ctx, promptCheck, effectivePromptData, verifiedFrame),
      answer: resolution.input,
      answeredBy: 'human',
      content: promptCheck.rawContent || promptCheck.cleanContent,
      // Issue #4304 F1-a: the pane answered is no longer the session's — the
      // row recorded is this answer's, not a pending row the new pane saved.
      ...(pendingSavedAtOrBefore === null ? {} : { pendingSavedAtOrBefore }),
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

/**
 * Everything after the answer reached tmux, ending in the success body.
 *
 * Issue #4304 F1-a (§3.3-3 / -5): the task event, the response-poll restart
 * and the terminal push act on the instance as it is NOW — through
 * `applyWhilePaneIsCurrent`, after every await, only while the session still
 * shows the pane the keys went to (alive, or dead by the answer). The audit row
 * is this answer's history and is written either way; once the pane moved it
 * adopts no pending row saved after the answer began.
 *
 * @param sent - The answer as it went out ({@link sendResolvedAnswer}); its
 *   context's frame is the frame the prompt was re-verified against, raw — the
 *   audit row's reading is read off it (Issue #3881 second review N2)
 */
export async function finishAnsweredPrompt(
  ctx: PromptResponseContext,
  promptCheck: PromptDetectionResult | null,
  resolved: ResolvedAnswer,
  sent: SentManualAnswer,
): Promise<NextResponse> {
  const { id, db, cliToolId, instanceId } = ctx;
  const { resolution, structuredResolution, effectivePromptData } = resolved;
  const verdict = await applyWhilePaneIsCurrent(sent.context, { allowDead: true, owned: () => true }, () => {
    // Issue #1548: a person answered. Attributed to the instance that was
    // asked — `instanceId` is undefined for the primary, which
    // `getActiveTaskForInstance` expects to be named by the tool id.
    //
    // Caveat: a tab loaded before #3820 still runs the browser-side Auto-Yes
    // (`useAutoYes`), which sends no `origin` and is recorded as human. Issue
    // #3821 retired it: the route refuses the `origin` a later tab sends, and a
    // reload ends the older ones.
    applyEventToActiveTask(db, id, cliToolId, instanceId ?? cliToolId, 'prompt_answered_human', {
      promptType: effectivePromptData?.type,
    });
    // The prompt poller normally stops while waiting for input. Resume response
    // persistence and independently push the TUI redraw after this interaction.
    startPolling(id, cliToolId, instanceId);
    void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);
    return undefined;
  });
  if (verdict !== 'applied') logger.info('prompt-answered-pane-moved', { verdict });

  recordAnswerForAudit(ctx, promptCheck, resolved, sent.context.frame, verdict === 'applied' ? null : sent.startedAt);

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
