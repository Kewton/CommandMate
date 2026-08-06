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
 */
export const AGENT_EVENT_TYPES = [
  'stop',
  'notification',
  'session_start',
  'user_prompt_submit',
  'session_end',
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
 * the events Issue #1722 injects are listed: `PreToolUse` and
 * `PermissionRequest` carry a decision and belong to Auto-Yes v2 (#1724), and
 * an unmapped name is refused rather than silently filed under something else.
 */
export const CLAUDE_HOOK_EVENT_NAMES: Readonly<Record<string, AgentEventType>> = {
  Stop: 'stop',
  SubagentStop: 'stop',
  Notification: 'notification',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
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
          : null;
  if (field === null) return null;

  const value = payload[field];
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, MAX_EVENT_DETAIL_LENGTH);
}
