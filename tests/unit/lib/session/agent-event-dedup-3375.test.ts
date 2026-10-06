/**
 * `agent-event-dedup`, read directly rather than through `agent-event-state`
 * (Issue #3375).
 *
 * The module was split out of `agent-event-state` without changing what it
 * does. This suite pins the moved behaviour at its new address, and pins that
 * the names `agent-event-state` re-exports are the same functions, reading the
 * same `globalThis` maps — one state, not two copies of it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as dedup from '@/lib/session/agent-event-dedup';
import * as state from '@/lib/session/agent-event-state';
import {
  AGENT_EVENT_DEDUP_WINDOW_MS,
  agentEventKeyClaimedAt,
  classifyAgentEventDelivery,
  dropCounts,
  dropsFor,
  getAgentEventDropCounts,
  getRecentEventIdentityCount,
  getRecentEventKeyCount,
  isDuplicateAgentEvent,
  LIFECYCLE_AGENT_EVENT_TYPES,
  MAX_RECENT_EVENT_KEYS,
  recentEventKeys,
  shortSessionTag,
  trimOldestEntries,
  type AgentEventDelivery,
} from '@/lib/session/agent-event-dedup';

const WT = 'wt-3375-dedup';
const T0 = 1_800_000_000_000;

function delivery(overrides: Partial<AgentEventDelivery> = {}): AgentEventDelivery {
  return {
    worktreeId: WT,
    cliToolId: 'opencode',
    instanceId: undefined,
    event: 'notification',
    detail: 'permission_prompt',
    sessionId: 'ses-1',
    at: T0,
    identity: 'per_1',
    identityKind: 'permission-id',
    ...overrides,
  };
}

beforeEach(() => state.clearAgentStopEvents());
afterEach(() => state.clearAgentStopEvents());

describe('agent-event-dedup is the module agent-event-state re-exports (#3375)', () => {
  it('re-exports the same functions and constants, not copies', () => {
    expect(state.isDuplicateAgentEvent).toBe(dedup.isDuplicateAgentEvent);
    expect(state.classifyAgentEventDelivery).toBe(dedup.classifyAgentEventDelivery);
    expect(state.agentEventKeyClaimedAt).toBe(dedup.agentEventKeyClaimedAt);
    expect(state.getAgentEventDropCounts).toBe(dedup.getAgentEventDropCounts);
    expect(state.getRecentEventKeyCount).toBe(dedup.getRecentEventKeyCount);
    expect(state.getRecentEventIdentityCount).toBe(dedup.getRecentEventIdentityCount);
    expect(state.shortSessionTag).toBe(dedup.shortSessionTag);
    expect(state.LIFECYCLE_AGENT_EVENT_TYPES).toBe(dedup.LIFECYCLE_AGENT_EVENT_TYPES);
    expect(state.AGENT_EVENT_DEDUP_WINDOW_MS).toBe(dedup.AGENT_EVENT_DEDUP_WINDOW_MS);
  });

  it('keeps its maps on globalThis, where clearAgentStopEvents reaches them', () => {
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', 's', T0)).toBe(false);
    expect(recentEventKeys).toBe(globalThis.__agentEventRecentKeys);
    expect(dropCounts).toBe(globalThis.__agentEventDrops);
    expect(getRecentEventKeyCount()).toBe(1);

    state.clearAgentStopEvents();

    expect(getRecentEventKeyCount()).toBe(0);
  });
});

describe('the time window', () => {
  it('never suppresses an event without a session id', () => {
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', null, T0)).toBe(false);
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', null, T0 + 1)).toBe(false);
    expect(getRecentEventKeyCount()).toBe(0);
  });

  it('drops a repeat inside the window and lets one through after it', () => {
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', 's', T0)).toBe(false);
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', 's', T0 + 1)).toBe(true);
    expect(agentEventKeyClaimedAt(WT, 'claude', undefined, 'stop', 's')).toBe(T0);
    expect(
      isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', 's', T0 + AGENT_EVENT_DEDUP_WINDOW_MS)
    ).toBe(false);
  });

  it('keys on the subtype', () => {
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'pre_tool_use', 's', T0, 'Bash')).toBe(false);
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'pre_tool_use', 's', T0 + 1, 'Read')).toBe(false);
  });

  it('releases a stop claim when the same session starts a turn (#3289)', () => {
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', 's', T0)).toBe(false);
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'user_prompt_submit', 's', T0 + 10)).toBe(false);
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', 's', T0 + 20)).toBe(false);
  });

  it('releases a turn-start claim when the same session stops (#3301)', () => {
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'user_prompt_submit', 's', T0)).toBe(false);
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'stop', 's', T0 + 10)).toBe(false);
    expect(isDuplicateAgentEvent(WT, 'claude', undefined, 'user_prompt_submit', 's', T0 + 20)).toBe(false);
  });
});

describe('classifyAgentEventDelivery', () => {
  it('drops a repeated identity with no time bound, and counts it', () => {
    expect(classifyAgentEventDelivery(delivery())).toEqual({ duplicate: false });
    expect(classifyAgentEventDelivery(delivery({ at: T0 + 10 * 60_000 }))).toEqual({
      duplicate: true,
      by: 'identity',
    });
    expect(getAgentEventDropCounts(WT, 'opencode').dedupDropped.identity).toBe(1);
    expect(getRecentEventIdentityCount(WT, 'opencode')).toBe(1);
    expect(getRecentEventIdentityCount()).toBe(1);
  });

  it('never suppresses a lifecycle event with no id on an identity source', () => {
    expect(LIFECYCLE_AGENT_EVENT_TYPES).toEqual(['stop', 'session_end']);
    const stop = delivery({ event: 'stop', detail: null, identity: null });
    expect(classifyAgentEventDelivery(stop)).toEqual({ duplicate: false });
    expect(classifyAgentEventDelivery({ ...stop, at: T0 + 1 })).toEqual({ duplicate: false });
  });

  it('discards an invalid id, counts it, and falls back to the window', () => {
    const bad = delivery({ event: 'pre_tool_use', detail: 'Bash', identity: 'bad\u0001id' });
    expect(classifyAgentEventDelivery(bad)).toEqual({ duplicate: false });
    expect(classifyAgentEventDelivery({ ...bad, at: T0 + 1 })).toEqual({
      duplicate: true,
      by: 'time-window',
    });
    const counts = getAgentEventDropCounts(WT, 'opencode');
    expect(counts.idsDiscarded).toBe(2);
    expect(counts.dedupDropped.timeWindow).toBe(1);
  });

  it('uses the time window when the source declares no identity', () => {
    const push = delivery({ cliToolId: 'claude', identityKind: null, identity: null, event: 'stop', detail: null });
    expect(classifyAgentEventDelivery(push)).toEqual({ duplicate: false });
    expect(classifyAgentEventDelivery({ ...push, at: T0 + 1 })).toEqual({
      duplicate: true,
      by: 'time-window',
    });
  });
});

describe('drop counts and bounds', () => {
  it('hands out a copy of the tally, and a zeroed one for an unknown instance', () => {
    dropsFor(`${WT}:x`).decisionEvicted += 1;
    expect(getAgentEventDropCounts('nobody', 'claude')).toEqual({
      dedupDropped: { identity: 0, timeWindow: 0 },
      decisionEvicted: 0,
      idsDiscarded: 0,
      dialogTimedOut: 0,
      decisionOverflow: 0,
    });
  });

  it('trims the oldest entries until the map fits', () => {
    const entries = new Map<string, number>([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    trimOldestEntries(entries, 2);
    expect([...entries.keys()]).toEqual(['b', 'c']);
    expect(MAX_RECENT_EVENT_KEYS).toBe(512);
  });

  it('tags a session id with 8 hex characters, deterministically', () => {
    expect(shortSessionTag('session-a')).toMatch(/^[0-9a-f]{8}$/);
    expect(shortSessionTag('session-a')).toBe(shortSessionTag('session-a'));
    expect(shortSessionTag('session-a')).not.toBe(shortSessionTag('session-b'));
  });
});
