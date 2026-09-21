/**
 * Session status vocabulary mapping (Issue #1550).
 *
 * The same session reality is expressed in several vocabularies:
 *
 * | Vocabulary          | Defined in                          | Values                                    |
 * |---------------------|-------------------------------------|-------------------------------------------|
 * | `SessionStatus`     | `lib/detection/status-detector.ts`  | idle / ready / running / waiting          |
 * | `BranchStatus`      | `types/sidebar.ts`                  | idle / ready / running / waiting / generating |
 * | boolean triple      | `lib/session/worktree-status-helper.ts` | isRunning / isWaitingForResponse / isProcessing |
 * | `UIPhase`           | `types/ui-state.ts`                 | idle / waiting / receiving / prompt / complete |
 * | `AgentEventType`    | `lib/hooks/agent-event-types.ts`    | stop / notification / session_start / …   |
 *
 * This module is the single place where those vocabularies are converted into
 * one another, so the correspondence cannot drift between call sites. It is a
 * pure module (type-only imports) and is therefore safe to import from client
 * components.
 *
 * ## The live conversion chain
 *
 *   terminal output
 *     -> detectSessionStatus()                  (status-detector, NOT touched here)
 *     -> SessionStatus
 *     -> [merged with agentEventToSessionStatus() in current-output-builder]
 *
 *     -> sessionStatusToActivityFlags()         (this module)
 *     -> boolean triple (+ isRunning from tmux session existence)
 *     -> deriveCliStatus()                      (this module)
 *     -> BranchStatus                           (sidebar / header / tab dots)
 *
 * An unclassified frame (Issue #2775) takes the same chain with no activity
 * flag raised, and `isUnclassifiedCliStatus()` is how a surface tells its
 * `ready` apart from a real one.
 *
 * `deriveSessionStatus()` is the reverse edge of that chain: the worktrees API
 * folds the boolean triple back into a `SessionStatus` for its JSON payload.
 *
 * ## Why `UIPhase` has no mapping function here
 *
 * `UIPhase` is a state machine, not a projection of `SessionStatus`: `waiting`
 * -> `receiving` -> `complete` is a sequence driven by user sends and streamed
 * output, and the same `SessionStatus` can legitimately correspond to several
 * phases depending on history. The only edge that is a pure table lookup is
 * "an active prompt was detected -> phase `prompt`", and that edge is already
 * expressed exactly once, by the `SHOW_PROMPT` case of `worktreeUIReducer`
 * (`hooks/useWorktreeUIState.ts`). Re-encoding it here would add an indirection
 * with no second call site, so the reducer stays the single owner.
 */

import type { SessionStatus } from '@/lib/detection/status-detector';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import type { BranchStatus } from '@/types/sidebar';

/**
 * `sessionStatusReason` values produced by the structured-event layer
 * (Issue #1723), as opposed to `STATUS_REASON` which is the scraper's.
 *
 * They are deliberately prefixed: a reader of a payload, a log line or a
 * `commandmate capture --json` must be able to tell at a glance which of the two
 * detection layers decided, because the whole point of the two-layer split is
 * being able to measure how often they disagree.
 */
