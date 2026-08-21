/**
 * Re-judging the approvals a session is already sitting on, because the policy
 * changed under them (Issue #1898-2).
 *
 * A verdict is normally decided once, at the instant the approval arrives. That
 * is the only moment a hook offers — the agent is holding the request open and
 * there is nothing to come back to. A pull source is different: the approval
 * stays pending on the agent's own server until somebody answers it, so
 * "decided once" is a choice rather than a constraint, and it was the wrong one.
 * Switching Auto-Yes on while an opencode dialog was up did nothing at all: the
 * request had already been abstained on, the poller only reads the *screen*,
 * and the design's re-read (`resyncPending`) ran on re-connect and on nothing
 * else. Measured: 30 seconds of `waiting` with no adjudication log.
 *
 * §4 D3 decision 3 of `docs/design/multi-agent-state-architecture.md` widens
 * that re-read from "on re-connect" to "whenever the policy that would answer
 * it changes". This module is the entry point for the Auto-Yes half of that
 * list; the re-connect half stays where it is, in the subscription's own loop.
 *
 * ## The capability gate
 *
 * {@link AgentSourceCapabilities.resync} is the declared value that decides
 * whether this is possible at all, and it is read rather than inferred from the
 * tool id (§4 D3). `'none'` — every hook source — means the pending state is
 * whatever requests happen to be in flight *right now*, and those are already
 * being answered by the route that is holding them; re-judging one would
 * deliver a second verdict into a slot that is about to be closed. Only a
 * source that can be asked again (`'session-status-poll'`, i.e. opencode's
 * `GET /permission`) has anything to re-read.
 *
 * @module lib/hooks/pending-decision-recheck
 */

import { createLogger } from '@/lib/logger';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { PERMISSION_REPLIED_DETAIL } from './agent-event-types';
import { adjudicatePendingPermission } from './permission-adjudication';
import { getAgentEventSource } from './sources/registry';
import type { AgentInstanceRef } from './sources/types';

const logger = createLogger('lib/hooks/pending-decision-recheck');

/**
 * Cap on approvals adjudicated in one re-check (§4 D3, DR4-009).
 *
 * The list comes off the agent's own server, which is a process CommandMate did
 * not start and does not police. Bounded so a server answering with thousands
 * of entries costs one bounded pass rather than thousands of POSTs, and the
 * overflow is reported rather than dropped in silence.
 */
export const MAX_RECHECKED_DECISIONS = 50;

/** What one re-check did. */
export interface PendingDecisionRecheck {
  /** Approvals read back from the source. */
  examined: number;
  /** Approvals whose verdict reached the agent. */
  delivered: number;
  /** Approvals past {@link MAX_RECHECKED_DECISIONS}, judged by nobody. */
  skipped: number;
  /** Why nothing happened, when nothing did. Null on a re-check that ran. */
  reason: PendingDecisionRecheckReason | null;
}

/** Why a re-check did not adjudicate anything. */
export type PendingDecisionRecheckReason =
  /** This source cannot be re-read; see the module comment. */
  | 'resync-unsupported'
  /** It was re-read and nothing was pending. The ordinary case. */
  | 'no-pending'
  /** The source could not be reached. Fail-open: the dialog stays for a human. */
  | 'unreachable';

const NOTHING = (reason: PendingDecisionRecheckReason): PendingDecisionRecheck => ({
  examined: 0,
  delivered: 0,
  skipped: 0,
  reason,
});

/**
 * Re-judge every approval this instance is still blocked on.
 *
 * Never throws, and never denies: an approval this pass cannot decide is left
 * exactly as it was, which is the same no-decision every uncertain branch of
 * the adjudicator already answers.
 *
 * Questions are deliberately not re-judged. A `question.asked` is answered with
 * a *choice*, and no policy in this codebase authors one — Auto-Yes decides
 * whether to approve, never what to reply.
 *
 * @param target - The instance whose policy just changed
 */
export async function recheckPendingDecisions(
  target: AgentInstanceRef
): Promise<PendingDecisionRecheck> {
  const instanceId = target.instanceId ?? target.cliToolId;
  const source = getAgentEventSource(target.cliToolId);

  if (source.capabilities.resync === 'none') {
    return NOTHING('resync-unsupported');
  }

  let pending;
  try {
    pending = await source.listPending(target);
  } catch (error) {
    logger.warn('pending-decision-recheck-unreachable', {
      worktreeId: target.worktreeId,
      cliToolId: target.cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOTHING('unreachable');
  }

  const permissions = pending.filter((decision) => decision.kind === 'permission');
  if (permissions.length === 0) return NOTHING('no-pending');

  const judged = permissions.slice(0, MAX_RECHECKED_DECISIONS);
  const skipped = permissions.length - judged.length;
  if (skipped > 0) {
    // DR1-021: a cap that truncates in silence reads as "everything was
    // covered". The count is the difference between that and a bounded pass.
    logger.warn('pending-decision-recheck-truncated', {
      worktreeId: target.worktreeId,
      cliToolId: target.cliToolId,
      instanceId,
      examined: judged.length,
      skipped,
      limit: MAX_RECHECKED_DECISIONS,
    });
  }

  let delivered = 0;
  for (const decision of judged) {
    try {
      const outcome = await adjudicatePendingPermission(
        source,
        target,
        decision,
        source.parsePermissionRequest(decision.raw),
        'policy-recheck'
      );
      if (outcome.settled) {
        // The same release the live path takes, expressed through the same
        // state machine: the verdict is on its way, so no human is blocked.
        const { recordAgentEvent } = await import('@/lib/session/agent-event-state');
        recordAgentEvent(target.worktreeId, target.cliToolId, target.instanceId, {
          event: 'notification',
          at: Date.now(),
          detail: PERMISSION_REPLIED_DETAIL,
          sessionId: decision.conversationId,
          decisionId: decision.id,
          promptSettled: true,
        });
      }
      if (outcome.delivered) delivered += 1;
    } catch (error) {
      logger.warn('pending-decision-recheck-failed', {
        worktreeId: target.worktreeId,
        cliToolId: target.cliToolId,
        instanceId,
        decisionId: decision.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('pending-decision-recheck', {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId,
    examined: judged.length,
    delivered,
    skipped,
  });

  return { examined: judged.length, delivered, skipped, reason: null };
}

/** The ref every caller of {@link recheckPendingDecisions} builds. */
export function decisionRecheckTarget(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): AgentInstanceRef {
  return { worktreeId, cliToolId, instanceId };
}
