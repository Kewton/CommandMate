/**
 * What a normalised opencode event does to CommandMate's state (Issue #1763).
 *
 * The consuming half of the pipeline was already tool-agnostic before this
 * Issue: `agent-event-state`, `permission-decision-service`,
 * `current-output-builder`, `status-mapping` and `prompt-waiting-composition`
 * all key off (worktree, tool, instance) and branch on nothing else. So this
 * module is deliberately thin — it is the same sequence
 * `POST /api/hooks/agent-event` and `POST /api/hooks/permission-request`
 * perform, called in-process because there is no request to perform it on.
 *
 * The one place the two paths differ is *where the verdict goes*. A hook is
 * answered in the body of the request it arrived on; an opencode approval is
 * answered by a POST to the agent's own server, minutes later if need be. Both
 * are spelled `answerPendingDecision(source, …)`, which is the seam #1759 built
 * for exactly this.
 *
 * ## Why the database imports are dynamic
 *
 * `../registry` statically imports `./source`, so anything `./source`'s module
 * graph reaches becomes part of every import of `@/lib/hooks/sources` —
 * including `better-sqlite3` if this module were pulled in eagerly. The state
 * effects are needed only when an event actually arrives, so they are imported
 * then. (`./source` does not import this module at all; the runtime wires the
 * two together.)
 *
 * Nothing here throws. An event is a fact about a session that is still
 * running, and a failure to record it must cost the record, never the session.
 *
 * @module lib/hooks/sources/opencode/ingest
 */

import { createLogger } from '@/lib/logger';
import { MAX_EVENT_DETAIL_LENGTH } from '@/lib/hooks/agent-event-types';
import {
  isDuplicateAgentEvent,
  recordAgentEvent,
  recordAskUserQuestion,
  reportPermissionRequestPending,
} from '@/lib/session/agent-event-state';
import { MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH } from '@/lib/session/structured-prompt';
import { describeAbstain } from '../abstain';
import { isPlainObject, readNestedString, readStringField } from '../event-mapper';
import { answerPendingDecision } from '../pending-decisions';
import { getAgentEventSource } from '../registry';
import type { AgentInstanceRef, NormalizedAgentEvent, Verdict } from '../types';
import {
  OPENCODE_ERROR_DETAIL,
  OPENCODE_PERMISSION_DETAIL,
  OPENCODE_QUESTION_DETAIL,
} from './mappers';
import { toOpencodePendingPermission } from './payloads';
import { OPENCODE_CLI_TOOL_ID } from './tool-id';

const logger = createLogger('lib/hooks/sources/opencode/ingest');

/** The one-line human-facing summary for a notification, or null. */
function describeNotification(event: NormalizedAgentEvent): string | null {
  const properties = isPlainObject(event.raw.properties) ? event.raw.properties : {};

  if (event.detail === OPENCODE_PERMISSION_DETAIL) {
    // `metadata.command` exists for `bash` approvals and is what the human is
    // being asked about; the approval kind is the fallback for the rest.
    return (
      readNestedString(properties, ['metadata', 'command']) ??
      readStringField(properties, 'permission')
    );
  }
  if (event.detail === OPENCODE_QUESTION_DETAIL) {
    const questions = properties.questions;
    if (Array.isArray(questions) && isPlainObject(questions[0])) {
      return readStringField(questions[0], 'question');
    }
    return null;
  }
  if (event.detail === OPENCODE_ERROR_DETAIL) {
    return (
      readNestedString(properties, ['error', 'data', 'message']) ??
      readNestedString(properties, ['error', 'name'])
    );
  }
  return null;
}

/**
 * Adjudicate one approval and answer it over REST (Auto-Yes v2).
 *
 * The adjudication itself is `resolvePermissionRequest`, unchanged and shared
 * with every hook-based tool. What is opencode-specific is what silence means:
 * on Claude an abstention costs a dialog, here it costs the session, because
 * the agent waits with no timeout at all (#1758 §5.5.3). `describeAbstain` is
 * how that gets said out loud — nothing else will say it, since a blocked
 * opencode session looks exactly like one that is thinking.
 */
async function adjudicatePermission(
  target: AgentInstanceRef,
  event: NormalizedAgentEvent,
  instanceId: string
): Promise<void> {
  const source = getAgentEventSource(OPENCODE_CLI_TOOL_ID);
  const pending = toOpencodePendingPermission(event.raw, event.receivedAt);
  if (!pending) {
    logger.info('opencode-permission-unparsed', {
      worktreeId: target.worktreeId,
      instanceId,
    });
    return;
  }

  const { resolvePermissionRequest } = await import('@/lib/hooks/permission-decision-service');
  const payload = source.parsePermissionRequest(event.raw);
  const decision = resolvePermissionRequest(
    { worktreeId: target.worktreeId, cliToolId: OPENCODE_CLI_TOOL_ID, instanceId },
    payload
  );

  const verdict: Verdict =
    decision.behavior === 'allow' ? { kind: 'allowOnce' } : { kind: 'abstain' };

  if (verdict.kind === 'abstain') {
    const abstain = describeAbstain(source);
    if (!abstain.safe) {
      logger.warn('permission-request-abstain-blocks-agent', {
        worktreeId: target.worktreeId,
        cliToolId: OPENCODE_CLI_TOOL_ID,
        instanceId,
        toolName: payload?.toolName ?? null,
        decisionId: pending.id,
        reason: decision.reason,
        consequence: abstain.summary,
        blocksForMs: abstain.blocksForMs,
      });
    }
  }

  // C2: for this source the verdict leaves over its own connection, and the
  // `{}` that comes back is an acknowledgement rather than a reply body.
  await answerPendingDecision(
    source,
    { worktreeId: target.worktreeId, cliToolId: OPENCODE_CLI_TOOL_ID, instanceId },
    pending,
    verdict
  );

  logger.info('opencode-permission-decided', {
    worktreeId: target.worktreeId,
    instanceId,
    decisionId: pending.id,
    toolName: payload?.toolName ?? null,
    behavior: decision.behavior,
    reason: decision.reason,
    suppressedBy: decision.suppressedBy,
  });
}

