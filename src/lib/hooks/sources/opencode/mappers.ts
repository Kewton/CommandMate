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

import { PERMISSION_REPLIED_DETAIL } from '@/lib/hooks/agent-event-types';
import {
  boundDetail,
  isPlainObject,
  readEventIdentity,
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

/**
 * Detail for `permission.replied` (Issue #1898).
 *
 * The shared spelling, not a new one: `agent-event-state` releases the
 * prompt-waiting record on exactly this word, and the same word is used by the
 * adjudicator when *this server* is the one that answered. opencode is the only
 * source that publishes the frame today, which is why its
 * `permissionReplyReleasesPrompt` capability is the only one set to true — but
 * the vocabulary is not opencode's, so it is imported rather than declared.
 */
export const OPENCODE_PERMISSION_REPLIED_DETAIL = PERMISSION_REPLIED_DETAIL;

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

/**
 * The model **variant** this frame reports, or null (Issue #2048).
 *
 * Two spellings, for the same reason {@link frameModel} has two: the value sits
 * in a different place on the two frames that carry it, and both were measured
 * on 1.18.22 in an isolated `HOME`
 * (`docs/design/opencode-server-live-verification.md` §20.4).
 *
 *  - `session.updated` -> `properties.info.model.variant`, because
 *    `Session.model` is a `ModelRef` (`{ id, providerID, variant? }`);
 *  - `message.updated` -> `properties.info.variant`, because `AssistantMessage`
 *    declares it as a flat field of its own.
 *
 * **Absent is the ordinary answer, not an error.** The `variant` key is missing
 * altogether from both frames when the session is on a model's default, and from
 * the assistant message a turn opens with. `agent-event-state` latches this
 * rather than assigning it, which is what makes a frame without one mean
 * "unchanged" instead of "cleared".
 *
 * opencode calls it a variant; CommandMate publishes it as the reasoning
 * *effort*, which is what it is — the catalogue entry for `high` is literally
 * `{ effort: "high" }` (§20.1) — and is the field every other tool's level is
 * already shown in.
 */
export function frameVariant(payload: Record<string, unknown>): string | null {
  const info = frameProperties(payload).info;
  if (!isPlainObject(info)) return null;
  return readNestedString(info, ['model', 'variant']) ?? readNestedString(info, ['variant']);
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

/**
 * `properties.requestID` — the approval a `permission.replied` frame answers
 * (Issue #1898).
 *
 * Spelled differently from the `properties.id` an approval is *asked* under,
 * and the difference is measured rather than assumed: `permission-replied.json`
 * carries `{ sessionID, requestID, reply }` and no `id` at all. Reading `id`
 * here would leave every reply anonymous, and an anonymous reply retires
 * whichever dialog happens to be open.
 */
export function repliedPermissionId(payload: Record<string, unknown>): string | null {
  return readNestedString(frameProperties(payload), ['requestID']);
}

/**
 * The frame's own id, for identity de-duplication (Issue #1899).
 *
 * This is the extraction half of `capabilities.eventIdentity: 'permission-id'`:
 * the capability names the id, this finds it. One function rather than a field
 * on each mapper rule because the id is a property of the *frame*, and the
 * frames that carry one are not the same set as the frames that map to a word.
 *
 * ## Where each id lives, and why the list is not one path
 *
 * | frame | id | note |
 * |---|---|---|
 * | `permission.asked` | `properties.id` | `per_…` |
 * | `permission.replied` | `properties.requestID` | the **same** `per_…`, spelled differently (#1898) |
 * | `question.asked` | `properties.id` | `que_…` |
 * | `message.updated` | `properties.info.id` | `msg_…` |
 * | `message.part.updated` | `properties.part.callID` | `toolu_…` |
 *
 * The first two rows are why the caller keys on `(event, detail, identity)`
 * rather than on the identity alone: an approval and the reply that answers it
 * carry **the same value**, and a key made of the id by itself would read the
 * reply as a repeat of the ask and drop the only positive statement any source
 * makes that a dialog is gone.
 *
 * ## The frames that answer null
 *
 * `session.idle` is `{ "sessionID": "ses_…" }` and nothing else — measured, and
 * the reason `./turn-gate` exists. `session.created` / `session.deleted` /
 * `session.error` publish no per-frame id either. Null is the honest answer for
 * all of them, and `classifyAgentEventDelivery` is where "no id" is turned into
 * a policy per event word.
 *
 * The envelope's own `id` (`evt_…`) is deliberately **not** used. The captured
 * fixtures redact it to a single placeholder, so nothing in this repository
 * establishes that it is unique per frame rather than per subscription or per
 * aggregate — and a key built on an unverified uniqueness claim silently drops
 * real events, which is the bug this Issue is fixing.
 */
export function opencodeEventIdentity(payload: Record<string, unknown>): string | null {
  const properties = frameProperties(payload);

  switch (readNestedString(payload, ['type'])) {
    case 'permission.asked':
    case 'question.asked':
      return readEventIdentity(readNestedString(properties, ['id']));
    case 'permission.replied':
      return readEventIdentity(repliedPermissionId(payload));
    case 'message.updated':
      return readEventIdentity(readNestedString(properties, ['info', 'id']));
    case 'message.part.updated':
      return readEventIdentity(partCallId(payload));
    default:
      return null;
  }
}

/** Statuses that mean the tool call is over, either way (#1758 §5.2.3). */
const FINISHED_PART_STATUSES: readonly string[] = ['completed', 'error'];

/**
 * The ordered rules, first match wins.
 *
 * `session.status`, `server.connected`, `server.heartbeat` and
 * `question.replied` are deliberately absent. They are real frames that
 * arrive on every healthy connection and they map to none of the seven words,
 * so they fall through, return null and are counted (C8) — which is what the
 * interface asks for and what stops a ten-second keepalive from throwing.
 *
 * `permission.replied` was in that list until Issue #1898 and is now mapped,
 * for a reason that took a live measurement to see: it is the *only* positive
 * statement any of the six tools makes that an approval dialog is gone. Left
 * unmapped, a dialog answered in the terminal went on reading `waiting` until
 * the tool call it gated finished — eight seconds on `sleep 8; pwd`, and
 * indefinitely for an approval whose tool emits nothing. It maps to
 * `notification`, which is the bundle word, with a detail that decides no
 * status of its own (`agentEventToSessionStatus` answers null for it, so the
 * scraper keeps the frame): all it does is retire the record.
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
  whenNamed('permission.replied', 'notification', OPENCODE_PERMISSION_REPLIED_DETAIL),
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
