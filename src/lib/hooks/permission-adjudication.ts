/**
 * Adjudicating an approval CommandMate holds, rather than one it is being
 * asked about (Issue #1898).
 *
 * Five tools ask over a hook and wait for the response body; the receiver route
 * answers and the story ends there. opencode's approvals arrive on a stream and
 * are answered by a separate POST, which means the decision has to be taken in
 * three places rather than one — when the frame arrives, when a re-connect
 * re-reads what is still pending, and when the *policy* changes under a dialog
 * that is already up (`auto-yes --enable` on a blocked session, #1898-2).
 *
 * This module is that decision, once. The judgement itself is unchanged and
 * still `resolvePermissionRequest`, shared with every hook tool; what is here
 * is the part that only a caller holding the pending decision can do:
 *
 *  1. **Adjudicate, then record.** The order is the Issue. Recording first
 *     opens a prompt-waiting record — `agent-event-state` keys it off
 *     `notification(permission_prompt)` — and an approval Auto-Yes is about to
 *     answer then reads `waiting` until the tool call it was gating finishes.
 *     Measured at eight seconds on `sleep 8; pwd`.
 *  2. **Ask the source whether the delivery settles anything.** Only a source
 *     whose {@link AgentSourceCapabilities.permissionReplyReleasesPrompt} is
 *     true can say that a delivered verdict means the dialog is gone (#1924,
 *     §4 D3). Every hook source answers false: its verdict goes into the body
 *     of a request nobody hears the end of.
 *
 * Nothing here branches on a tool id, and nothing here is allowed to: the
 * capability block is the whole vocabulary (`docs/design/
 * multi-agent-state-architecture.md` §4 D3).
 *
 * ## Why `permission-decision-service` is imported dynamically
 *
 * The same reason `sources/opencode/ingest` does it: that module reaches the
 * database, and this one is on the import path of a launcher that must not.
 *
 * @module lib/hooks/permission-adjudication
 */

import { createLogger } from '@/lib/logger';
import { describeAbstain } from './sources/abstain';
import { answerPendingDecisionWithReceipt } from './sources/pending-decisions';
import type { AgentEventSource, AgentInstanceRef, PendingDecision, Verdict } from './sources/types';
import type { PermissionRequestPayload } from './permission-request-payload';
import {
  recordPermissionDecision,
  type PermissionDecisionTrigger,
} from './permission-decision-state';

const logger = createLogger('lib/hooks/permission-adjudication');

/** What one adjudication did, from the point of view of the state record. */
export interface PermissionAdjudication {
  /** The decision that was judged. */
  decisionId: string;
  /** `allow`, or null for a no-decision. */
  behavior: 'allow' | null;
  /** Why, verbatim from the adjudicator. */
  reason: string;
  /** Whether the verdict reached the agent. Always false for an abstain. */
  delivered: boolean;
  /**
   * Whether the caller may treat the dialog as closed.
   *
   * `delivered` **and** the source declaring
   * {@link AgentSourceCapabilities.permissionReplyReleasesPrompt}. Both halves
   * matter: an undelivered allow leaves a human blocked, and a delivered allow
   * on a hook source says nothing about the screen.
   */
  settled: boolean;
}

/**
 * Judge one pending approval and deliver the verdict over the source's own
 * channel.
 *
 * Never throws. An approval is a fact about a session that is still running,
 * and a failure to answer it must cost the answer, never the session — the
 * caller's own fail-open path then leaves the dialog for a human, which is what
 * every uncertain branch of `resolvePermissionRequest` already means.
 *
 * @param source - The source that raised it, and that will carry the verdict
 * @param target - Worktree / tool / instance the approval belongs to
 * @param decision - The pending decision, with the id the reply is addressed to
 * @param payload - Parsed approval, or null when it could not be read — which
 *   the adjudicator treats as "no decision", i.e. leave it for the human
 * @param trigger - Why this is being judged now; recorded for the operator
 */
export async function adjudicatePendingPermission(
  source: AgentEventSource,
  target: AgentInstanceRef,
  decision: PendingDecision,
  payload: PermissionRequestPayload | null,
  trigger: PermissionDecisionTrigger = 'event'
): Promise<PermissionAdjudication> {
  const instanceId = target.instanceId ?? target.cliToolId;
  const session = {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId,
  };

  const { resolvePermissionRequest } = await import('./permission-decision-service');
  const verdictSource = resolvePermissionRequest(session, payload);

  const verdict: Verdict =
    verdictSource.behavior === 'allow' ? { kind: 'allowOnce' } : { kind: 'abstain' };

  if (verdict.kind === 'abstain') {
    const abstain = describeAbstain(source);
    if (!abstain.safe) {
      // On this source silence is an action rather than the absence of one: the
      // agent waits with no timeout at all (#1758 §5.5.3), and a blocked
      // opencode session looks exactly like one that is thinking. Nothing else
      // will say so.
      logger.warn('permission-request-abstain-blocks-agent', {
        worktreeId: target.worktreeId,
        cliToolId: target.cliToolId,
        instanceId,
        toolName: payload?.toolName ?? null,
        decisionId: decision.id,
        reason: verdictSource.reason,
        consequence: abstain.summary,
        blocksForMs: abstain.blocksForMs,
      });
    }
  }

  // C2: the caller does not know whether this writes a response body or opens a
  // second connection, and must not. What it does now get back is whether the
  // verdict landed (#1898).
  const { delivery } = await answerPendingDecisionWithReceipt(source, target, decision, verdict);

  const delivered = delivery?.delivered === true;
  const settled = delivered && source.capabilities.permissionReplyReleasesPrompt;

  recordPermissionDecision(target.worktreeId, target.cliToolId, target.instanceId, {
    decisionId: decision.id,
    toolName: payload?.toolName ?? null,
    behavior: verdictSource.behavior === 'allow' ? 'allow' : null,
    reason: verdictSource.reason,
    delivered,
    releasedPrompt: settled,
    trigger,
    at: decision.askedAt,
  });

  logger.info('permission-decision-adjudicated', {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId,
    decisionId: decision.id,
    toolName: payload?.toolName ?? null,
    behavior: verdictSource.behavior,
    reason: verdictSource.reason,
    suppressedBy: verdictSource.suppressedBy,
    delivered,
    settled,
    trigger,
  });

  return {
    decisionId: decision.id,
    behavior: verdictSource.behavior === 'allow' ? 'allow' : null,
    reason: verdictSource.reason,
    delivered,
    settled,
  };
}
