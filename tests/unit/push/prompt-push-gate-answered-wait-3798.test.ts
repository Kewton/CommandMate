/**
 * Issue #3798 (review R2): the end of the Auto-Yes hold is not "not answered"
 * for the episode the poller answered (`lastAnswer`) while it is still open
 * and not a screen only a person drives (`docs/design/issue-3798-waiting-episode.md`
 * §6.4).
 *
 * Positive: the answered episode, its hold over, is `auto-yes-answered`
 * (quiet). Negative: another episode (the second confirmation B), a person's
 * screen under the same id, an episode that closed, a caller that names no
 * id, and a poller that answered nothing ring as before; inside the hold, and
 * for the reminder, nothing changes.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCompositeKey, clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { autoYesPollerStates } from '@/lib/polling/auto-yes-poller-generation';
import type { AutoYesPollerState } from '@/lib/polling/auto-yes-poller-state';
import { autoYesAnsweredWait, clearAutoYesHolds, decidePromptPush } from '@/lib/push/prompt-push-gate';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import {
  clearWaitingEpisodes,
  closeEpisode,
  openEpisode,
  rebindEpisode,
  type WaitingEpisodeRecord,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-gate-answered';
const PARTS = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: 'claude' };
const KEY = buildCompositeKey(WT, 'claude', 'claude');
const NOW = 1_800_000_000_000;
const NONE = { kind: 'none' as const };

function openWait(at: number = NOW): WaitingEpisodeRecord {
  return openEpisode(
    PARTS,
    {
      since: at,
      kind: 'prompt',
      binding: { kind: 'unattributed', generation: NONE, lastClosedTurnId: null },
      openedBy: 'status-probe',
    },
    at,
  );
}

function answered(episodeId: string | null): void {
  const state: AutoYesPollerState = {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: NOW,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
    lastAnswer: episodeId === null ? null : { episodeId, screenKey: 'k', at: NOW },
  };
  autoYesPollerStates.set(KEY, state);
}

/** The gate for `wait`, its hold over (or not). */
function decide(wait: { since: number; episodeId?: string | null }, opts: { holdOver?: boolean; escalated?: boolean } = {}) {
  return decidePromptPush({
    ...PARTS,
    waitingSince: wait.since,
    waitingEpisodeId: wait.episodeId,
    now: NOW + 20_000,
    holdEndsAt: opts.holdOver === false ? NOW + 30_000 : NOW + 9_000,
    ...(opts.escalated ? { escalated: true } : {}),
  });
}

beforeEach(() => {
  clearAllAutoYesStates();
  clearAutoYesHolds();
  clearPolicySuppressions();
  clearWaitingEpisodes();
  autoYesPollerStates.delete(KEY);
  setAutoYesEnabled(WT, 'claude', true);
});

afterEach(() => {
  autoYesPollerStates.delete(KEY);
  clearAllAutoYesStates();
  clearAutoYesHolds();
  clearWaitingEpisodes();
});

describe('[#3798] the hold of an answered wait', () => {
  it('positive: the episode the poller answered, still open, its hold over — auto-yes-answered, quiet', () => {
    const a = openWait();
    answered(a.episodeId);
    expect(autoYesAnsweredWait({ ...PARTS, waitingEpisodeId: a.episodeId })).toBe(true);
    expect(decide({ since: a.since, episodeId: a.episodeId })).toEqual({ suppress: true, reason: 'auto-yes-answered' });
  });

  it('negative: another confirmation (episode B) after the answer to A rings at its hold end', () => {
    const a = openWait();
    answered(a.episodeId);
    closeEpisode(PARTS, a.episodeId, 'turn-superseded', NOW + 1);
    const b = openWait(NOW + 1);
    expect(decide({ since: b.since, episodeId: b.episodeId })).toMatchObject({ suppress: false, reason: 'auto-yes-not-answered' });
  });

  it('negative: the answered episode turned into a screen a person drives rings', () => {
    const a = openWait();
    answered(a.episodeId);
    rebindEpisode(PARTS, a.episodeId, { kind: 'screen', generation: NONE, originTurnId: null }, NOW + 1);
    expect(decide({ since: a.since, episodeId: a.episodeId })).toMatchObject({ suppress: false, reason: 'auto-yes-not-answered' });
  });

  it('negative: no id from the caller, an answer to nothing, or the episode gone — as before', () => {
    const a = openWait();
    answered(a.episodeId);
    expect(decide({ since: a.since })).toMatchObject({ reason: 'auto-yes-not-answered' });
    answered(null);
    expect(decide({ since: a.since, episodeId: a.episodeId })).toMatchObject({ reason: 'auto-yes-not-answered' });
    answered(a.episodeId);
    closeEpisode(PARTS, a.episodeId, 'screen-cleared', NOW + 1);
    expect(decide({ since: a.since, episodeId: a.episodeId })).toMatchObject({ reason: 'auto-yes-not-answered' });
  });

  it('negative: inside the hold, and the reminder, are unchanged', () => {
    const a = openWait();
    answered(a.episodeId);
    expect(decide({ since: a.since, episodeId: a.episodeId }, { holdOver: false })).toEqual({
      suppress: true,
      reason: 'auto-yes-answering',
    });
    expect(decide({ since: a.since, episodeId: a.episodeId }, { escalated: true })).toMatchObject({
      suppress: false,
      reason: 'escalation-reminder',
    });
  });
});
