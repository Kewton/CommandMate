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
import { adjudicatePendingPermission } from '@/lib/hooks/permission-adjudication';
import {
  classifyAgentEventDelivery,
  recordAgentEvent,
  recordAskUserQuestion,
  reportPermissionRequestPending,
  type AgentEventRecord,
} from '@/lib/session/agent-event-state';
import { MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH } from '@/lib/session/structured-prompt';
import { isPlainObject, readNestedString, readStringField } from '../event-mapper';
import { getAgentEventSource } from '../registry';
import type { AgentInstanceRef, NormalizedAgentEvent } from '../types';
import {
  OPENCODE_ERROR_DETAIL,
  OPENCODE_PERMISSION_DETAIL,
  OPENCODE_PERMISSION_REPLIED_DETAIL,
  OPENCODE_QUESTION_DETAIL,
  repliedPermissionId,
} from './mappers';
import { readOpencodePermissionSubject, toOpencodePendingPermission } from './payloads';
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
 * Adjudicate one approval, answer it over REST, and say whether anybody is
 * still blocked (Auto-Yes v2, reordered by Issue #1898).
 *
 * The adjudication itself is `resolvePermissionRequest`, unchanged and shared
 * with every hook-based tool; `adjudicatePendingPermission` is the wrapper that
 * delivers the verdict and reads the source's capabilities to decide what the
 * delivery means. What is opencode-specific is what silence costs: on Claude an
 * abstention costs a dialog, here it costs the session, because the agent waits
 * with no timeout at all (#1758 §5.5.3).
 *
 * **This runs before the event is recorded, and that ordering is the fix.** See
 * {@link ingestOpencodeEvent}.
 *
 * @returns Whether the dialog can be treated as closed — a verdict was
 *   delivered and this source declares that a reply releases the prompt. False
 *   for every abstain, and false for an allow whose POST was refused.
 */
async function adjudicatePermission(
  target: AgentInstanceRef,
  event: NormalizedAgentEvent,
  instanceId: string
): Promise<boolean> {
  const source = getAgentEventSource(OPENCODE_CLI_TOOL_ID);
  const pending = toOpencodePendingPermission(event.raw, event.receivedAt);
  if (!pending) {
    logger.info('opencode-permission-unparsed', {
      worktreeId: target.worktreeId,
      instanceId,
    });
    return false;
  }

  const outcome = await adjudicatePendingPermission(
    source,
    target,
    pending,
    source.parsePermissionRequest(event.raw)
  );

  logger.info('opencode-permission-decided', {
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
 * Whether a `permission.replied` frame retires the prompt-waiting record
 * (Issue #1898).
 *
 * The capability read, not a tool check: `permissionReplyReleasesPrompt` is the
 * declared value that says "a reply on this source's own stream is a positive
 * statement that the dialog is gone" (#1924, §4 D3). Flipping opencode's
 * declaration to false puts this frame back to deciding nothing, which is the
 * pre-#1898 behaviour and is exactly what the mutation case in
 * `tests/unit/hooks/sources/opencode-permission-1898.test.ts` asserts.
 */
function replyReleasesPrompt(target: AgentInstanceRef, instanceId: string): boolean {
  const source = getAgentEventSource(OPENCODE_CLI_TOOL_ID);
  if (source.capabilities.permissionReplyReleasesPrompt) return true;
  logger.info('opencode-permission-reply-not-releasing', {
    worktreeId: target.worktreeId,
    instanceId,
    reason: 'capability-permissionReplyReleasesPrompt-false',
  });
  return false;
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
 * ## Adjudicate, then record (Issue #1898)
 *
 * `recordAgentEvent` is what opens the prompt-waiting record — it keys off
 * `notification(permission_prompt)` — so recording an approval before deciding
 * it publishes "a human is blocked" for an approval Auto-Yes is about to
 * answer in the same tick. Measured: `capture --json` read
 * `waiting / hook_permission_prompt` from the instant the reply was delivered
 * until `sleep 8` finished, `wait --on-prompt agent` exited 10 the whole time,
 * and `send` was refused by the guard. The verdict now goes out first and the
 * record carries {@link AgentEventRecord.promptSettled}, so the state the human
 * would have had to wait out is never entered.
 *
 * The order must not be put back. Recording first and clearing afterwards looks
 * equivalent — nothing reads the map in between — but it re-creates a window
 * that only stays closed by accident, and the release would then have to be
 * repeated at every future caller instead of being a property of the record.
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
    // Inside the `try` on purpose: this module's contract is that nothing here
    // throws, and a registry lookup is still a lookup.
    const source = getAgentEventSource(OPENCODE_CLI_TOOL_ID);

    // Issue #1899. The guard the hook receiver applies is the *time window*,
    // and on this stream it was dropping real events: two approvals a second
    // apart share `(event, detail, sessionID)`, so the second one was neither
    // adjudicated nor recorded, and opencode blocks on an unanswered approval
    // for as long as it takes (10m19s, measured in #1758 §5.5.3).
    //
    // The capability decides which rule applies — no tool name is read here.
    // `eventIdentity: 'permission-id'` puts frames that carry an id on the id,
    // and leaves `session.idle` (which carries none, and which `./turn-gate`
    // has already counted) unsuppressed. Declaring `null` instead puts every
    // frame back on the window.
    const delivery = classifyAgentEventDelivery({
      worktreeId: target.worktreeId,
      cliToolId: OPENCODE_CLI_TOOL_ID,
      instanceId,
      event: event.event,
      detail: event.detail,
      sessionId: event.conversationId,
      at: event.receivedAt,
      identity: source.eventIdentityOf(event.raw),
      identityKind: source.capabilities.eventIdentity,
    });
    if (delivery.duplicate) {
      logger.info('opencode-event-duplicate-dropped', {
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
      message: describeNotification(event)?.slice(0, MAX_STRUCTURED_PROMPT_MESSAGE_LENGTH) ?? null,
      // Issue #1783. The second of the two receiving paths — this one is
      // in-process rather than an HTTP route, and forgetting it would leave
      // opencode as the one tool whose model is extracted and then dropped.
      // Already bounded by the normaliser; null on the frames that carry no
      // `properties.info.model` (every `session.idle`, every tool part).
      model: event.model,
    };

    // Issue #1903: the same declared value the hook receiver passes, from the
    // same place. opencode declares `false` — `session.created` really does open
    // a session here — so this changes nothing for this source today; it is
    // wired because the two receiving paths must not disagree about which
    // capabilities the state machine is being told about, which is the mistake
    // #1783 records having made with `model`.
    const options = {
      sessionStartMayArriveLate: source.capabilities.sessionStartMayArriveLate,
    };

    if (event.event === 'notification' && event.detail === OPENCODE_PERMISSION_DETAIL) {
      // Issue #1898: the verdict leaves BEFORE the record is written. See the
      // docblock above for what recording first cost.
      record.decisionId = readStringField(
        isPlainObject(event.raw.properties) ? event.raw.properties : {},
        'id'
      );
      // Issue #2031: what the dialog is FOR, carried on the record because the
      // frame itself cannot answer it. The tool name lives in the
      // `message.part.updated` correlation this module's `payloads` holds, and
      // `patterns` is the rule an `Allow always` would save — the one verdict
      // whose effect outlives the dialog, and therefore the one the browser
      // must be able to show the size of before it is pressed.
      const subject = readOpencodePermissionSubject(event.raw, event.receivedAt);
      record.toolName = subject?.toolName ?? null;
      record.decisionPatterns = subject?.patterns ?? null;
      record.promptSettled = await adjudicatePermission(target, event, instanceId);
      recordAgentEvent(target.worktreeId, OPENCODE_CLI_TOOL_ID, instanceId, record, options);
      return;
    }

    if (event.event === 'notification' && event.detail === OPENCODE_PERMISSION_REPLIED_DETAIL) {
      // Issue #1898: somebody answered — this server, another client, or a
      // human at the terminal. The last of those is the one nothing else can
      // see, and it is why this frame is mapped at all.
      record.decisionId = repliedPermissionId(event.raw);
      record.promptSettled = replyReleasesPrompt(target, instanceId);
      recordAgentEvent(target.worktreeId, OPENCODE_CLI_TOOL_ID, instanceId, record, options);
      logger.info('opencode-permission-reply-observed', {
        worktreeId: target.worktreeId,
        instanceId,
        decisionId: record.decisionId,
        released: record.promptSettled,
      });
      return;
    }

    recordAgentEvent(target.worktreeId, OPENCODE_CLI_TOOL_ID, instanceId, record, options);

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
