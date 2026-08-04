/**
 * Issue #1684: last-policy-suppression record store.
 *
 * The store is what lets `capture --json` explain a policy-stalled worker, so
 * the properties that matter are: per-session isolation (composite keys),
 * last-write-wins refresh, and null for sessions the policy never touched.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPolicySuppression,
  getLastPolicySuppression,
  clearPolicySuppressions,
  type AutoYesPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';

const SUPPRESSION: Omit<AutoYesPolicySuppression, 'at'> = {
  reason: 'type-not-allowed',
  mode: 'safe',
  promptType: 'multiple_choice',
};

beforeEach(() => {
  clearPolicySuppressions();
});

describe('auto-yes-suppression-state', () => {
  it('returns null for a session with no recorded suppression', () => {
    expect(getLastPolicySuppression('wt-a', 'claude')).toBeNull();
  });

  it('returns the recorded suppression with its timestamp', () => {
    recordPolicySuppression('wt-a', 'claude', undefined, SUPPRESSION, 1_000);

    expect(getLastPolicySuppression('wt-a', 'claude')).toEqual({
      ...SUPPRESSION,
      at: 1_000,
    });
  });

  it('defaults the timestamp to now', () => {
    const before = Date.now();
    recordPolicySuppression('wt-a', 'claude', undefined, SUPPRESSION);
    const after = Date.now();

    const record = getLastPolicySuppression('wt-a', 'claude');
    expect(record?.at).toBeGreaterThanOrEqual(before);
    expect(record?.at).toBeLessThanOrEqual(after);
  });

  it('refreshes on re-suppression (last write wins)', () => {
    recordPolicySuppression('wt-a', 'claude', undefined, SUPPRESSION, 1_000);
    recordPolicySuppression(
      'wt-a',
      'claude',
      undefined,
      { reason: 'deny-pattern', mode: 'allow-listed', promptType: 'yes_no', pattern: 'rm -rf' },
      2_000
    );

    expect(getLastPolicySuppression('wt-a', 'claude')).toEqual({
      reason: 'deny-pattern',
      mode: 'allow-listed',
      promptType: 'yes_no',
      pattern: 'rm -rf',
      at: 2_000,
    });
  });

  it('keeps sessions independent: worktree, tool, and instance are all part of the key', () => {
    recordPolicySuppression('wt-a', 'claude', undefined, SUPPRESSION, 1_000);

    expect(getLastPolicySuppression('wt-b', 'claude')).toBeNull();
    expect(getLastPolicySuppression('wt-a', 'codex')).toBeNull();
    expect(getLastPolicySuppression('wt-a', 'claude', 'claude-2')).toBeNull();
  });

  it('treats the primary instance id as equivalent to omitting it (2-part key compat)', () => {
    recordPolicySuppression('wt-a', 'claude', 'claude', SUPPRESSION, 1_000);

    expect(getLastPolicySuppression('wt-a', 'claude')?.at).toBe(1_000);
  });
});
