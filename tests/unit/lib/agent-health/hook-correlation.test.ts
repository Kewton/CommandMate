/**
 * Issue #2878: `hook-correlation` from the listener's deliveries. The #2874 /
 * #2891 shape — a hook arriving under another instance — must fail, and so
 * must a hook that never arrives.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateHookCorrelation,
  expectedHookEvents,
  type HookDelivery,
} from '@/lib/agent-health/hook-correlation';

const EXPECT = {
  tool: 'codex',
  worktreeId: 'agent-health-probe',
  instanceId: 'codex-probe',
  expectedEvents: ['session_start', 'user_prompt_submit', 'stop'],
};

function delivery(event: string, overrides: Partial<HookDelivery> = {}): HookDelivery {
  return {
    kind: 'agent-event',
    tool: 'codex',
    event,
    worktreeId: 'agent-health-probe',
    instanceId: 'codex-probe',
    receivedAt: Date.UTC(2026, 8, 27),
    ...overrides,
  };
}

const ALL = [delivery('session_start'), delivery('user_prompt_submit'), delivery('stop')];

describe('evaluateHookCorrelation', () => {
  it('passes when every expected event arrives with both keys', () => {
    const verdict = evaluateHookCorrelation(ALL, EXPECT);
    expect(verdict.status).toBe('pass');
    expect(verdict.evidence).toBeUndefined();
  });

  it('fails on an instanceId mismatch (#2874 / #2891: the shared daemon’s env)', () => {
    const verdict = evaluateHookCorrelation(
      [...ALL.slice(0, 2), delivery('stop', { instanceId: 'codex' })],
      EXPECT
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('instanceId=codex)');
    expect(verdict.evidence).toContain('"instanceId":"codex"');
  });

  it('fails on a worktreeId mismatch', () => {
    const verdict = evaluateHookCorrelation(
      [delivery('session_start', { worktreeId: 'some-real-worktree' }), ...ALL.slice(1)],
      EXPECT
    );
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('worktreeId=some-real-worktree');
  });

  it('fails when a hook arrives without correlation keys (fell back to the bare URL)', () => {
    const verdict = evaluateHookCorrelation(
      [...ALL, delivery('stop', { worktreeId: null, instanceId: null })],
      EXPECT
    );
    expect(verdict.status).toBe('fail');
  });

  it('fails when an expected event never arrives', () => {
    const verdict = evaluateHookCorrelation(ALL.slice(0, 2), EXPECT);
    expect(verdict.status).toBe('fail');
    expect(verdict.summary).toContain('stop が未着');
  });

  it('fails with an explicit note when nothing arrived at all', () => {
    const verdict = evaluateHookCorrelation([], EXPECT);
    expect(verdict.status).toBe('fail');
    expect(verdict.evidence).toContain('何も受け取っていない');
  });

  it('a permission request does not stand in for a lifecycle event', () => {
    const verdict = evaluateHookCorrelation(
      [...ALL.slice(0, 2), delivery('stop', { kind: 'permission-request' })],
      EXPECT
    );
    expect(verdict.status).toBe('fail');
  });

  it('ignores deliveries of other tools', () => {
    const verdict = evaluateHookCorrelation(
      [...ALL, delivery('stop', { tool: 'claude', worktreeId: 'x', instanceId: 'y' })],
      EXPECT
    );
    expect(verdict.status).toBe('pass');
  });
});

describe('expectedHookEvents', () => {
  it('never expects an event outside capabilities.supportedEvents', () => {
    // antigravity: session_start / post_tool_use / stop — no user_prompt_submit.
    expect(expectedHookEvents(['session_start', 'post_tool_use', 'stop'])).toEqual(['session_start', 'stop']);
    expect(expectedHookEvents(['stop', 'notification', 'session_start', 'user_prompt_submit'])).toEqual([
      'session_start',
      'user_prompt_submit',
      'stop',
    ]);
    expect(expectedHookEvents([])).toEqual([]);
  });
});
