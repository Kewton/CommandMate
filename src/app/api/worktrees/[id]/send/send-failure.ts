/**
 * POST /api/worktrees/:id/send — the answer for a send the send service did
 * not complete (split out of `handleSend` by Issue #4055).
 */

import { NextResponse } from 'next/server';
import type { CLIToolType, ICLITool } from '@/lib/cli-tools/types';
import { commandCodePlanReviewSendMessage } from '@/lib/session/respond-target';
import type { SendAttemptState } from '@/lib/session/send-attempt-types';
import {
  describeSendAttemptState,
  getLastSendAttempt,
  sendMessageDigest,
  type SendAttemptInstance,
} from '@/lib/session/send-attempt-state';
import { SESSION_STARTING_CODE } from '@/lib/session/session-start-error';
import { FOREIGN_SESSION_ERROR_CODE } from '@/lib/cli-tools/session-ownership';
import { answerSessionStartTimeout } from './send-session-start';

/**
 * The fields of a failed `sendUserMessage` result this answer reads. Written
 * out rather than imported: `send-user-message` and `prompt-waiting-guard`
 * keep their importers enumerated (tests/integration/api-send-prompt-waiting-1708),
 * and the route stays the one that imports them.
 */
export interface FailedSendResult {
  stage: string;
  error: string;
  code?: string;
}

/** What {@link answerSendFailure} answers from (Issue #4055). */
export interface SendFailureInput {
  cliTool: ICLITool;
  worktreeId: string;
  instanceId: string | undefined;
  /** `body.model`, named in a failed model switch's message. */
  model: string | undefined;
  sendAttemptInstance: SendAttemptInstance;
  /** This request's own attempt, when the service handed it over (Issue #3945). */
  ownAttempt: { state: SendAttemptState; reason: string } | null;
  sendStartedAt: number;
  trimmedContent: string;
  /**
   * The tool Command Code's plan review refusal names in its `respond` when
   * the primary was sent to (Issue #4063, `resolveRespondAgent` for
   * `command-code`); undefined when a bare `respond` already reaches it.
   */
  planReviewRespondAgent?: CLIToolType;
}

/**
 * The answer for a failed send other than `prompt_waiting` (the route answers
 * that one). A start still coming up is answered unawaited, as the handler
 * returned it.
 */
export function answerSendFailure(
  result: FailedSendResult,
  input: SendFailureInput,
): NextResponse | Promise<NextResponse> {
  const { cliTool, worktreeId: id, instanceId, sendAttemptInstance, ownAttempt, sendStartedAt, trimmedContent } = input;
  // Issue #2865: checked above as well; this is the send service's own
  // refusal (the session changed hands in between, or the row vanished).
  if (result.stage === 'foreign_session') {
    return NextResponse.json(
      { error: result.error, code: FOREIGN_SESSION_ERROR_CODE },
      { status: 409 }
    );
  }
  // Issue #3006: the session this request (or one just before it) launched
  // has not shown its input prompt yet. Answered exactly as a slow start
  // above is — 503 + SESSION_STARTING, message unwrapped — so the CLI and
  // dispatch read one "still starting, retry" whichever step noticed it.
  if (result.code === SESSION_STARTING_CODE) {
    return answerSessionStartTimeout(result.error, cliTool, id, instanceId);
  }
  if (result.stage === 'model') {
    return NextResponse.json(
      { error: `Failed to switch model to ${input.model}: ${result.error}` },
      { status: 500 }
    );
  }
  // Issue #3759: say whether the message can be resent (`not-sent`) or must
  // not be before the pane is checked (`indeterminate`). Nothing resends it.
  // The record must be this request's. Issue #3945: the service hands this
  // request its own attempt; the shared record (same message, made after
  // the request began) is only the fallback for a service that did not —
  // with two concurrent sends of one text it cannot say whose it is.
  const recorded = getLastSendAttempt(sendAttemptInstance);
  const attempt: { state: SendAttemptState; reason: string } | null =
    ownAttempt ??
    (recorded !== null &&
    recorded.at >= Math.floor(sendStartedAt) &&
    recorded.messageDigest === sendMessageDigest(trimmedContent)
      ? recorded
      : null);
  const sendState = attempt !== null ? ` ${describeSendAttemptState(attempt)}` : '';
  return NextResponse.json(
    { error: `Failed to send message to ${cliTool.name}: ${aimPlanReviewRefusal(result.error, attempt, input)}${sendState}` },
    { status: 500 }
  );
}

/**
 * The plan review refusal with the `respond` aimed at the waiting session
 * (Issue #4063). Command Code's own throw cannot know the request, so a
 * `send --agent command-code` on a worktree whose default is another tool got
 * a bare `respond` — which the CLI resolves to that default. Rebuilt here with
 * the tool `resolveRespondAgent` chose; every other failure, and a refusal
 * that needs no tool, keeps its text.
 */
function aimPlanReviewRefusal(
  error: string,
  attempt: { reason: string } | null,
  input: SendFailureInput,
): string {
  if (attempt?.reason !== 'plan-review' || input.planReviewRespondAgent === undefined) return error;
  return error.replace(
    commandCodePlanReviewSendMessage(input.worktreeId, input.instanceId),
    commandCodePlanReviewSendMessage(input.worktreeId, input.instanceId, input.planReviewRespondAgent),
  );
}
