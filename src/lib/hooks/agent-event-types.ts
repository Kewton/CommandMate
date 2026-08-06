/**
 * The vocabulary shared by the hook receiver, the injected settings generator
 * and the in-memory session state (Issue #1722).
 *
 * Split out of `agent-event-service` so the pieces that only need the words —
 * the settings generator, `lib/session/agent-event-state` — can have them
 * without pulling in SQLite, the task state machine and the verification
 * runner. `agent-event-service` re-exports everything here, so existing
 * importers are unaffected.
 *
 * The mapping below is not derived from Claude Code's documentation. It is
 * derived from the payloads in `tests/fixtures/hooks/claude/`, captured from a
 * live v2.1.223 session in Issue #1721 and written up in
 * `docs/design/agent-hooks-live-verification.md`. Where the two disagree, the
 * fixtures win.
 *
 * @module lib/hooks/agent-event-types
 */

/**
 * Event kinds accepted by `POST /api/hooks/agent-event`.
 *
 * `stop` is the only one that moves anything. The rest are accepted, recorded
 * and exposed for observation; wiring them into `sessionStatus` / `wait` /
 * Auto-Yes is Issue #1723's job, deliberately kept separate so a change to the
 * completion verdict is never a side effect of adding a receiver (#1549).
 *
 * `pre_tool_use` / `post_tool_use` (Issue #1726) are the two events received for
 * a *specific* tool rather than for the session: the injected hooks carry
 * `matcher: "AskUserQuestion"`, so they bracket the agent asking the human a
 * question — the first carries the question and its options in `tool_input`, the
 * second says the call is over. Both are observations; this receiver never
 * answers either with a decision.
 */
export const AGENT_EVENT_TYPES = [
  'stop',
  'notification',
  'session_start',
  'user_prompt_submit',
  'session_end',
  'pre_tool_use',
  'post_tool_use',
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export function isAgentEventType(value: unknown): value is AgentEventType {
  return typeof value === 'string' && (AGENT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Claude Code's own `hook_event_name` values, mapped onto the vocabulary above.
 *
 * An injected `type: "http"` hook posts Claude's payload verbatim — there is no
 * way to shape the body — so the receiver has to read Claude's spelling. Only
 * the events CommandMate injects are listed, and an unmapped name is refused
 * rather than silently filed under something else.
 *
 * `PermissionRequest` is absent because it has its own receiver: its response
 * body is a decision the agent obeys, which is the opposite contract to this
 * fire-and-forget route (#1724).
 *
 * `PostToolUse` **is** mapped, on the strength of a measurement taken for Issue
 * #1726 rather than of the #1721 spike, which recorded it as unobserved. Driving
 * a live v2.1.223 session on 2026-08-06 with a `PostToolUse` hook registered:
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
 * working after the answer. Both are wired up; see `agent-event-state`.
 */
export const CLAUDE_HOOK_EVENT_NAMES: Readonly<Record<string, AgentEventType>> = {
  Stop: 'stop',
  SubagentStop: 'stop',
  Notification: 'notification',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  // Issue #1726. Injected with matcher `AskUserQuestion`, so in practice these
  // only ever arrive for that tool — but the receiver re-reads `tool_name`
  // rather than trusting the matcher, because a user's own settings.json is
  // concatenated with the injected one and may register a wider matcher.
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
};

/** @returns The event this `hook_event_name` maps to, or null when unmapped. */
export function mapClaudeHookEventName(value: unknown): AgentEventType | null {
  if (typeof value !== 'string') return null;
  return CLAUDE_HOOK_EVENT_NAMES[value] ?? null;
}

/** Bound on the stored `detail`; every observed value is a short enum-ish word. */
export const MAX_EVENT_DETAIL_LENGTH = 128;

/**
 * The event's subtype, as a single short string, or null when it has none.
 *
 * Each event spells this differently and none of them share a field:
 *
 * - `Notification` → `notification_type` (`permission_prompt` / `idle_prompt`).
 *   This is also what a `Notification` matcher is tested against — **not**
 *   `message`, which is English prose for a human (D3).
 * - `SessionEnd` → `reason` (`clear` / `prompt_input_exit` / …)
 * - `SessionStart` → `source` (`startup` / `clear` / …)
 * - `PreToolUse` / `PostToolUse` → `tool_name` (`AskUserQuestion`), Issue #1726
 *
 * `Stop` and `UserPromptSubmit` have no subtype, so they answer null.
 */
export function extractClaudeEventDetail(
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

  const value = payload[field];
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, MAX_EVENT_DETAIL_LENGTH);
}
