/**
 * Deciding `hook-correlation` from what the listener received (Issue #2878).
 *
 * The probe session is launched with fixed correlation keys
 * (`worktreeId: "agent-health-probe"`, `instanceId: "<tool>-probe"`). Every
 * hook the session fires must come back with exactly those keys: an event that
 * carries another worktree or instance is the #2874 / #2891 shape (a shared
 * daemon firing hooks with somebody else's environment), and an expected event
 * that never arrives is a hook that went somewhere else — or nowhere.
 */

import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import type { AgentHealthCheckStatus } from './types';

/** One POST the listener received, already reduced to its correlation keys. */
export interface HookDelivery {
  /** `agent-event` or `permission-request` (the receiver path it hit). */
  kind: 'agent-event' | 'permission-request';
  tool: string | null;
  /** Normalized event word, or null when it could not be read. */
  event: string | null;
  worktreeId: string | null;
  instanceId: string | null;
  receivedAt: number;
}

export interface HookCorrelationExpectation {
  tool: string;
  worktreeId: string;
  instanceId: string;
  /** Events that must arrive (already filtered by the source's capabilities). */
  expectedEvents: readonly string[];
}

export interface HookCorrelationVerdict {
  status: Exclude<AgentHealthCheckStatus, 'skip'>;
  summary: string;
  evidence?: string;
}

/** The lifecycle events the check asks for, before capability filtering. */
export const CORRELATED_EVENTS: readonly AgentEventType[] = [
  'session_start',
  'user_prompt_submit',
  'stop',
];

/**
 * The events to expect from a source: {@link CORRELATED_EVENTS} that the
 * source says it emits. An event outside `capabilities.supportedEvents` is
 * never expected.
 */
export function expectedHookEvents(supportedEvents: readonly string[]): string[] {
  return CORRELATED_EVENTS.filter((event) => supportedEvents.includes(event));
}

function describe(delivery: HookDelivery): string {
  return JSON.stringify({
    kind: delivery.kind,
    tool: delivery.tool,
    event: delivery.event,
    worktreeId: delivery.worktreeId,
    instanceId: delivery.instanceId,
    receivedAt: new Date(delivery.receivedAt).toISOString(),
  });
}

/**
 * The tool's own deliveries, split by the correlation keys: those with other
 * keys, the expected events that never arrived with both keys, and the
 * expected events that did.
 */
export function correlateHookDeliveries(
  deliveries: readonly HookDelivery[],
  expectation: HookCorrelationExpectation
): { own: HookDelivery[]; mismatched: HookDelivery[]; missing: string[]; received: string[] } {
  const own = deliveries.filter((delivery) => delivery.tool === expectation.tool);
  const matches = (delivery: HookDelivery) =>
    delivery.worktreeId === expectation.worktreeId &&
    delivery.instanceId === expectation.instanceId;
  const arrived = (event: string) =>
    own.some((delivery) => delivery.kind === 'agent-event' && delivery.event === event && matches(delivery));

  return {
    own,
    mismatched: own.filter((delivery) => !matches(delivery)),
    missing: expectation.expectedEvents.filter((event) => !arrived(event)),
    received: expectation.expectedEvents.filter(arrived),
  };
}

export function evaluateHookCorrelation(
  deliveries: readonly HookDelivery[],
  expectation: HookCorrelationExpectation
): HookCorrelationVerdict {
  const { own, mismatched, missing } = correlateHookDeliveries(deliveries, expectation);

  const expected = `${expectation.expectedEvents.join(' / ')} が worktreeId=${expectation.worktreeId}・instanceId=${expectation.instanceId} で届く`;
  const received = own.map(describe).join('\n');

  if (mismatched.length > 0) {
    const keys = mismatched
      .map((d) => `${d.event ?? d.kind}(worktreeId=${d.worktreeId ?? '-'}, instanceId=${d.instanceId ?? '-'})`)
      .join(', ');
    return {
      status: 'fail',
      summary: `期待: ${expected}。実際: 別の相関キーで届いた hook が ${mismatched.length} 件 — ${keys}`,
      evidence: received,
    };
  }
  if (missing.length > 0) {
    return {
      status: 'fail',
      summary: `期待: ${expected}。実際: ${missing.join(' / ')} が未着（受信 ${own.length} 件）`,
      evidence: received === '' ? '(listener は何も受け取っていない)' : received,
    };
  }
  return {
    status: 'pass',
    summary: `${expected}（受信 ${own.length} 件、すべて一致）`,
  };
}
