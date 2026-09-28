/**
 * Where OpenCode V2's mapped events enter CommandMate's agent-event state
 * (Issue #2934, decision D5).
 *
 *  - a turn boundary (`user_prompt_submit` / `stop`) is recorded as-is, and a
 *    `stop` also runs the same stop side effects every tool's `Stop` does
 *    (`applyAgentStopEvent`: task events, verification) so `commandmate wait`
 *    completes on it. A failed turn (`stop` / `error`) is logged as an error;
 *  - an approval request (Issue #2945 D1/D3) is adjudicated FIRST — Auto-Yes
 *    answers it over `…/permission/{id}/reply` through the same
 *    `adjudicatePendingPermission` v1 uses — and then recorded as a pending
 *    decision carrying its action, the rule `Always allow` would save and the
 *    diff, so the PC panel and the phone sheet can show what they are
 *    approving. `promptSettled` is whether the verdict was delivered; the
 *    `permission.replied` that follows any answer (ours, another client's, or
 *    the human's in the TUI) retires it by id;
 *  - a question (`form.created`, Issue #2945 D2) is recorded, its fields are
 *    read (off the frame's `data.form`, or `GET /api/session/{id}/form`) and
 *    published as the question's choices, the phone is notified the way v1's
 *    `question.asked` notifies it, and `form.replied` / `form.cancelled` retire
 *    it.
 *
 * Never throws: an ingest failure is logged and the scraper keeps deciding.
 *
 * @module lib/hooks/sources/opencode-v2/ingest
 */

