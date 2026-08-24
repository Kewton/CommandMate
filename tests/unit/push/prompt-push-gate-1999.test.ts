/**
 * The Auto-Yes gate on prompt push notifications (Issue #1999) — the decision
 * itself, in isolation from the two producers that ask it.
 *
 * State is set up through the ordinary public API (`setAutoYesEnabled` /
 * `disableAutoYes` / `recordPolicySuppression`) rather than by writing the maps
 * directly, so what is pinned here is the behaviour a running server produces
 * and not a hand-built shape that could drift from it. That matters most for
 * the expiry row: `getAutoYesState` disables an expired state itself, and a
 * test that fabricated `{ enabled: true, expiresAt: <past> }` would be
 * asserting on a state the system cannot actually be in.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearAllAutoYesStates,
  disableAutoYes,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import {
  clearPolicySuppressions,
  recordPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { decidePromptPush } from '@/lib/push/prompt-push-gate';

const WT = 'wt-1999';
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

/** The wait every case below is about, unless it says otherwise. */
function wait(overrides: Record<string, unknown> = {}) {
  return {
    worktreeId: WT,
    cliToolId: 'claude' as const,
    waitingSince: T0,
    ...overrides,
  };
}

beforeEach(() => {
  clearAllAutoYesStates();
  clearPolicySuppressions();
});

afterEach(() => {
  vi.useRealTimers();
  clearAllAutoYesStates();
  clearPolicySuppressions();
});

describe('Auto-Yes is answering: the one case that stays quiet', () => {
  it('suppresses the notification for an enabled instance', () => {
    setAutoYesEnabled(WT, 'claude', true);

    expect(decidePromptPush(wait())).toEqual({
      suppress: true,
      reason: 'auto-yes-answering',
    });
  });

  it('suppresses per instance, not per worktree', () => {
    setAutoYesEnabled(WT, 'claude', true, undefined, undefined, 'claude-2');

    expect(decidePromptPush(wait({ instanceId: 'claude-2' })).suppress).toBe(true);
    // The primary instance of the same worktree never asked for Auto-Yes.
    expect(decidePromptPush(wait()).suppress).toBe(false);
  });
});

describe('Auto-Yes is not answering: every one of these still notifies', () => {
  it('notifies when the session has no Auto-Yes state at all', () => {
    expect(decidePromptPush(wait())).toEqual({
      suppress: false,
      reason: 'auto-yes-inactive',
      stopReason: undefined,
    });
  });

  it('notifies after a manual disable', () => {
    setAutoYesEnabled(WT, 'claude', true);
    setAutoYesEnabled(WT, 'claude', false);

    expect(decidePromptPush(wait()).suppress).toBe(false);
  });

  it('notifies once the duration has run out', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    setAutoYesEnabled(WT, 'claude', true, HOUR);
    expect(decidePromptPush(wait()).suppress).toBe(true);

    vi.setSystemTime(T0 + HOUR);

    // `getAutoYesState` collapses expiry into `enabled: false` on the way out,
    // which is why the gate needs no expiry branch of its own.
    expect(decidePromptPush(wait())).toEqual({
      suppress: false,
      reason: 'auto-yes-inactive',
      stopReason: 'expired',
    });
  });

  it.each(['stop_pattern_matched', 'consecutive_errors'] as const)(
    'notifies after Auto-Yes stopped itself (%s)',
    (stopReason) => {
      setAutoYesEnabled(WT, 'claude', true);
      disableAutoYes(WT, 'claude', stopReason);

      expect(decidePromptPush(wait())).toEqual({
        suppress: false,
        reason: 'auto-yes-inactive',
        stopReason,
      });
    }
  );

  it('notifies when the contract policy withheld the answer to this wait', () => {
    setAutoYesEnabled(WT, 'claude', true);
    recordPolicySuppression(
      WT,
      'claude',
      undefined,
      { reason: 'deny-pattern', mode: 'safe', promptType: 'approval', pattern: 'rm -rf' },
      T0 + 2_000
    );

    expect(decidePromptPush(wait())).toEqual({
      suppress: false,
      reason: 'policy-withheld',
      suppressedBy: 'deny-pattern',
    });
  });

  it('accepts a suppression recorded on the very edge the wait opened', () => {
    // `at === since`: the record belongs to this wait, not the previous one.
    setAutoYesEnabled(WT, 'claude', true);
    recordPolicySuppression(
      WT,
      'claude',
      undefined,
      { reason: 'mode-off', mode: 'off', promptType: 'yes_no' },
      T0
    );

    expect(decidePromptPush(wait()).reason).toBe('policy-withheld');
  });
});

describe('a suppression record from an earlier wait is not this wait', () => {
  it('ignores a record older than the episode and stays quiet', () => {
    // The record is never cleared, so without the `at >= since` reading a single
    // historical suppression would un-mute the session for good.
    setAutoYesEnabled(WT, 'claude', true);
    recordPolicySuppression(
      WT,
      'claude',
      undefined,
      { reason: 'type-not-allowed', mode: 'allow-listed', promptType: 'input' },
      T0 - 1
    );

    expect(decidePromptPush(wait())).toEqual({
      suppress: true,
      reason: 'auto-yes-answering',
    });
  });

  it('reads the record of the instance that is waiting', () => {
    setAutoYesEnabled(WT, 'claude', true);
    setAutoYesEnabled(WT, 'claude', true, undefined, undefined, 'claude-2');
    recordPolicySuppression(
      WT,
      'claude',
      'claude-2',
      { reason: 'deny-pattern', mode: 'safe', promptType: 'approval' },
      T0 + 1
    );

    expect(decidePromptPush(wait({ instanceId: 'claude-2' })).reason).toBe('policy-withheld');
    expect(decidePromptPush(wait()).reason).toBe('auto-yes-answering');
  });
});

describe('the escalation reminder is never muted', () => {
  it('lets the reminder through even while Auto-Yes is enabled', () => {
    // A wait that reached the threshold is one Auto-Yes did not resolve in ten
    // minutes of re-evaluating it, and the suppression record cannot be relied
    // on to say so: a prompt the resolver has no answer for records nothing.
    setAutoYesEnabled(WT, 'claude', true);

    expect(decidePromptPush(wait({ escalated: true }))).toEqual({
      suppress: false,
      reason: 'escalation-reminder',
    });
  });

  it('still names the policy when there is one to name', () => {
    setAutoYesEnabled(WT, 'claude', true);
    recordPolicySuppression(
      WT,
      'claude',
      undefined,
      { reason: 'deny-pattern-unusable', mode: 'safe', promptType: 'approval' },
      T0 + 5
    );

    expect(decidePromptPush(wait({ escalated: true })).reason).toBe('policy-withheld');
  });
});
