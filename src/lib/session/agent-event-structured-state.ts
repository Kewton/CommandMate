/**
 * The structured verdict an instance's turn implies
 * ({@link getStructuredSessionState}, Issue #1723).
 *
 * Split out of `agent-event-state` (Issue #3375), which re-exports the public
 * names.
 *
 * @module lib/session/agent-event-structured-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import {
  agentEventToSessionStatus,
  HOOK_STATUS_REASON,
  type StructuredStatusVerdict,
} from '@/lib/session/status-mapping';
import { TURN_STALE_AFTER_MS } from '@/lib/session/provisional-turn';
import { effectiveTurn, livePendingDecisions } from '@/lib/session/agent-event-turn';

/**
 * How long a structured verdict is trusted after the event that produced it
 * (Issue #1723; one expression since #1930).
 *
 * The turn model owns the number now — see `provisional-turn`'s
 * {@link TURN_STALE_AFTER_MS}, which documents why it is 30 minutes. This name
 * is kept because it is what `status-evidence` and the #1723/#1725/#1903 suites
 * read, and because "the age bound on a verdict" and "how long a turn may run
 * unheard-from" really are the same fact rather than two that happen to agree.
 */
export const STRUCTURED_STATE_MAX_AGE_MS = TURN_STALE_AFTER_MS;

/** A structured verdict about one instance, with the event that produced it. */
export interface StructuredSessionState extends StructuredStatusVerdict {
  /** The event this verdict was derived from. */
  event: AgentEventType;
  /** Epoch ms the event was received. */
  at: number;
  /** The event's subtype, or null. */
  detail: string | null;
}

/**
 * The status this instance's turn implies, or null when it implies nothing
 * (Issue #1723, re-derived from the turn model in #1930).
 *
 * Null is the answer for every session on a machine where hooks never fire,
 * which is what keeps the unconfigured environment on exactly the behaviour it
 * had before #1723. It is also the answer when:
 *
 *  - the turn belongs to a previous generation, i.e. to an agent process that
 *    used to live in this pane;
 *  - nothing has been heard about it for {@link STRUCTURED_STATE_MAX_AGE_MS};
 *  - the turn ended for a reason that says nothing about whether the pane is
 *    free — `session_end` (a `/clear` mid-turn), `stale`, `generation`, or the
 *    two the *screen* closed it on (`scraper_evidence`, `resync_idle`). Only
 *    the agent's own `Stop` publishes `ready` over this channel; everything
 *    else hands the pane back to the scraper, which is the layer those closures
 *    came from in the first place;
 *  - no decision stands and the displayed event carries no verdict.
 *
 * ## The derivation, in the order it is applied
 *
 * | condition                                   | verdict                       |
 * |---------------------------------------------|-------------------------------|
 * | an unanswered decision is live              | `waiting`                     |
 * | the turn was closed by `stop`               | `ready` / `hook_stop`         |
 * | the turn was closed by anything else        | null                          |
 * | the displayed event carries a verdict       | that verdict                  |
 * | a turn is open and it does not              | `running` / `hook_prompt_submit` |
 * | otherwise                                   | null                          |
 *
 * §4 D3's `running ⟺ open turn ∧ 未裁定なし ∧ 現世代` falls out of the first,
 * fourth and fifth rows together with the generation fence — with one measured
 * exception written into the table above it: `notification(idle_prompt)`
 * publishes `ready` **without** closing the turn (#1839 caught Claude emitting
 * it 62 s into a turn that ran nothing, so it cannot be a boundary). A reader
 * that needs the boundary rather than the display reads `closedAt`.
 *
 * Whether the tmux session is alive is NOT checked here — the caller
 * (`buildCurrentOutput`) has already answered that with the CLI tool's own
 * `isRunning()` and returned early, and asking twice would mean a second tmux
 * round-trip on the hot path for an answer it is holding.
 *
 * @param now - Epoch ms; defaults to now
 */
export function getStructuredSessionState(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  now: number = Date.now()
): StructuredSessionState | null {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const turn = effectiveTurn(key, now);
  if (turn === null) return null;

  const display = turn.displayEvent;
  if (now - display.at >= STRUCTURED_STATE_MAX_AGE_MS) return null;
  const seen = { event: display.event, at: display.at, detail: display.detail };

  const pending = livePendingDecisions(key, turn, now);
  if (pending.length > 0) {
    // The two kinds of evidence stay apart in the reason token, exactly as
    // `structuredWaitingReason` keeps them apart for the payload: a
    // `Notification` is proof a dialog exists, a `PermissionRequest` this
    // server declined to decide is the prediction that one is about to.
    const reason =
      pending[0].source === 'notification'
        ? HOOK_STATUS_REASON.PERMISSION_PROMPT
        : HOOK_STATUS_REASON.PERMISSION_REQUEST;
    return { status: 'waiting', reason, ...seen };
  }

  if (turn.closedAt !== null) {
    if (turn.closedBy === 'stop') {
      return { status: 'ready', reason: HOOK_STATUS_REASON.STOP, ...seen };
    }
    return null;
  }

  const verdict = agentEventToSessionStatus(display.event, display.detail);
  // A `waiting` read off the displayed event is a dialog nothing is holding any
  // more — the ledger above is what answers that question now. The turn is
  // still open, so the agent is still working.
  if (verdict === null || verdict.status === 'waiting') {
    if (turn.openedAt === null) return null;
    return { status: 'running', reason: HOOK_STATUS_REASON.PROMPT_SUBMIT, ...seen };
  }

  return { ...verdict, ...seen };
}
