/**
 * The hook spellings and payload field names that several agent CLIs happen to
 * share (Issue #1759, S1/S2 lifted out of `agent-event-types`).
 *
 * `agent-event-types` used to carry `CLAUDE_HOOK_EVENT_NAMES` and
 * `extractClaudeEventDetail` next to the seven-word vocabulary. That put one
 * tool's spelling inside the module every tool-agnostic consumer imports, and
 * the predictable next move — a Phase 4-2 implementer adding `BeforeTool` to
 * the same table — is exactly the copy-paste Epic #1720 exists to stop. The
 * words stayed in `agent-event-types`; the spellings moved here, where a source
 * *chooses* them.
 *
 * The table below is not "Claude's table". #1757 §8.1 measured all four new
 * tools, and Claude, codex and copilot spell these events identically; gemini
 * renames half of them (`BeforeTool` / `AfterTool` / `BeforeAgent` /
 * `AfterAgent`) and antigravity ships no event-name field at all. So this is
 * the CamelCase dialect three tools share, and a source that speaks a different
 * one brings its own mappers.
 *
 * @module lib/hooks/sources/hook-event-vocabulary
 */

import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import { boundDetail, readStringField } from './event-mapper';

/**
 * `hook_event_name` values, in the CamelCase dialect Claude / codex / copilot
 * share, mapped onto the seven words.
 *
 * Only the events CommandMate registers appear. An unmapped name is refused
 * rather than filed under something adjacent — the whole value of a structured
 * event is that it says precisely what happened.
 *
 * `PermissionRequest` is deliberately absent: its response body is a decision
 * the agent obeys, which is the opposite contract to the fire-and-forget event
 * route (#1724). It travels through {@link AgentEventSource.encodeVerdict}.
 *
 * `PostToolUse` is here on the strength of a measurement taken for #1726 rather
 * than of the #1721 spike, which recorded it as unobserved. Driving a live
 * Claude v2.1.223 session on 2026-08-06 with a `PostToolUse` hook registered:
 *
 * ```
 * 15:36:04.112  PreToolUse   AskUserQuestion   (picker drawn)
 * 15:36:10.127  Notification permission_prompt (picker still up)
 * 15:36:28.643  PostToolUse  AskUserQuestion   (the human answered)
 * 15:36:29.992  Stop
 * ```
 *
 * It fires, and it is the precise signal — "this tool call is over" — where
 * `Stop` is "the turn is over" and can be minutes later if the agent keeps
 * working after the answer.
 */
export const CAMEL_CASE_HOOK_EVENT_NAMES: Readonly<Record<string, AgentEventType>> = {
  Stop: 'stop',
  SubagentStop: 'stop',
  Notification: 'notification',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  // Issue #1726. Injected with matcher `AskUserQuestion`, so in practice these
  // only ever arrive for that tool — but a receiver re-reads `tool_name` rather
  // than trusting the matcher, because a user's own settings.json is
  // concatenated with the injected one and may register a wider matcher.
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
};

/**
 * Payload keys that carry the agent's own session id, in preference order
 * (#1757 R4).
 *
 * `session_id` covers Claude, codex, copilot and gemini; `conversationId` is
 * antigravity's protojson spelling of the same thing. Never an identity key —
 * `/clear` mints a new one while the instance is unchanged (#1721).
 */
export const SESSION_ID_FIELDS = ['session_id', 'conversationId'] as const;

/**
 * Payload keys that correlate one tool call (#1757 R5).
 *
 * `tool_use_id` is Claude's and codex's; it is absent from `PermissionRequest`
 * on both (D2), so nothing may require it.
 */
export const TOOL_CALL_ID_FIELDS = ['tool_use_id'] as const;

/**
 * The event's subtype for a snake_case payload, or null when it has none.
 *
 * Each event spells this differently and none of them share a field:
 *
 * - `Notification` → `notification_type` (`permission_prompt` / `idle_prompt`).
 *   This is also what a `Notification` matcher is tested against — **not**
 *   `message`, which is English prose for a human (#1721 D3).
 * - `SessionEnd` → `reason` (`clear` / `prompt_input_exit` / …)
 * - `SessionStart` → `source` (`startup` / `clear` / …)
 * - `PreToolUse` / `PostToolUse` → `tool_name` (`AskUserQuestion`), Issue #1726
 *
 * `stop` and `user_prompt_submit` have no subtype, so they answer null.
 */
export function extractSnakeCaseEventDetail(
  event: AgentEventType,
  payload: Record<string, unknown>
): string | null {
  const field =
    event === 'notification'
      ? 'notification_type'
      : event === 'session_end'
        ? 'reason'
        : event === 'session_start'
          ? 'source'
          : event === 'pre_tool_use' || event === 'post_tool_use'
            ? 'tool_name'
            : null;
  if (field === null) return null;

  return boundDetail(readStringField(payload, field));
}
