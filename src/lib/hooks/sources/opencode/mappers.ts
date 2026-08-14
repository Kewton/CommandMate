/**
 * opencode's SSE frames, mapped onto the seven words (Issue #1763, constraint
 * C4).
 *
 * Every rule below is lifted from a frame that was actually captured from
 * `opencode` 1.18.3 — the files in `tests/fixtures/hooks/opencode/` — and not
 * from the server's OpenAPI document. The document is wrong in at least one
 * place that matters (`server.heartbeat` is not in its `Event` union yet
 * arrives every ten seconds, #1758 D5), so the fixtures are the specification
 * and the tests read them directly.
 *
 * Three of the rules cannot be written as a name table, which is the whole
 * reason {@link EventMapper} is a function (#1758 §5.2.3):
 *
 *  - `message.part.updated` is `pre_tool_use` or `post_tool_use` depending on
 *    `part.state.status` — one event name, two words.
 *  - `user_prompt_submit` has no event of its own; it is `message.updated` with
 *    `info.role === "user"`.
 *  - `notification` is three unrelated events told apart only by `detail`.
 *
 * ## The envelope
 *
 * ```json
 * { "id": "evt_…", "type": "session.idle", "properties": { "sessionID": "ses_…" } }
 * ```
 *
 * The event's name is in `type` and everything else is nested under
 * `properties`, so `conversationIdFields` — which reads flat keys — cannot
 * reach `sessionID`. {@link withConversationId} fills it in from the nested
 * path instead, which is the C5 escape hatch the interface documents.
 *
 * @module lib/hooks/sources/opencode/mappers
 */

import {
  boundDetail,
  isPlainObject,
  readNestedString,
  whenNamed,
  type EventMapper,
} from '../event-mapper';

/**
 * Detail for `permission.asked`.
 *
 * Deliberately Claude's spelling. `wait --on-prompt` has to mean the same thing
 * on both tools, and `agent-event-state` opens its prompt-waiting record on
 * exactly this string — renaming it for opencode would leave the state machine
 * silently unable to see an opencode approval dialog (#1758 §9.3).
 */
export const OPENCODE_PERMISSION_DETAIL = 'permission_prompt';

/**
 * Detail for `question.asked`.
 *
 * A new value rather than a reuse: opencode's `question` tool is answered with
 * structured choices over its own endpoint, and nothing above this layer should
 * be able to confuse it with an approval it could allow. There is no
 * `idle_prompt` equivalent on opencode at all — no event reports "the agent is
 * sitting at the composer" — so that spelling never appears here.
 */
export const OPENCODE_QUESTION_DETAIL = 'question_prompt';

/** Detail for `session.error`. */
export const OPENCODE_ERROR_DETAIL = 'error';

/** The `properties` object of a frame, or an empty object. */
export function frameProperties(payload: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(payload.properties) ? payload.properties : {};
}

/** `properties.sessionID`, the id every frame that belongs to a turn carries. */
export function frameSessionId(payload: Record<string, unknown>): string | null {
  return readNestedString(frameProperties(payload), ['sessionID']);
}

/**
 * `properties.info.model` — the model this frame's session/message ran on (#1783).
 *
 * Two spellings, both live, and the Issue text only named the first: a
 * `message.updated` frame carries `{ providerID, modelID }` while
 * `session.created` / `session.deleted` carry `{ id, providerID }`. Checked
 * against the captured fixtures, which is the only specification that has been
 * right about this server so far (its own `/doc` omits `server.heartbeat`).
 * Reading `modelID` alone would have left `session_start` — the one event a
 * fresh subscription is guaranteed to see — with no model at all.
 *
 * `providerID` is deliberately not folded in. `github-copilot/claude-sonnet-4.6`
 * would be a *composed* string, and every other tool reports the bare model, so
 * composing here would make opencode the odd one out in the UI for no gain.
 */
export function frameModel(payload: Record<string, unknown>): string | null {
  const info = frameProperties(payload).info;
  if (!isPlainObject(info)) return null;
  return readNestedString(info, ['model', 'modelID']) ?? readNestedString(info, ['model', 'id']);
}

