/**
 * The structured event record `agent-event-state` keeps per agent instance.
 *
 * Split out of `agent-event-state` (Issue #3375) so the modules that read the
 * record can share the type without importing that module.
 *
 * @module lib/session/agent-event-record
 */

import type { AgentEventType } from '@/lib/hooks/agent-event-types';

/** The most recent structured event reported for one agent instance. */
export interface AgentEventRecord {
  /** Event kind, in this codebase's vocabulary rather than the CLI's spelling. */
  event: AgentEventType;
  /** Epoch ms the server received it. */
  at: number;
  /**
   * The event's subtype where it has one — `permission_prompt` / `idle_prompt`
   * for `notification`, `clear` for a `/clear`-driven `session_end` — else null.
   */
  detail: string | null;
  /**
   * The agent's own session id, or null.
   *
   * Recorded for correlation with the agent's transcript, never used as an
   * identity: `/clear` ends the session and starts a new one with a *different*
   * `session_id` while the instance, the worktree and the tmux pane all stay put
   * (Issue #1721, §1.1). Instance identity comes from the injected URL.
   */
  sessionId: string | null;
  /**
   * `Notification.message` — the agent's own human-facing line (Issue #1725).
   *
   * Display only, and the type cannot enforce that, so it is said here: the
   * observed values are `"Claude needs your permission to use Bash"` and
   * `"Claude is waiting for your input"`, English prose Claude is free to
   * reword. `notification_type` (stored in {@link detail}) is the machine key
   * (D3). Absent for every event that carries no message.
   */
  message?: string | null;
  /**
   * The model the agent reported running (Issue #1783), or null/absent.
   *
   * Absent for a caller that has nothing to say, null for one that looked and
   * found nothing — the two are treated identically here. What is *not* stored
   * on this record is the answer to "which model is this instance on": the
   * record is replaced on every event and most events carry no model, so that
   * question is answered by {@link getLastKnownAgentModel} instead.
   */
  model?: string | null;
  /**
   * The dialog this event opens or closes, as the agent's own id (Issue #1898).
   *
   * Set only by a source whose {@link AgentSourceCapabilities.eventIdentity}
   * names one — opencode's `per_…`, which is both the id in the
   * `permission.asked` frame and the id in the reply URL. Everything else
   * leaves it absent, and an absent id means "this event says nothing about
   * *which* dialog", which is why the release below matches permissively
   * rather than refusing to act.
   */
  decisionId?: string | null;
  /**
   * The tool the dialog this event opens is about, or null/absent (Issue #2031).
   *
   * Only a source that can answer "which tool?" at the moment the dialog is
   * reported may set it. opencode is the measured case and the reason the field
   * exists: its `permission.asked` frame carries no tool name at all (#1758
   * §5.4) — the name comes from the `message.part.updated` frame for the same
   * `callID`, which the subscription correlates as it goes. Before this Issue
   * the notification path passed `toolName: null` unconditionally, so an
   * opencode approval reached the panel with no statement of what it was for.
   *
   * Absent leaves the record's existing `toolName` alone, which is what keeps a
   * `Notification` from erasing the name a `PermissionRequest` already supplied.
   */
  toolName?: string | null;
  /**
   * What `Allow always` on this dialog would permit (Issue #2031).
   *
   * Typed `unknown[]` rather than `string[]`, and bounded by `openDecision`
   * rather than by the caller, for the same reason `message` is: this record is
   * retained for up to 30 minutes and served back over HTTP, so its footprint
   * may not depend on what an agent chose to send — and neither may its
   * element types, since the entries are rendered verbatim. See
   * {@link boundDecisionPatterns}, which drops anything that is not a non-empty
   * string.
   */
  decisionPatterns?: readonly unknown[] | null;
  /**
   * Whether the source states that no dialog is left open by this event
   * (Issue #1898).
   *
   * The caller computes it, because the caller is the only layer that knows
   * both what happened (a verdict was delivered, a `permission.replied` frame
   * arrived) and whether this source's
   * {@link AgentSourceCapabilities.permissionReplyReleasesPrompt} says that
   * settles anything. A hook source can never set it: its verdict goes into the
   * body of a request nobody hears the end of, so the dialog on screen has to
   * be released by something that can observe it.
   *
   * Absent is not `false` in meaning — it is "this source made no statement" —
   * but the two act the same here, and that is deliberate: the pre-#1898
   * behaviour is what an event with nothing to say must keep producing.
   */
  promptSettled?: boolean;
  /**
   * Whether the source states that this `user_prompt_submit` joins the turn
   * that is already running rather than beginning one (Issue #3330).
   *
   * The caller computes it from the payload, through the source's
   * `promptJoinsOpenTurn`: Claude Code fires `UserPromptSubmit` once for each
   * background-task notice it takes off its queue and attaches to a running
   * turn, and the prompt it reports is the `<task-notification>` itself. Read
   * only for `user_prompt_submit`, and only while a turn of the same session is
   * open — see {@link applyTurnTransition}. Absent is `false`: a prompt that
   * says nothing opens a new turn, as every prompt did before this Issue.
   */
  joinsOpenTurn?: boolean;
  /**
   * Whether the delivering source reports the prompt that begins each of its
   * turns — it declares `user_prompt_submit` in `supportedEvents` (Issue #3437).
   *
   * The caller computes it from the source's capabilities. Read only for
   * `pre_tool_use`: from such a source, a `pre_tool_use` arriving after the
   * agent's own `Stop` with no prompt in between is not the start of a turn,
   * so it does not open one — see {@link applyTurnTransition}. Absent is
   * `false`: a source whose turns begin with a tool event (Command Code) opens
   * them on `pre_tool_use`, as every source did before this Issue.
   */
  promptOpensTurns?: boolean;
}
