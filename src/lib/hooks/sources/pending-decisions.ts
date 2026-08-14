/**
 * The in-flight decisions a push source is holding, and the one call a receiver
 * makes to answer one (Issue #1759, constraint C2).
 *
 * A hook is answered in the body of the request it arrived on. opencode is
 * answered by `POST`ing to a different URL, minutes later if need be, on a
 * connection the event never travelled over (#1758 §5.5). Those are not two
 * spellings of one operation, and a receiver that branched on which it was
 * dealing with would be a receiver that knows the tool — the thing this whole
 * abstraction exists to remove.
 *
 * {@link answerPendingDecision} is the seam. It opens a slot, hands the
 * decision to {@link AgentEventSource.decide}, and returns whatever body the
 * source left behind — `{}` when the source answered out of band, because there
 * is then nothing for the response to carry. A push source fills the slot
 * synchronously; a pull source ignores it and calls REST. The caller writes the
 * returned object either way.
 *
 * The open slots are also what {@link AgentEventSource.listPending} answers with
 * for push sources (C7): a hook that has not been replied to yet is the only
 * pending state a push transport has, and a hook that was dropped is simply
 * gone — there is no `GET /permission` to re-read it from.
 *
 * @module lib/hooks/sources/pending-decisions
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import { createLogger } from '@/lib/logger';
import type {
  AgentEventSource,
  AgentInstanceRef,
  PendingDecision,
  Verdict,
} from './types';

const logger = createLogger('lib/hooks/sources/pending-decisions');

/** One decision a receiver is currently blocking on. */
export interface DecisionSlot {
  readonly key: string;
  readonly ref: AgentInstanceRef;
  readonly decision: PendingDecision;
  /** Set by a push source's `decide()`; stays null for an out-of-band reply. */
  body: Record<string, unknown> | null;
}

/**
 * Open slots per instance, reached through `globalThis`.
 *
 * Same reason as every other shared map in this codebase (#1736): under
 * `next dev` each route handler is a separate bundle, and a module-scoped map
 * would mean the route that opened the slot and the source that fills it are
 * looking at two different maps — a failure that produces no error, just a
 * permanently empty answer.
 */
declare global {
  // eslint-disable-next-line no-var
  var __agentSourcePendingDecisions: Map<string, DecisionSlot[]> | undefined;
}

const pendingByInstance = (globalThis.__agentSourcePendingDecisions ??= new Map<
  string,
  DecisionSlot[]
>());

/**
 * Cap on simultaneously open slots for one instance.
 *
 * An agent asks one thing at a time, so anything above a handful means slots
 * are leaking rather than that a human is very busy. The oldest is dropped
 * rather than the newest refused: the newest is the one somebody is waiting on.
 */
export const MAX_OPEN_DECISIONS_PER_INSTANCE = 16;

function keyOf(ref: AgentInstanceRef): string {
  return buildCompositeKey(ref.worktreeId, ref.cliToolId, ref.instanceId);
}

/** Register a decision as in flight. Always paired with {@link closeDecisionSlot}. */
export function openDecisionSlot(ref: AgentInstanceRef, decision: PendingDecision): DecisionSlot {
  const key = keyOf(ref);
  const slot: DecisionSlot = { key, ref, decision, body: null };
  const open = pendingByInstance.get(key) ?? [];
  open.push(slot);
  while (open.length > MAX_OPEN_DECISIONS_PER_INSTANCE) open.shift();
  pendingByInstance.set(key, open);
  return slot;
}

/**
 * Remove a slot and take whatever the source wrote into it.
 *
 * @returns The response body, or `{}` when the source answered out of band —
 *   which is also, and not by accident, the byte-for-byte no-decision body
 *   every hook-based tool reads as "carry on" (#1721 D5).
 */
export function closeDecisionSlot(slot: DecisionSlot): Record<string, unknown> {
  const open = pendingByInstance.get(slot.key);
  if (open) {
    const index = open.indexOf(slot);
    if (index >= 0) open.splice(index, 1);
    if (open.length === 0) pendingByInstance.delete(slot.key);
  }
  return slot.body ?? {};
}

/** The decisions currently in flight for one instance. */
export function listOpenDecisions(ref: AgentInstanceRef): PendingDecision[] {
  return (pendingByInstance.get(keyOf(ref)) ?? []).map((slot) => slot.decision);
}

/** Fill the slot a push source is answering, if it is still open. */
export function fillDecisionSlot(
  ref: AgentInstanceRef,
  decisionId: string,
  body: Record<string, unknown>
): boolean {
  const open = pendingByInstance.get(keyOf(ref));
  if (!open) return false;
  const slot = open.find((candidate) => candidate.decision.id === decisionId);
  if (!slot) return false;
  slot.body = body;
  return true;
}

/** Drop every open slot. For tests; production only ever closes what it opened. */
export function resetPendingDecisions(): void {
  pendingByInstance.clear();
}

/**
 * Answer one decision, whichever way this source answers things.
 *
 * The single call a receiver route makes. It does not know — and after this
 * function exists, cannot find out without going out of its way — whether the
 * verdict left through the response body or through a second HTTP call.
 *
 * @returns The body to write. `{}` means "nothing to say here", which for a
 *   hook is the measured no-decision reply and for a pull source is simply the
 *   ack of a request whose answer went elsewhere.
 */
export async function answerPendingDecision(
  source: AgentEventSource,
  ref: AgentInstanceRef,
  decision: PendingDecision,
  verdict: Verdict
): Promise<Record<string, unknown>> {
  const slot = openDecisionSlot(ref, decision);
  try {
    await source.decide(ref, decision, verdict);
  } catch (error) {
    // Closed even when `decide` throws: a source that failed to deliver must
    // still not leave the receiver holding a slot, and the empty body that then
    // comes back is the fail-open answer for every push tool.
    logger.warn('agent-source-decide-failed', {
      worktreeId: ref.worktreeId,
      cliToolId: ref.cliToolId,
      instanceId: ref.instanceId ?? ref.cliToolId,
      decisionId: decision.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return closeDecisionSlot(slot);
}
