/**
 * OpenCode V2's SSE vocabulary, mapped onto CommandMate's agent events
 * (Issue #2934, decision D5).
 *
 * The envelope, measured on 2.0.18 (#2370 Phase 0):
 * `{id, created?, type, location?, data, durable?}`. `location.directory` is
 * present on some events and absent on others (`session.execution.succeeded`
 * carries `durable` instead), so nothing here reads it: one instance owns one
 * server, and every frame on that server's stream is that instance's.
 *
 * Phase 1 mapped the turn boundaries and the two kinds of "the agent is waiting
 * for a human":
 *
 * | OpenCode V2 event                               | agent event                          |
 * |-------------------------------------------------|--------------------------------------|
 * | `session.execution.started`                     | `user_prompt_submit` → running       |
 * | `session.execution.succeeded` / `interrupted`   | `stop` → ready                       |
 * | `session.execution.failed`                      | `stop` (detail `error`) → ready      |
 * | `permission.asked`                              | `notification(permission_prompt)`    |
 * | `permission.replied`                            | `notification(permission_replied)`   |
 * | `form.created`                                  | `notification(question_prompt)`      |
 * | `form.replied` / `form.cancelled`               | `notification(permission_replied)`   |
 *
 * Every other type is dropped before it reaches the normalizer
 * ({@link isHandledOpencodeV2EventType}), so the unknown-event tally does not
 * fill up with `session.reasoning.delta` and friends.
 *
 * `form.replied` / `form.cancelled` reuse `permission_replied` on purpose: that
 * detail is the agent-event state's one "this decision is settled, retire it by
 * id" signal, and a question is a decision exactly as an approval is.
 *
 * @module lib/hooks/sources/opencode-v2/mappers
 */

import { PERMISSION_REPLIED_DETAIL } from '@/lib/hooks/agent-event-types';
import {
  isPlainObject,
  readEventIdentity,
  readNestedString,
  whenNamed,
  type EventMapper,
} from '../event-mapper';

/** `notification` detail of an approval request. */
export const OPENCODE_V2_PERMISSION_DETAIL = 'permission_prompt';

/** `notification` detail of a question (a `form`). */
export const OPENCODE_V2_QUESTION_DETAIL = 'question_prompt';

/** `notification` detail that retires a decision — approval or question. */
export const OPENCODE_V2_DECISION_SETTLED_DETAIL = PERMISSION_REPLIED_DETAIL;

/** `stop` detail of a turn that ended in `session.execution.failed`. */
export const OPENCODE_V2_FAILED_DETAIL = 'error';

/** The event types Phase 1 reads. Anything else is ignored. */
export const OPENCODE_V2_HANDLED_EVENT_TYPES: readonly string[] = [
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'permission.asked',
  'permission.replied',
  'form.created',
  'form.replied',
  'form.cancelled',
];

/** Whether a frame's `type` is one {@link OPENCODE_V2_MAPPERS} maps. */
export function isHandledOpencodeV2EventType(type: string | null): boolean {
  return type !== null && OPENCODE_V2_HANDLED_EVENT_TYPES.includes(type);
}

/** The frame's `type`, or null. */
export function frameType(payload: Record<string, unknown>): string | null {
  return readNestedString(payload, ['type']);
}

/** The frame's `data` object (empty when absent). */
export function frameData(payload: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(payload.data) ? payload.data : {};
}

/**
 * The OpenCode session a frame belongs to.
 *
 * `data.sessionID` where the event carries it; otherwise the durable
 * aggregate id (`durable.aggregateID`), which for the `session.*` events is the
 * session. Used as the turn's conversation id, never for routing.
 */
export function frameSessionId(payload: Record<string, unknown>): string | null {
  return (
    readNestedString(frameData(payload), ['sessionID']) ??
    // Issue #2945: `form.created` nests the form — `data.form.sessionID`
    // (measured on 2.0.18).
    readNestedString(frameData(payload), ['form', 'sessionID']) ??
    readNestedString(payload, ['durable', 'aggregateID'])
  );
}

