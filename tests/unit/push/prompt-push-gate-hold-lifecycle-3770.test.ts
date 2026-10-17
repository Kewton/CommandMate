/**
 * Issue #3770 (item 2): the Auto-Yes hold of a waiting episode is dropped when
 * Auto-Yes goes off, when the episode closes, and when it is an hour old.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  AUTO_YES_ANSWER_GRACE_MS,
  AUTO_YES_HOLD_MAX_AGE_MS,
  autoYesHoldStartedAt,
  clearAutoYesHolds,
  decideAndLogPromptPush,
  decidePromptPush,
} from '@/lib/push/prompt-push-gate';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';

const WT = 'wt-3770';
const T0 = 1_800_000_000_000;
const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };

beforeEach(() => {
  clearAutoYesHolds();
  clearAllAutoYesStates();
  clearPolicySuppressions();
});
afterEach(() => {
  clearAutoYesHolds();
  clearAllAutoYesStates();
  clearPolicySuppressions();
});

describe('[#3770] off → on inside one episode starts a fresh hold', () => {
  it('positive: the first ask after Auto-Yes came back on is held, not "not answered"', () => {
    const t = Date.now();
    setAutoYesEnabled(WT, 'claude', true);
    expect(decideAndLogPromptPush({ ...gate, now: t }).reason).toBe('auto-yes-answering');

    // Off for longer than the hold (a gate ask while off sees `auto-yes-inactive`).
    setAutoYesEnabled(WT, 'claude', false);
    const offAt = t + AUTO_YES_ANSWER_GRACE_MS + 1;
    expect(decideAndLogPromptPush({ ...gate, now: offAt }).reason).toBe('auto-yes-inactive');

    setAutoYesEnabled(WT, 'claude', true);
    const back = decideAndLogPromptPush({ ...gate, now: offAt + 1 });
    expect(back).toMatchObject({ suppress: true, reason: 'auto-yes-answering' });
  });

  it('positive: also when nothing asked the gate while it was off (enabledAt moves the origin)', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const real = Date.now();
    // The hold began a minute ago, before Auto-Yes was (re-)enabled just now.
    expect(autoYesHoldStartedAt(gate, real - 60_000)).toBe(real - 60_000);
    expect(autoYesHoldStartedAt(gate, real + 1)).toBeGreaterThan(real - 60_000);
  });

  it('negative control: without an off in between, the hold still ends and notifies', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const start = Date.now();
    expect(decideAndLogPromptPush({ ...gate, now: start }).reason).toBe('auto-yes-answering');
    const later = decideAndLogPromptPush({ ...gate, now: start + AUTO_YES_ANSWER_GRACE_MS });
    expect(later.reason).toBe('auto-yes-not-answered');
    expect(decidePromptPush({ ...gate, now: start + AUTO_YES_ANSWER_GRACE_MS, holdStartedAt: start }).suppress).toBe(false);
  });
});

describe('[#3770] holds are swept', () => {
  it('a hold an hour old is dropped by the next ask; a fresh one is kept', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const other = { ...gate, worktreeId: 'wt-3770-other' };
    setAutoYesEnabled(other.worktreeId, 'claude', true);
    autoYesHoldStartedAt(gate, T0);
    autoYesHoldStartedAt(other, T0 + AUTO_YES_HOLD_MAX_AGE_MS - 1);

    // A later ask on `other`: the old one is swept, so asking `gate` again re-origins at the new `now`.
    const now = T0 + AUTO_YES_HOLD_MAX_AGE_MS;
    autoYesHoldStartedAt(other, now);
    expect(autoYesHoldStartedAt(gate, now)).toBe(now);
    // Fresh one kept: its origin did not move.
    expect(autoYesHoldStartedAt(other, now + 1)).toBe(T0 + AUTO_YES_HOLD_MAX_AGE_MS - 1);
  });
});