export const HOOK_STATUS_REASON = {
  /** The agent reported it began a turn (`UserPromptSubmit`). */
  PROMPT_SUBMIT: 'hook_prompt_submit',
  /** The agent reported the turn ended (`Stop` / `SubagentStop`). */
  STOP: 'hook_stop',
  /** `Notification(permission_prompt)` — the agent says a dialog is on screen. */
  PERMISSION_PROMPT: 'hook_permission_prompt',
  /**
   * A `PermissionRequest` this server declined to decide (Issue #1725).
   *
   * Distinct from {@link PERMISSION_PROMPT} because the two are different kinds
   * of evidence, and an operator reading a payload or a log has to be able to
   * tell them apart: the notification is proof a dialog exists, this one is the
   * prediction that one is about to. Only the prediction expires unaided.
   */
  PERMISSION_REQUEST: 'hook_permission_request',
  /** `Notification(idle_prompt)` — the agent says it is sitting at the composer. */
  IDLE_PROMPT: 'hook_idle_prompt',
  /**
   * `PreToolUse` — the agent reported it is invoking a tool (Issue #1726).
   *
   * A turn in progress, and nothing more. It is deliberately NOT `waiting` even
   * though the only matcher injected for it is `AskUserQuestion`: whether that
   * picker is on screen is the scraper's question (§5.6 measured that Claude
   * emits nothing at all while it is up), and asserting `waiting` from a
   * pre-invocation event would keep asserting it long after a human answered in
   * the terminal, because no event marks that.
   */
  PRE_TOOL_USE: 'hook_pre_tool_use',
  /**
   * `PostToolUse` — the agent reported a tool call finished (Issue #1726).
   *
   * `running` like its `PreToolUse` counterpart, and for the same reason: a tool
   * finishing is not a turn finishing. `Stop` is what says the turn ended, and
   * it followed this by 1.3 s in the live capture.
   */
  POST_TOOL_USE: 'hook_post_tool_use',
} as const;

export type HookStatusReason = (typeof HOOK_STATUS_REASON)[keyof typeof HOOK_STATUS_REASON];

/** A status the structured events imply, with the reason token that says so. */
export interface StructuredStatusVerdict {
  status: SessionStatus;
  reason: HookStatusReason;
}

/**
 * The structured state machine: last lifecycle event -> `SessionStatus`
 * (Issue #1723).
 *
 * Pure and total, so the whole table can be read in one place:
 *
 * | event                            | verdict            |
 * |----------------------------------|--------------------|
 * | `user_prompt_submit`             | `running`          |
 * | `stop`                           | `ready`            |
 * | `pre_tool_use`                   | `running`          |
 * | `post_tool_use`                  | `running`          |
 * | `notification(permission_prompt)`| `waiting`          |
 * | `notification(idle_prompt)`      | `ready`            |
 * | `notification(other/none)`       | none (scraper)     |
 * | `session_start`                  | none (scraper)     |
 * | `session_end`                    | none (scraper)     |
 *
 * `pre_tool_use` answers `running` for the same reason `user_prompt_submit`
 * does: the agent is mid-turn. It has to answer *something*, because this table
 * reads only the newest event — answering "none" would mean an `AskUserQuestion`
 * invocation erased the `running` its own turn's `user_prompt_submit` had
 * established, and a scraper that reads the picker as `ready`/`no_recent_output`
 * (which is exactly the #1708 failure) would then let `commandmate wait` exit 0
 * on a session with a dialog in front of it. `running` never overrides a scraper
 * `waiting`, so promoting it costs nothing where the screen can be read.
 *
 * `session_start` answering "none" is not an oversight, it is a requirement.
 * A folder that has not been trusted yet shows its trust dialog *before* any
 * hook fires — 25.3 seconds of complete silence in the live capture
 * (`docs/design/agent-hooks-live-verification.md` §5.6) — so the arrival of
 * `SessionStart` cannot be used as "the session is up", and its absence cannot
 * be used as "it is not". What `session_start` does do is start a new
 * generation; that belongs to `agent-event-state`, not to this table.
 *
 * `session_end` answers none because the state is discarded, not because the
 * session is idle: `/clear` emits `SessionEnd(reason=clear)` on a session that
 * is alive and about to keep going (§1.1).
 *
 * @param detail - The event's subtype, for the events that have one
 */
