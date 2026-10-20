/**
 * Issue #3776 (review item 4): retiring one waiting episode's Auto-Yes hold
 * must not drop the next episode's.
 *
 * `waiting-push-notifier`'s release of a held wait whose episode had moved on
 * called `forgetAutoYesHold(key)`, which deleted the session's hold whatever
 * episode it belonged to — so a hold the next episode had already started was
 * re-originated at its next ask, and its notification came up to a hold late.
 *
 * Positive control: before #3776 `forgetAutoYesHold` ignored `since` and the
 * first case re-origins at `later`. Negative control: the episode's own hold,
 * and a call without `since` (Auto-Yes went off), still drop it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCompositeKey, clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { autoYesHoldStartedAt, clearAutoYesHolds, forgetAutoYesHold } from '@/lib/push/prompt-push-gate';

const WT = 'wt-3776-hold';
const KEY = buildCompositeKey(WT, 'claude');
// Ahead of the real clock, so `setAutoYesEnabled`'s `enabledAt` never moves an origin.
const T0 = 4_000_000_000_000;
const episodeA = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };
const episodeB = { ...episodeA, waitingSince: T0 + 5_000 };

beforeEach(() => {
  clearAutoYesHolds();
  clearAllAutoYesStates();
  setAutoYesEnabled(WT, 'claude', true);
});
afterEach(() => {
  clearAutoYesHolds();
  clearAllAutoYesStates();
});

describe('[#3776] forgetAutoYesHold(key, since) drops only that episode\'s hold', () => {
  it('positive: retiring episode A keeps episode B\'s origin', () => {
    const heldAt = T0 + 6_000;
    expect(autoYesHoldStartedAt(episodeB, heldAt)).toBe(heldAt);

    forgetAutoYesHold(KEY, episodeA.waitingSince);

    const later = T0 + 9_000;
    expect(autoYesHoldStartedAt(episodeB, later)).toBe(heldAt);
  });

  it('negative control: retiring the episode that holds drops it', () => {
    autoYesHoldStartedAt(episodeB, T0 + 6_000);
    forgetAutoYesHold(KEY, episodeB.waitingSince);
    expect(autoYesHoldStartedAt(episodeB, T0 + 9_000)).toBe(T0 + 9_000);
  });

  it('negative control: without `since` (Auto-Yes went off) the session\'s hold goes', () => {
    autoYesHoldStartedAt(episodeB, T0 + 6_000);
    forgetAutoYesHold(KEY);
    expect(autoYesHoldStartedAt(episodeB, T0 + 9_000)).toBe(T0 + 9_000);
  });
});
