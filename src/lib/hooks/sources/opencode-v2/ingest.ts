/**
 * Where OpenCode V2's mapped events enter CommandMate's agent-event state
 * (Issue #2934, decision D5).
 *
 * Phase 1 records state and nothing more:
 *
 *  - a turn boundary (`user_prompt_submit` / `stop`) is recorded as-is, and a
 *    `stop` also runs the same stop side effects every tool's `Stop` does
 *    (`applyAgentStopEvent`: task events, verification) so `commandmate wait`
 *    completes on it. A failed turn (`stop` / `error`) is logged as an error;
 *  - an approval request opens a pending decision (the pane shows `waiting`)
 *    with `promptSettled: false` — nobody adjudicates it here, because the
 *    approval UI and `…/permission/{id}/reply` are Phase 2. The human answers
 *    in the TUI, and the `permission.replied` that follows retires it by id;
 *  - a question (`form.created`) opens a pending decision the same way, marked
 *    as a question, and `form.replied` / `form.cancelled` retire it.
 *
 * Never throws: an ingest failure is logged and the scraper keeps deciding.
 *
 * @module lib/hooks/sources/opencode-v2/ingest
 */

import { createLogger } from '@/lib/logger';
import { MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';
import { OPENCODE_QUESTION_TOOL_NAME } from '@/lib/hooks/pending-decision-kind';
import {
  classifyAgentEventDelivery,
  recordAgentEvent,
  reportQuestionPending,
  type AgentEventRecord,
} from '@/lib/session/agent-event-state';
import { MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH } from '@/lib/session/structured-prompt';
import type { AgentInstanceRef, NormalizedAgentEvent } from '../types';
import {
  OPENCODE_V2_DECISION_SETTLED_DETAIL,
  OPENCODE_V2_FAILED_DETAIL,
  OPENCODE_V2_PERMISSION_DETAIL,
  OPENCODE_V2_QUESTION_DETAIL,
  frameDecisionId,
  frameFailureMessage,
  framePermissionAction,
  frameType,
} from './mappers';
import { OPENCODE_V2_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/opencode-v2/ingest');

/** Seam for tests: what a `stop` does beyond being recorded. */
export type OpencodeV2StopEffect = (target: AgentInstanceRef, instanceId: string) => Promise<void>;

async function applyStop(target: AgentInstanceRef, instanceId: string): Promise<void> {
  const [{ getDbInstance }, { getWorktreeById }, { applyAgentStopEvent }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
    import('@/lib/hooks/agent-event-service'),
  ]);
  const db = getDbInstance();
  const worktree = getWorktreeById(db, target.worktreeId) ?? null;
  if (!worktree) {
    logger.info('opencode-v2-stop-unresolved-target', { worktreeId: target.worktreeId });
    return;
  }
  await applyAgentStopEvent(db, worktree, OPENCODE_V2_CLI_TOOL_ID, instanceId);
}

/**
 * Record one mapped event for the instance it arrived on.
 *
 * @param target - The instance whose server produced the event
 * @param event - The normalized event
 * @param stopEffect - What a `stop` runs after being recorded (tests replace it)
 */
export async function ingestOpencodeV2Event(
  target: AgentInstanceRef,
  event: NormalizedAgentEvent,
  stopEffect: OpencodeV2StopEffect = applyStop
): Promise<void> {
  const instanceId = target.instanceId ?? OPENCODE_V2_CLI_TOOL_ID;
  try {
    const delivery = classifyAgentEventDelivery({
      worktreeId: target.worktreeId,
      cliToolId: OPENCODE_V2_CLI_TOOL_ID,
      instanceId,
      event: event.event,
      detail: event.detail,
      sessionId: event.conversationId,
      at: event.receivedAt,
      identity: null,
      identityKind: null,
    });
    if (delivery.duplicate) {
      logger.info('opencode-v2-event-duplicate-dropped', {
        worktreeId: target.worktreeId,
        instanceId,
        event: event.event,
        detail: event.detail,
        by: delivery.by,
      });
      return;
    }

    const record: AgentEventRecord = {
      event: event.event,
      at: event.receivedAt,
      detail: event.detail?.slice(0, MAX_EVENT_DETAIL_LENGTH) ?? null,
      sessionId: event.conversationId,
      message: null,
      model: event.model,
    };
    const options = { sessionStartMayArriveLate: false };

    if (event.event === 'notification' && event.detail === OPENCODE_V2_PERMISSION_DETAIL) {
      record.decisionId = frameDecisionId(event.raw);
      record.toolName = framePermissionAction(event.raw);
      // Phase 1 has no adjudicator: the dialog is open until the human answers
      // it in the TUI and `permission.replied` says so.
      record.promptSettled = false;
      recordAgentEvent(target.worktreeId, OPENCODE_V2_CLI_TOOL_ID, instanceId, record, options);
    } else if (
      event.event === 'notification' &&
      event.detail === OPENCODE_V2_DECISION_SETTLED_DETAIL
    ) {
      record.decisionId = frameDecisionId(event.raw);
      record.promptSettled = true;
      recordAgentEvent(target.worktreeId, OPENCODE_V2_CLI_TOOL_ID, instanceId, record, options);
    } else if (event.event === 'notification' && event.detail === OPENCODE_V2_QUESTION_DETAIL) {
      recordAgentEvent(target.worktreeId, OPENCODE_V2_CLI_TOOL_ID, instanceId, record, options);
      reportQuestionPending(
        target.worktreeId,
        OPENCODE_V2_CLI_TOOL_ID,
        instanceId,
        {
          toolName: OPENCODE_QUESTION_TOOL_NAME,
          decisionId: frameDecisionId(event.raw),
          detail: OPENCODE_V2_QUESTION_DETAIL,
        },
        event.receivedAt
      );
    } else if (event.event === 'stop') {
      if (event.detail === OPENCODE_V2_FAILED_DETAIL) {
        record.message =
          frameFailureMessage(event.raw)?.slice(0, MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH) ?? null;
        logger.error('opencode-v2-turn-failed', {
          worktreeId: target.worktreeId,
          instanceId,
          sessionId: event.conversationId,
          message: record.message,
        });
      }
      recordAgentEvent(target.worktreeId, OPENCODE_V2_CLI_TOOL_ID, instanceId, record, options);
      await stopEffect(target, instanceId);
    } else {
      recordAgentEvent(target.worktreeId, OPENCODE_V2_CLI_TOOL_ID, instanceId, record, options);
    }

    logger.info('opencode-v2-event-received', {
      worktreeId: target.worktreeId,
      instanceId,
      type: frameType(event.raw),
      event: event.event,
      detail: event.detail,
    });
  } catch (error) {
    logger.error('opencode-v2-event-ingest-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      event: event.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