/** `properties.part.state.status` — `pending` / `running` / `completed` / `error`. */
function partStatus(payload: Record<string, unknown>): string | null {
  return readNestedString(frameProperties(payload), ['part', 'state', 'status']);
}

/** Whether this `message.part.updated` describes a tool call rather than text. */
function partIsToolCall(payload: Record<string, unknown>): boolean {
  return readNestedString(frameProperties(payload), ['part', 'type']) === 'tool';
}

/** `properties.part.tool` — `bash`, `read`, … (lower case, unlike Claude's). */
export function partToolName(payload: Record<string, unknown>): string | null {
  return readNestedString(frameProperties(payload), ['part', 'tool']);
}

/** `properties.part.callID` — the correlation key for one tool call. */
export function partCallId(payload: Record<string, unknown>): string | null {
  return readNestedString(frameProperties(payload), ['part', 'callID']);
}

/** Statuses that mean the tool call is over, either way (#1758 §5.2.3). */
const FINISHED_PART_STATUSES: readonly string[] = ['completed', 'error'];

/**
 * The ordered rules, first match wins.
 *
 * `session.status`, `server.connected`, `server.heartbeat`, `permission.replied`
 * and `question.replied` are deliberately absent. They are real frames that
 * arrive on every healthy connection and they map to none of the seven words,
 * so they fall through, return null and are counted (C8) — which is what the
 * interface asks for and what stops a ten-second keepalive from throwing.
 *
 * `session.status(idle)` in particular must NOT be mapped: it is emitted in the
 * same millisecond as `session.idle` and mapping both would report every turn's
 * completion twice (#1758 §5.3.2 rule 4).
 */
const OPENCODE_BASE_MAPPERS: readonly EventMapper[] = [
  // 1:1. `session.deleted` only fires for an explicit `DELETE /session/:id` —
  // the TUI's `/exit` emits nothing at all — so it is expressible but is not
  // the signal that the agent is gone. That stays tmux's job (#1758 §5.6.4).
  whenNamed('session.idle', 'stop'),
  whenNamed('session.created', 'session_start'),
  whenNamed('session.deleted', 'session_end'),

  // Composite: no dedicated event, so the role decides.
  (type, payload) =>
    type === 'message.updated' &&
    readNestedString(frameProperties(payload), ['info', 'role']) === 'user'
      ? { event: 'user_prompt_submit' }
      : null,

  // Partial match: one event name, two words, chosen by a nested status.
  // `pending` — the frame just before `running` — maps to nothing on purpose;
  // mapping it as well would report every tool call twice.
  (type, payload) =>
    type === 'message.part.updated' && partIsToolCall(payload) && partStatus(payload) === 'running'
      ? {
          event: 'pre_tool_use',
          detail: boundDetail(partToolName(payload)),
          toolCallId: partCallId(payload),
        }
      : null,
  (type, payload) =>
    type === 'message.part.updated' &&
    partIsToolCall(payload) &&
    FINISHED_PART_STATUSES.includes(partStatus(payload) ?? '')
      ? {
          event: 'post_tool_use',
          detail: boundDetail(partToolName(payload)),
          toolCallId: partCallId(payload),
        }
      : null,

  // Bundle: three unrelated events collapse into `notification`.
  whenNamed('permission.asked', 'notification', OPENCODE_PERMISSION_DETAIL),
  whenNamed('question.asked', 'notification', OPENCODE_QUESTION_DETAIL),
  whenNamed('session.error', 'notification', OPENCODE_ERROR_DETAIL),
];

/**
 * Fill `conversationId` from the nested envelope.
 *
 * @param mapper - A rule that may or may not have set the field itself
 * @returns The same rule, with `properties.sessionID` as the fallback
 */
export function withConversationId(mapper: EventMapper): EventMapper {
  return (type, payload) => {
    const mapped = mapper(type, payload);
    if (!mapped) return null;
    return { ...mapped, conversationId: mapped.conversationId ?? frameSessionId(payload) };
  };
}

/** The rules an opencode source carries. */
export const OPENCODE_MAPPERS: readonly EventMapper[] =
  OPENCODE_BASE_MAPPERS.map(withConversationId);
