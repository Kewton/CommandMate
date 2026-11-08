/**
 * The decision of each condition type, from what was observed (Issue #4222, design
 * §1.2〜§1.8・§2). Pure: an answer of a query in, the three values and a fixed reason
 * out. `tests/fixtures/mem/close-when-eval-v1.json` holds the table these follow.
 *
 * @module lib/mem/condition-evaluators
 */

import { isOpenRelayState, type SessionRelay } from '@/lib/relay/types';
import { VERIFIABLE_TASK_STATUSES, type TaskStatus } from '@/lib/db/tasks-db';
import type { MemConditionReason, MemConditionResult, MemEndOutcome, MemUnknownReason } from '@/types/mem';

export type Fact = string | number | boolean | null;

export interface ConditionAnswer {
  result: MemConditionResult;
  reason: MemConditionReason;
  /** Set when met. */
  outcome?: MemEndOutcome;
  /** What was read: only the fields of the tables, never a body or stderr (§3.1). */
  facts: Record<string, Fact>;
}

export const met = (reason: MemConditionReason, outcome: MemEndOutcome, facts: Record<string, Fact> = {}): ConditionAnswer => ({
  result: 'met',
  reason,
  outcome,
  facts,
});
export const notMet = (reason: MemConditionReason, facts: Record<string, Fact> = {}): ConditionAnswer => ({
  result: 'not-met',
  reason,
  facts,
});
export const unknown = (reason: MemUnknownReason, facts: Record<string, Fact> = {}): ConditionAnswer => ({
  result: 'unknown',
  reason,
  facts,
});

const record = (json: unknown): Record<string, unknown> | null =>
  json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null;

/** §1.2. */
export function decideIssue(json: unknown): ConditionAnswer {
  const body = record(json);
  if (!body || typeof body.state !== 'string') return unknown('unexpected_response');
  if (body.pull_request !== undefined && body.pull_request !== null) return unknown('not_an_issue');
  const stateReason = typeof body.state_reason === 'string' ? body.state_reason : null;
  const facts = { state: body.state, stateReason };
  if (body.state === 'open') return notMet('issue-open', facts);
  if (body.state !== 'closed') return unknown('unexpected_response');
  const outcome: MemEndOutcome = stateReason === 'completed' ? 'success' : stateReason === 'not_planned' ? 'failure' : 'unknown';
  return met('issue-closed', outcome, facts);
}

/** §1.3. */
export function decidePr(json: unknown, wanted: 'merged' | 'closed'): ConditionAnswer {
  const body = record(json);
  if (!body || typeof body.state !== 'string') return unknown('unexpected_response');
  const merged = typeof body.merged_at === 'string' && body.merged_at.length > 0;
  const facts = { state: body.state, merged };
  if (body.state === 'open') return notMet('pr-open', facts);
  if (body.state !== 'closed') return unknown('unexpected_response');
  if (wanted === 'merged') return merged ? met('pr-merged', 'success', facts) : notMet('pr-closed-unmerged', facts);
  return met('pr-closed', merged ? 'success' : 'failure', facts);
}

/** §2: the state × delivery hold × pending payload table. */
export function decideRelay(relay: Pick<SessionRelay, 'state' | 'pendingKind' | 'deliveryHold'> | null): ConditionAnswer {
  if (!relay) return unknown('relay_not_found');
  const hold = relay.deliveryHold?.state ?? null;
  const facts = { state: relay.state, deliveryHold: hold, pendingKind: relay.pendingKind };
  if (relay.state === 'pending') return notMet('relay-open', facts);
  if (relay.state === 'prompt') return notMet('relay-prompt', facts);
  if (isOpenRelayState(relay.state)) return notMet('relay-open', facts);
  // Terminal: a hold keeps it open whatever the state (§2 note).
  if (hold === 'uncertain') return unknown('relay-delivery-uncertain', facts);
  if (hold === 'attempting') return notMet('relay-delivery-attempting', facts);
  if (relay.pendingKind !== null) return notMet('relay-payload-pending', facts);
  if (relay.state === 'delivered') return met('relay-delivered', 'success', facts);
  if (relay.state === 'expired') return met('relay-expired', 'failure', facts);
  if (relay.state === 'cancelled') return met('relay-cancelled', 'failure', facts);
  return unknown('unexpected_response', facts);
}