export function agentEventToSessionStatus(
  event: AgentEventType,
  detail: string | null,
): StructuredStatusVerdict | null {
  switch (event) {
    case 'user_prompt_submit':
      return { status: 'running', reason: HOOK_STATUS_REASON.PROMPT_SUBMIT };
    case 'pre_tool_use':
      return { status: 'running', reason: HOOK_STATUS_REASON.PRE_TOOL_USE };
    case 'post_tool_use':
      return { status: 'running', reason: HOOK_STATUS_REASON.POST_TOOL_USE };
    case 'stop':
      return { status: 'ready', reason: HOOK_STATUS_REASON.STOP };
    case 'notification':
      // Matched on `notification_type`, never on the human-facing `message` (D3).
      if (detail === 'permission_prompt') {
        return { status: 'waiting', reason: HOOK_STATUS_REASON.PERMISSION_PROMPT };
      }
      if (detail === 'idle_prompt') {
        return { status: 'ready', reason: HOOK_STATUS_REASON.IDLE_PROMPT };
      }
      return null;
    case 'session_start':
    case 'session_end':
      return null;
    default:
      // exhaustive check: AgentEventType extensions cause a compile error
      event satisfies never;
      return null;
  }
}

/**
 * The boolean triple that both the sidebar and the worktree detail panes use to
 * describe one CLI-tool / agent-instance session.
 *
 * Structurally identical to `CliToolSessionStatus` in `worktree-status-helper.ts`;
 * declared here so this module stays free of server-side imports.
 */
export interface CliToolStatusFlags {
  isRunning: boolean;
  isWaitingForResponse: boolean;
  isProcessing: boolean;
  /**
   * The detector could not classify this session's frame at all (Issue #2775).
   *
   * The server's answer to `isUnclassifiedFrame` in `status-evidence.ts`, carried
   * beside the triple rather than folded into it: {@link deriveCliStatus} never
   * reads it, so every `BranchStatus` consumer keeps its five-value vocabulary.
   * {@link isUnclassifiedCliStatus} is the one reader. Optional because the
   * server publishes the key only when it is true.
   */
  isUnclassified?: boolean;
}

/** The activity half of the boolean triple — everything except session existence. */
export type SessionActivityFlags = Omit<CliToolStatusFlags, 'isRunning' | 'isUnclassified'>;

/**
 * Project a detected `SessionStatus` onto the activity flags.
 *
 * `isRunning` is deliberately NOT derived here: it comes from tmux session
 * existence (plus the Claude health check), which is independent of what the
 * terminal output says.
 *
 * | SessionStatus | unclassified | isWaitingForResponse | isProcessing |
 * |---------------|--------------|----------------------|--------------|
 * | `idle`        | (ignored)    | false                | false        |
 * | `ready`       | (ignored)    | false                | false        |
 * | `running`     | false        | false                | true         |
 * | `running`     | true         | false                | false        |
 * | `waiting`     | (ignored)    | true                 | false        |
 *
 * ## The `running` + unclassified row (Issue #2775)
 *
 * The detector's floors (`default` / `unknown_frame` / `no_recent_output`)
 * answer `running`, and `running` keeps meaning what it means there — the
 * detector is not touched. What changes is only this projection: `isProcessing`
 * is what the sidebar, the header, `commandmate ls` and `peers` read as "it is
 * working", and "no rule could read the frame" is not an observation that it
 * is. So an unclassified `running` raises no activity flag at all, and the
 * caller publishes the fact itself (`isUnclassified`) for the surfaces that
 * draw it.
 *
 * `unclassified` is the caller's `isUnclassifiedFrame(status, reason)`, passed
 * in rather than recomputed: that function is the single producer of the fact,
 * and this module stays free of the server-side imports it would need to call
 * it. It is ignored for every status but `running`, which is the only status it
 * can be true for.
 *
 * @param status - The detector's verdict
 * @param unclassified - `isUnclassifiedFrame(status, reason)` for the same frame
 */
export function sessionStatusToActivityFlags(
  status: SessionStatus,
  unclassified: boolean = false,
): SessionActivityFlags {
  switch (status) {
    case 'waiting':
      return { isWaitingForResponse: true, isProcessing: false };
    case 'running':
      return { isWaitingForResponse: false, isProcessing: !unclassified };
    case 'idle':
    case 'ready':
      return { isWaitingForResponse: false, isProcessing: false };
    default:
      // exhaustive check: SessionStatus extensions cause a compile error [DR2-005]
      status satisfies never;
      return { isWaitingForResponse: false, isProcessing: false };
  }
}

