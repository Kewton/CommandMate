/**
 * Issue #3311: what the receiver reads after a drop to say how long after the
 * applied delivery it came, and the session id in a form a log line may carry.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import {
  agentEventKeyClaimedAt,
  clearAgentStopEvents,
  isDuplicateAgentEvent,
  shortSessionTag,
} from '@/lib/session/agent-event-state';

afterEach(() => clearAgentStopEvents());

describe('agentEventKeyClaimedAt (Issue #3311)', () => {
  const T = 1_000;

  it('is the receipt time of the applied delivery, which a drop does not move', () => {
    expect(isDuplicateAgentEvent('wt-1', 'claude', 'cc-2', 'user_prompt_submit', 'sess-1', T)).toBe(false);
    expect(isDuplicateAgentEvent('wt-1', 'claude', 'cc-2', 'user_prompt_submit', 'sess-1', T + 6)).toBe(true);
    expect(isDuplicateAgentEvent('wt-1', 'claude', 'cc-2', 'user_prompt_submit', 'sess-1', T + 9)).toBe(true);

    expect(agentEventKeyClaimedAt('wt-1', 'claude', 'cc-2', 'user_prompt_submit', 'sess-1')).toBe(T);
  });

  it('reads the same key the window claims: instance, event, subtype and session', () => {
    isDuplicateAgentEvent('wt-1', 'claude', 'cc-2', 'pre_tool_use', 'sess-1', T, 'Bash');

    expect(agentEventKeyClaimedAt('wt-1', 'claude', 'cc-2', 'pre_tool_use', 'sess-1', 'Bash')).toBe(T);
    expect(agentEventKeyClaimedAt('wt-1', 'claude', 'cc-2', 'pre_tool_use', 'sess-1', 'Read')).toBeNull();
    expect(agentEventKeyClaimedAt('wt-1', 'claude', 'cc-3', 'pre_tool_use', 'sess-1', 'Bash')).toBeNull();
    expect(agentEventKeyClaimedAt('wt-1', 'claude', 'cc-2', 'pre_tool_use', 'sess-2', 'Bash')).toBeNull();
    expect(agentEventKeyClaimedAt('wt-1', 'claude', 'cc-2', 'pre_tool_use', null, 'Bash')).toBeNull();
  });
});

describe('shortSessionTag (Issue #3311)', () => {
  it('is the first 8 hex characters of the SHA-256, never the id itself', () => {
    const id = '0f6a9c1e-3b2d-4e5f-8a7b-123456789abc';
    const tag = shortSessionTag(id);

    expect(tag).toBe(createHash('sha256').update(id).digest('hex').slice(0, 8));
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
    expect(id).not.toContain(tag);
    expect(shortSessionTag('another-session')).not.toBe(tag);
  });
});
