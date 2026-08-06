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
  /** `Notification(permission_prompt)` — recorded, not applied. See below. */
  PERMISSION_PROMPT: 'hook_permission_prompt',
  /** `Notification(idle_prompt)` — the agent says it is sitting at the composer. */
  IDLE_PROMPT: 'hook_idle_prompt',
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
 * | `notification(permission_prompt)`| `waiting`          |
 * | `notification(idle_prompt)`      | `ready`            |
 * | `notification(other/none)`       | none (scraper)     |
 * | `session_start`                  | none (scraper)     |
 * | `session_end`                    | none (scraper)     |
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
}

/** The activity half of the boolean triple — everything except session existence. */
export type SessionActivityFlags = Omit<CliToolStatusFlags, 'isRunning'>;

/**
 * Project a detected `SessionStatus` onto the activity flags.
 *
 * `isRunning` is deliberately NOT derived here: it comes from tmux session
 * existence (plus the Claude health check), which is independent of what the
 * terminal output says.
 *
 * | SessionStatus | isWaitingForResponse | isProcessing |
 * |---------------|----------------------|--------------|
 * | `idle`        | false                | false        |
 * | `ready`       | false                | false        |
 * | `running`     | false                | true         |
 * | `waiting`     | true                 | false        |
 */
export function sessionStatusToActivityFlags(status: SessionStatus): SessionActivityFlags {
  switch (status) {
    case 'waiting':
      return { isWaitingForResponse: true, isProcessing: false };
    case 'running':
      return { isWaitingForResponse: false, isProcessing: true };
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