/**
 * Record a question so `capture --prompts` and the picker can show its options.
 *
 * The structured content Claude never had: its `AskUserQuestion` picker has to
 * be read off the screen (#1708), while opencode publishes the questions and
 * their choices as data (#1758 §5.2.4).
 *
 * `reportPermissionRequestPending` is called alongside because that is the only
 * exported way to tell the detection layer a human is blocked, and a question
 * blocks exactly as an approval does — the session reads `busy` and no
 * `session.idle` arrives until it is answered (§5.3.1). It is recorded as
 * provisional, so it expires unless the scraper corroborates it, which is the
 * same treatment Claude's pre-dialog prediction gets.
 */
function recordQuestion(
  target: AgentInstanceRef,
  event: NormalizedAgentEvent,
  instanceId: string
): void {
  const source = getAgentEventSource(OPENCODE_CLI_TOOL_ID);
  const spec = source.parseQuestion(event.raw);
  if (!spec) return;

  recordAskUserQuestion(
    target.worktreeId,
    OPENCODE_CLI_TOOL_ID,
    instanceId,
    spec,
    event.receivedAt
  );
  reportPermissionRequestPending(
    target.worktreeId,
    OPENCODE_CLI_TOOL_ID,
    instanceId,
    'question',
    event.receivedAt
  );
  logger.info('opencode-question-recorded', {
    worktreeId: target.worktreeId,
    instanceId,
    questionCount: spec.questions.length,
    optionCounts: spec.questions.map((question) => question.choices.length),
  });
}

/** Apply a completed turn to whatever the worktree is doing. */
async function applyStop(target: AgentInstanceRef, instanceId: string): Promise<void> {
  const [{ getDbInstance }, { getWorktreeById }, { applyAgentStopEvent }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
    import('@/lib/hooks/agent-event-service'),
  ]);

  const db = getDbInstance();
  const worktree = getWorktreeById(db, target.worktreeId) ?? null;
  if (!worktree) {
    // The worktree was removed while its pane was still running. Ordinary, not
    // an error — the same outcome the hook receiver reports as 202-and-drop.
    logger.info('opencode-stop-unresolved-target', { worktreeId: target.worktreeId });
    return;
  }

  const outcome = await applyAgentStopEvent(db, worktree, OPENCODE_CLI_TOOL_ID, instanceId);
  logger.info('opencode-stop-applied', {
    worktreeId: target.worktreeId,
    instanceId,
    taskId: outcome.taskId,
    taskEventApplied: outcome.taskEventApplied,
    verificationRunId: outcome.verificationRunId,
  });
}

/**
 * Apply one event from the stream.
 *
 * @param target - The instance the subscription belongs to
 * @param event - Already normalised and already through the turn gate
 */
export async function ingestOpencodeEvent(
  target: AgentInstanceRef,
  event: NormalizedAgentEvent
): Promise<void> {
  const instanceId = target.instanceId ?? OPENCODE_CLI_TOOL_ID;

  try {
    // The same guard the hook receiver applies. It cannot catch the abort
    // double-idle on its own — see `./turn-gate`, which is what does — but it
    // does cover a frame delivered twice by a re-sync racing the live stream.
    if (
      isDuplicateAgentEvent(
        target.worktreeId,
        OPENCODE_CLI_TOOL_ID,
        instanceId,
        event.event,
        event.conversationId,
        event.receivedAt,
        event.detail
      )
    ) {
      logger.info('opencode-event-duplicate-dropped', {
        worktreeId: target.worktreeId,
        instanceId,
        event: event.event,
        detail: event.detail,
      });
      return;
    }

    recordAgentEvent(target.worktreeId, OPENCODE_CLI_TOOL_ID, instanceId, {
      event: event.event,
      at: event.receivedAt,
      detail: event.detail?.slice(0, MAX_EVENT_DETAIL_LENGTH) ?? null,
      sessionId: event.conversationId,
      message: describeNotification(event)?.slice(0, MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH) ?? null,
    });

    if (event.event === 'notification' && event.detail === OPENCODE_PERMISSION_DETAIL) {
      await adjudicatePermission(target, event, instanceId);
      return;
    }

    if (event.event === 'notification' && event.detail === OPENCODE_QUESTION_DETAIL) {
      recordQuestion(target, event, instanceId);
      return;
    }

    if (event.event === 'stop') {
      await applyStop(target, instanceId);
      return;
    }

    logger.info('opencode-event-received', {
      worktreeId: target.worktreeId,
      instanceId,
      event: event.event,
      detail: event.detail,
    });
  } catch (error) {
    logger.error('opencode-event-ingest-failed', {
      worktreeId: target.worktreeId,
      instanceId,
      event: event.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