/** §1.6 `task:`. Alive but held up (rate limit, a prompt) is not met. */
export function decideTask(status: TaskStatus | null): ConditionAnswer {
  if (status === null) return unknown('session_not_found');
  const facts = { status };
  if (status === 'succeeded') return met('task-succeeded', 'success', facts);
  if (status === 'cancelled') return met('task-cancelled', 'failure', facts);
  if ((VERIFIABLE_TASK_STATUSES as readonly string[]).includes(status) && (status === 'failed' || status === 'not_started')) {
    return notMet('task-reopenable', facts);
  }
  return notMet('task-running', facts);
}

/** §1.6 `verify:`. A run closed at start-up (`error`) is the record that nothing runs it. */
export function decideVerify(status: string | null): ConditionAnswer {
  if (status === null) return unknown('session_not_found');
  const facts = { status };
  switch (status) {
    case 'running':
      return notMet('verify-running', facts);
    case 'passed':
      return met('verify-passed', 'success', facts);
    case 'failed':
    case 'error':
    case 'not_started':
    case 'cancelled':
      return met(`verify-${status}` as MemConditionReason, 'failure', facts);
    default:
      return unknown('unexpected_response', facts);
  }
}

/** §1.6 `schedule:`. */
export function decideSchedule(status: string | null): ConditionAnswer {
  if (status === null) return unknown('session_not_found');
  const facts = { status };
  switch (status) {
    case 'running':
      return notMet('schedule-running', facts);
    case 'completed':
      return met('schedule-completed', 'success', facts);
    case 'failed':
    case 'timeout':
    case 'cancelled':
      return met(`schedule-${status}` as MemConditionReason, 'failure', facts);
    default:
      return unknown('unexpected_response', facts);
  }
}

/** §1.7: by the stored incarnation, never the id. */
export function decideWorktree(incarnation: string | null | undefined, alive: (incarnation: string) => boolean): ConditionAnswer {
  if (!incarnation) return unknown('schema_unknown');
  return alive(incarnation) ? notMet('worktree-alive') : met('worktree-deleted', 'unknown');
}

/** §1.8. */
export function decideAt(now: number, epochMs: number): ConditionAnswer {
  return now >= epochMs ? met('time-passed', 'unknown', { epochMs }) : notMet('time-not-yet', { epochMs });
}

/** Who the branch of a `branch` condition is now (§1.4). */
export type BranchIdentity =
  | { kind: 'gone' }
  | { kind: 'same'; tip: string }
  | { kind: 'recreated' }
  | { kind: 'diverged' }
  | { kind: 'order-uncertain' }
  | { kind: 'present-no-baseline' }
  | { kind: 'failed'; reason: MemUnknownReason };

/**
 * The creation second of a local ref against the item's creation (2nd review ②):
 * after for sure, before for sure, or the same second (unknown which came first).
 */
export function compareCreation(createdSeconds: number, itemCreatedAtMs: number): 'after' | 'before' | 'same-second' {
  if (createdSeconds * 1000 > itemCreatedAtMs) return 'after';
  if ((createdSeconds + 1) * 1000 <= itemCreatedAtMs) return 'before';
  return 'same-second';
}

/** §1.4 `event = deleted`. */
export function decideBranchDeleted(identity: BranchIdentity): ConditionAnswer {
  const facts = { identity: identity.kind };
  switch (identity.kind) {
    case 'gone':
      return met('branch-deleted', 'unknown', facts);
    case 'recreated':
      return met('branch-recreated', 'unknown', facts);
    case 'same':
      return notMet('branch-present', facts);
    case 'present-no-baseline':
      return notMet('branch-present-no-baseline', facts);
    case 'diverged':
      return unknown('branch-diverged', facts);
    case 'order-uncertain':
      return unknown('branch-order-uncertain', facts);
    case 'failed':
      return unknown(identity.reason, facts);
  }
}