/**
 * The id of the decision a frame opens or settles.
 *
 * `permission.asked` carries it as `data.id` (`per_…`), `form.created` as
 * `data.form.id` (`frm_…`, the form is nested — measured, Issue #2945);
 * `permission.replied` names it `data.requestID`; the form replies carry
 * `data.id` and are read under the other spellings too.
 */
export function frameDecisionId(payload: Record<string, unknown>): string | null {
  const data = frameData(payload);
  switch (frameType(payload)) {
    case 'permission.asked':
      return readNestedString(data, ['id']);
    case 'form.created':
      // Measured on 2.0.18 (Issue #2945): the form is nested,
      // `data.form.id`. `data.id` is read as well, for a frame that is not.
      return readNestedString(data, ['form', 'id']) ?? readNestedString(data, ['id']);
    case 'permission.replied':
      return readNestedString(data, ['requestID']) ?? readNestedString(data, ['id']);
    case 'form.replied':
    case 'form.cancelled':
      return (
        readNestedString(data, ['formID']) ??
        readNestedString(data, ['id']) ??
        readNestedString(data, ['requestID'])
      );
    default:
      return null;
  }
}

/**
 * The frame's own identity, for de-duplication (Issue #2945,
 * `eventIdentity: 'permission-id'`).
 *
 * The decision id ({@link frameDecisionId}) — the `per_…` / `frm_…` the reply
 * URL takes. An approval and the reply that settles it carry the SAME id, which
 * is why `classifyAgentEventDelivery` keys on `(event, detail, identity)`
 * rather than on the id alone. Every other frame (the `session.execution.*`
 * boundaries) answers null and keeps the time window, as v1's `session.idle`
 * does. The envelope's `evt_…` is not used, for v1's reason: nothing measured
 * says it is unique per frame.
 */
export function opencodeV2EventIdentity(payload: Record<string, unknown>): string | null {
  return readEventIdentity(frameDecisionId(payload));
}

/** The action an approval is for (`edit`, `shell`, …), or null. */
export function framePermissionAction(payload: Record<string, unknown>): string | null {
  return readNestedString(frameData(payload), ['action']);
}

/** A human-readable reason a failed turn gives, or null. */
export function frameFailureMessage(payload: Record<string, unknown>): string | null {
  const data = frameData(payload);
  return (
    readNestedString(data, ['error', 'message']) ??
    readNestedString(data, ['error', 'data', 'message']) ??
    readNestedString(data, ['error', 'name']) ??
    readNestedString(data, ['message'])
  );
}

const OPENCODE_V2_BASE_MAPPERS: readonly EventMapper[] = [
  whenNamed('session.execution.started', 'user_prompt_submit'),
  whenNamed('session.execution.succeeded', 'stop'),
  whenNamed('session.execution.interrupted', 'stop'),
  whenNamed('session.execution.failed', 'stop', OPENCODE_V2_FAILED_DETAIL),
  whenNamed('permission.asked', 'notification', OPENCODE_V2_PERMISSION_DETAIL),
  whenNamed('permission.replied', 'notification', OPENCODE_V2_DECISION_SETTLED_DETAIL),
  whenNamed('form.created', 'notification', OPENCODE_V2_QUESTION_DETAIL),
  whenNamed('form.replied', 'notification', OPENCODE_V2_DECISION_SETTLED_DETAIL),
  whenNamed('form.cancelled', 'notification', OPENCODE_V2_DECISION_SETTLED_DETAIL),
];

/** The mappers, each stamping the frame's session as the conversation id. */
export const OPENCODE_V2_MAPPERS: readonly EventMapper[] = OPENCODE_V2_BASE_MAPPERS.map(
  (mapper): EventMapper =>
    (type, payload) => {
      const mapped = mapper(type, payload);
      if (!mapped) return null;
      return { ...mapped, conversationId: mapped.conversationId ?? frameSessionId(payload) };
    }
);