import { createLogger } from '@/lib/logger';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import { MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';
import { adjudicatePendingPermission } from '@/lib/hooks/permission-adjudication';
import { OPENCODE_QUESTION_TOOL_NAME } from '@/lib/hooks/pending-decision-kind';
import {
  classifyAgentEventDelivery,
  recordAgentEvent,
  recordAskUserQuestion,
  reportQuestionPending,
  type AgentEventRecord,
} from '@/lib/session/agent-event-state';
import { MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH } from '@/lib/session/structured-prompt';
import { isPlainObject } from '../event-mapper';
import { notifyOpencodeQuestionPush } from '../opencode/push';
import type { AgentInstanceRef, NormalizedAgentEvent } from '../types';
import { fetchOpencodeV2SessionForms } from './client';
import {
  OPENCODE_V2_DECISION_SETTLED_DETAIL,
  OPENCODE_V2_FAILED_DETAIL,
  OPENCODE_V2_PERMISSION_DETAIL,
  OPENCODE_V2_QUESTION_DETAIL,
  frameDecisionId,
  frameFailureMessage,
  framePermissionAction,
  frameSessionId,
  frameType,
} from './mappers';
import {
  describeOpencodeV2Permission,
  parseOpencodeV2Form,
  readOpencodeV2PermissionSubject,
  toOpencodeV2PendingPermission,
} from './payloads';
import { getAssignedOpencodeV2Port } from './ports';
import { readOpencodeV2Password } from './secrets';
import { opencodeV2AgentEventSource } from './source';
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
 * Seam for tests: read the form a `form.created` frame names (Issue #2945).
 *
 * @returns The form object, or null when it could not be read
 */
export type OpencodeV2FormLoader = (
  target: AgentInstanceRef,
  sessionId: string,
  formId: string
) => Promise<Record<string, unknown> | null>;

/** `GET /api/session/{id}/form`, the form with this id. */
async function loadFormFromServer(
  target: AgentInstanceRef,
  sessionId: string,
  formId: string
): Promise<Record<string, unknown> | null> {
  const port = getAssignedOpencodeV2Port(target);
  const password = readOpencodeV2Password(target);
  if (port === null || password === null) return null;
  const forms = await fetchOpencodeV2SessionForms(port, password, sessionId);
  const form = forms?.find((entry) => isPlainObject(entry) && entry.id === formId);
  return isPlainObject(form) ? form : null;
}

/**
 * Judge one approval and deliver the verdict, before it is recorded
 * (Issue #2945 D3; the order is v1's #1898 fix).
 *
 * `adjudicatePendingPermission` is the one shared adjudicator: with Auto-Yes
 * off it abstains and nothing is sent; with it on it answers `once` unless a
 * deny pattern or the execution contract withholds it.
 *
 * @returns Whether the dialog may be treated as closed
 */
async function adjudicatePermission(
  target: AgentInstanceRef,
  event: NormalizedAgentEvent,
  instanceId: string
): Promise<boolean> {
  const pending = toOpencodeV2PendingPermission(event.raw, event.receivedAt);
  if (!pending) {
    logger.info('opencode-v2-permission-unparsed', { worktreeId: target.worktreeId, instanceId });
    return false;
  }
  const outcome = await adjudicatePendingPermission(
    opencodeV2AgentEventSource,
    target,
    pending,
    opencodeV2AgentEventSource.parsePermissionRequest(event.raw)
  );
  logger.info('opencode-v2-permission-decided', {
    worktreeId: target.worktreeId,
    instanceId,
    decisionId: pending.id,
    behavior: outcome.behavior,
    reason: outcome.reason,
    delivered: outcome.delivered,
    settled: outcome.settled,
  });
  return outcome.settled;
}

/**
 * The question a `form.created` frame opened, with its choices (Issue #2945 D2).
 *
 * The form is read off the frame — 2.0.18 sends the whole form as
 * `data.form` (measured for this Issue) — and, when a frame arrives without
 * it, from `GET /api/session/{id}/form`, the call Phase 0 answered it with.
 */
async function readQuestion(
  target: AgentInstanceRef,
  event: NormalizedAgentEvent,
  loadForm: OpencodeV2FormLoader
): Promise<AskUserQuestionSpec | null> {
  const fromFrame = parseOpencodeV2Form(event.raw);
  if (fromFrame) return fromFrame;
  const formId = frameDecisionId(event.raw);
  const sessionId = frameSessionId(event.raw);
  if (formId === null || sessionId === null) return null;
  const form = await loadForm(target, sessionId, formId);
  return form ? parseOpencodeV2Form(form) : null;
}

/**
 * Record one mapped event for the instance it arrived on.
 *
 * @param target - The instance whose server produced the event
 * @param event - The normalized event
 * @param stopEffect - What a `stop` runs after being recorded (tests replace it)
 * @param loadForm - How a question's form is read (tests replace it)
 */
export async function ingestOpencodeV2Event(
  target: AgentInstanceRef,
  event: NormalizedAgentEvent,
  stopEffect: OpencodeV2StopEffect = applyStop,
  loadForm: OpencodeV2FormLoader = loadFormFromServer
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
      // Issue #2945: the decision id, so two approvals a second apart are two
      // approvals — not one and a repeat inside the time window.
      identity: opencodeV2AgentEventSource.eventIdentityOf(event.raw),
      identityKind: opencodeV2AgentEventSource.capabilities.eventIdentity,
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
      const subject = readOpencodeV2PermissionSubject(event.raw);
      record.toolName = subject?.toolName ?? framePermissionAction(event.raw);
      record.decisionPatterns = subject?.patterns ?? null;
      // D1: the diff is what the card shows, carried as the record's message.
      record.message =
        describeOpencodeV2Permission(event.raw)?.slice(0, MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH) ??
        null;
      // D3: the verdict leaves BEFORE the record is written (v1's #1898 order).
      record.promptSettled = await adjudicatePermission(target, event, instanceId);
      recordAgentEvent(target.worktreeId, OPENCODE_V2_CLI_TOOL_ID, instanceId, record, options);
    } else if (
      event.event === 'notification' &&
      event.detail === OPENCODE_V2_DECISION_SETTLED_DETAIL
    ) {
      record.decisionId = frameDecisionId(event.raw);
      record.promptSettled = true;
      recordAgentEvent(target.worktreeId, OPENCODE_V2_CLI_TOOL_ID, instanceId, record, options);
    } else if (event.event === 'notification' && event.detail === OPENCODE_V2_QUESTION_DETAIL) {
      const spec = await readQuestion(target, event, loadForm);
      record.message =
        spec?.questions[0]?.question.slice(0, MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH) ?? null;
      recordAgentEvent(target.worktreeId, OPENCODE_V2_CLI_TOOL_ID, instanceId, record, options);
      // D2: the choices, for the panel's picker and `capture --prompts`. A form
      // no surface can offer choices for still opens the wait below, and the
      // human answers it in the TUI.
      if (spec) {
        recordAskUserQuestion(
          target.worktreeId,
          OPENCODE_V2_CLI_TOOL_ID,
          instanceId,
          spec,
          event.receivedAt
        );
      }
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
      logger.info('opencode-v2-question-recorded', {
        worktreeId: target.worktreeId,
        instanceId,
        decisionId: frameDecisionId(event.raw),
        parsed: spec !== null,
        questionCount: spec?.questions.length ?? 0,
      });
      // After the record, for v1's reason (#2045): the notification must not
      // describe a wait the rest of the process has not been told about yet.
      await notifyOpencodeQuestionPush(target, instanceId, record.message, event.receivedAt);
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