/**
 * Derive `BranchStatus` from one session's boolean triple.
 *
 * Shared by the sidebar (`toBranchItem`), the worktree detail tab dots, the
 * desktop header status row, Sessions and Review.
 *
 * Precedence is waiting > running > ready > idle: a session that is both
 * waiting for an answer and processing is shown as `waiting`, because the user
 * action it needs is the more significant fact.
 *
 * Note that `generating` is never produced here — it exists in `BranchStatus`
 * but has no boolean-triple source. Resolving that asymmetry is out of scope
 * for Issue #1550 (this issue only moves the conversions to one place).
 */
export function deriveCliStatus(toolStatus?: CliToolStatusFlags): BranchStatus {
  if (!toolStatus) return 'idle';
  if (toolStatus.isWaitingForResponse) return 'waiting';
  if (toolStatus.isProcessing) return 'running';
  if (toolStatus.isRunning) return 'ready';
  return 'idle';
}

/**
 * Whether one session should be drawn as "cannot tell" rather than as the
 * `BranchStatus` {@link deriveCliStatus} names for it (Issue #2775).
 *
 * True exactly when the server flagged the frame unclassified AND nothing more
 * significant is known, i.e. {@link deriveCliStatus} lands on `ready`. The
 * second half is not decoration:
 *
 *  - an unclassified session raises no activity flag of its own (see
 *    {@link sessionStatusToActivityFlags}), so on its own it derives `ready` —
 *    the one `BranchStatus` that would otherwise claim "you can send now";
 *  - a `waiting` the agent's own events reported, or a `running` from another
 *    instance folded into the same per-tool aggregate, is a reading, and a
 *    reading outranks "cannot tell". Those keep their dot.
 *
 * Which also means a `running` with positive evidence can never be redrawn by
 * this: it has no `isUnclassified`, and even if it had, it derives `running`.
 *
 * Reads the published flag, never `(status, reason)`: the classification itself
 * has one producer, `isUnclassifiedFrame` in `status-evidence.ts`.
 */
export function isUnclassifiedCliStatus(toolStatus?: CliToolStatusFlags): boolean {
  return toolStatus?.isUnclassified === true && deriveCliStatus(toolStatus) === 'ready';
}

/**
 * Fold a worktree-level boolean triple back into a `SessionStatus` for the
 * worktrees API payload — the reverse edge of `sessionStatusToActivityFlags`.
 *
 * Returns `null` (not `'idle'`) when no session is running, because the API
 * contract distinguishes "no session" from "a session that reports idle".
 */
export function deriveSessionStatus(status: {
  isSessionRunning: boolean;
  isWaitingForResponse: boolean;
  isProcessing: boolean;
}): SessionStatus | null {
  if (!status.isSessionRunning) return null;
  if (status.isWaitingForResponse) return 'waiting';
  if (status.isProcessing) return 'running';
  return 'ready';
}

/**
 * The `SessionStatus` -> `BranchStatus` correspondence, as one table.
 *
 * Composed from the two conversions the live chain actually uses, so it can
 * never drift from them.
 *
 * | isRunning | SessionStatus | BranchStatus |
 * |-----------|---------------|--------------|
 * | false     | (any / null)  | `idle`       |
 * | true      | `null`        | `ready`      |
 * | true      | `idle`        | `ready`      |
 * | true      | `ready`       | `ready`      |
 * | true      | `running`     | `running`    |
 * | true      | `waiting`     | `waiting`    |
 *
 * The `idle` -> `ready` row is not a mistake: once a tmux session exists, the
 * sidebar shows `ready` (the user can send a message) even while the detector
 * still reports `idle` for the terminal contents.
 */
export function deriveBranchStatus(
  sessionStatus: SessionStatus | null,
  isRunning: boolean,
): BranchStatus {
  if (!isRunning) return 'idle';
  return deriveCliStatus({
    isRunning: true,
    ...(sessionStatus
      ? sessionStatusToActivityFlags(sessionStatus)
      : { isWaitingForResponse: false, isProcessing: false }),
  });
}
