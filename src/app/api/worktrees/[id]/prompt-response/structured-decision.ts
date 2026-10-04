/**
 * The prompt-response route's structured-decision stage (Issue #3171, split out
 * of the route; the behaviour is Issue #1898's).
 *
 * @module app/api/worktrees/[id]/prompt-response/structured-decision
 */

import { NextResponse } from 'next/server';
import { answerStructuredDecision } from '@/lib/hooks/structured-decision-response';
import { startPolling } from '@/lib/polling/response-poller';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { logRefused, type PromptResponseContext } from './context';
import type { ValidatedPromptResponse } from './request-validation';

/**
 * Issue #1898: answer the approval the agent is actually holding, before going
 * anywhere near the pane.
 *
 * `respond` has only ever been able to press a key, so a dialog the detectors
 * cannot read was unanswerable — which on opencode is every approval: `wait`
 * reported it (exit 10) and told the operator to run `respond`, and `respond`
 * then answered `prompt_no_longer_active`. The structured layer knows the
 * decision by id and can reply to it over the agent's own API.
 *
 * Declines to `not-applicable` for every source with no decision identity and
 * for every session holding no approval, which is where the keystroke path
 * carries on unchanged (this returns null). The id is never taken from the
 * caller — see the module comment of `structured-decision-response` for why
 * that closes DR4-003 by construction.
 *
 * Issue #3125: never for a plan review action, which names no decision, nor for
 * an answer whose comma refusal is only deferred.
 */
export async function answerViaStructuredDecision(
  ctx: PromptResponseContext,
  request: ValidatedPromptResponse,
): Promise<NextResponse | null> {
  const { id, db, cliToolId, instanceId } = ctx;
  const { answer, useDefault } = request;
  const structuredDecision = request.planReviewAction !== undefined || request.deferredSelectionError !== null
    ? ({ kind: 'not-applicable', reason: 'no-decision-identity' } as const)
    : await answerStructuredDecision({
      worktreeId: id,
      cliToolId,
      instanceId,
      answer,
      useDefault,
    });
  if (structuredDecision.kind === 'refused') {
    logRefused(ctx, { reason: structuredDecision.reason });
    return NextResponse.json({
      success: false,
      reason: structuredDecision.reason,
      message: structuredDecision.message,
      answer: answer ?? '',
    });
  }
  if (structuredDecision.kind === 'answered') {
    const { option, decisionId, delivered } = structuredDecision;
    // Issue #1548: a person answered, attributed exactly as the keystroke
    // path attributes it.
    applyEventToActiveTask(db, id, cliToolId, instanceId ?? cliToolId, 'prompt_answered_human', {
      promptType: 'multiple_choice',
    });
    startPolling(id, cliToolId, instanceId);
    void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);
    return NextResponse.json({
      success: delivered,
      answer: String(option.number),
      ...(delivered ? {} : { reason: 'decision_not_delivered' }),
      resolved: {
        via: 'structured-decision',
        optionNumber: option.number,
        optionLabel: option.label,
        decisionId,
      },
    });
  }
  return null;
}
