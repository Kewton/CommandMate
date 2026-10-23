/**
 * Issue #3798 PR 2: the Auto-Yes hold and the suppression record are matched
 * to a wait by its episode id (design `docs/design/issue-3798-waiting-episode.md`
 * §5 and §6.2).
 *
 * The mixed rule: both ids present and equal, or one absent and the `since`s
 * equal, is the same wait. An id-less caller (the response poller today) and
 * the id-bearing notifier share one hold and read #3796's session-wait tick
 * once; a replacement (a new id, possibly on the same `since`) begins a new
 * hold that reads the tick at its own start; a rebind keeps the id and so the
 * hold's end.
 *
 * Positive controls fail on the since-only gate (a second id on the same
 * `since` reused the old hold; a suppression of another episode with a recent
 * `at` was read as this wait's reason). Negative controls keep #3757 / #3791 /
 * #3796 / #1684 as they were for id-less callers.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
let tmpDir: string;

vi.mock('web-push', () => ({
  default: { sendNotification: vi.fn(), setVapidDetails: vi.fn() },
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import {
  buildCompositeKey,
  clearAllAutoYesStates,
  MAX_BACKOFF_MS,
  POLLING_INTERVAL_MS,
  setAutoYesEnabled,
} from '@/lib/auto-yes-state';
import type { AutoYesPollerState } from '@/lib/auto-yes-poller';
import {
  AUTO_YES_ANSWER_AFTER_TICK_MS,
  AUTO_YES_ANSWER_GRACE_MS,
  autoYesHoldEndsAt,
  clearAutoYesHolds,
  decideAndLogPromptPush,
  decidePromptPush,
  forgetAutoYesHold,
  isSameWait,
} from '@/lib/push/prompt-push-gate';
import {
  clearPolicySuppressions,
  recordPolicySuppression,
  type EpisodeScopedPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisodeRecord,
  observeWaitingEdge,
  rebindEpisode,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-gate';
const KEY = buildCompositeKey(WT, 'claude');
const T0 = 1_800_000_000_000;
const SESSION_TICK = MAX_BACKOFF_MS;

function putPoller(fields: Partial<AutoYesPollerState> = {}): AutoYesPollerState {
  const states = (globalThis.__autoYesPollerStates ??= new Map<string, AutoYesPollerState>());
  const state = {
    lastServerResponseTimestamp: null,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    ...fields,
  } as AutoYesPollerState;
  states.set(KEY, state);
  return state;
}

function dropPoller(): void {
  globalThis.__autoYesPollerStates?.delete(KEY);
}

/** A suppression record that names its episode, as PR 3's writer will. */
function recordSuppression(at: number, episodeId?: string): void {
  const record: Omit<EpisodeScopedPolicySuppression, 'at'> = {
    reason: 'deny-pattern',
    mode: null,
    promptType: 'yes_no',
    ...(episodeId !== undefined ? { episodeId } : {}),
  };
  recordPolicySuppression(WT, 'claude', undefined, record, at);
}

const base = { worktreeId: WT, cliToolId: 'claude' as const };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3798-gate-'));
  db = new Database(path.join(tmpDir, 'db.sqlite'));
  runMigrations(db);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  clearAutoYesHolds();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  dropPoller();
  setAutoYesEnabled(WT, 'claude', true);
});

afterEach(() => {
  clearAutoYesHolds();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  dropPoller();
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('[#3798] isSameWait: the mixed rule', () => {
  it('compares ids when both have one, and since otherwise', () => {
    expect(isSameWait({ since: 1, episodeId: 'a' }, { since: 2, episodeId: 'a' })).toBe(true);
    expect(isSameWait({ since: 1, episodeId: 'a' }, { since: 1, episodeId: 'b' })).toBe(false);
    expect(isSameWait({ since: 1 }, { since: 1, episodeId: 'b' })).toBe(true);
    expect(isSameWait({ since: 1, episodeId: null }, { since: 2, episodeId: 'b' })).toBe(false);
    expect(isSameWait({ since: 1 }, { since: 1 })).toBe(true);
  });
});

describe('[#3798] the hold is the episode', () => {
  it('mixed: an id-less gate then an id-bearing gate on the same since make one hold and read the session-wait tick once', () => {
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    // The response poller asks first, without an id.
    expect(decideAndLogPromptPush({ ...base, waitingSince: T0, now: T0 }).reason).toBe('auto-yes-answering');
    // The tick moves out later; a hold reading it again would follow.
    poller.sessionWaitTickAt = T0 + 2 * SESSION_TICK;
    // The notifier asks about the same wait with its id: same hold, same end.
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-a' }, T0 + 1_000)).toBe(
      T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS
    );
    // ...and the hold is now named: an id-less ask on the same since still shares it.
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0 }, T0 + 2_000)).toBe(
      T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS
    );
  });

  it('rebind keeps the hold end; replaced starts a new hold that reads the tick at its own start', () => {
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    observeWaitingEdge({ ...base, waiting: true, kind: 'prompt', now: T0 });
    const opened = getWaitingEpisodeRecord(WT, 'claude')!;
    const first = { ...base, waitingSince: opened.since, waitingEpisodeId: opened.episodeId };
    expect(autoYesHoldEndsAt(first, T0)).toBe(T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);

    // Rebind: the id stays, so the hold and its end stay.
    expect(
      rebindEpisode({ worktreeId: WT, cliToolId: 'claude' }, opened.episodeId, {
        kind: 'turn',
        generation: { kind: 'none' },
        turnId: 'turn-1',
      }, T0 + 1_000)
    ).toBe(true);
    const rebound = getWaitingEpisodeRecord(WT, 'claude')!;
    expect(rebound.episodeId).toBe(opened.episodeId);
    poller.sessionWaitTickAt = T0 + 5_000 + SESSION_TICK;
    expect(autoYesHoldEndsAt({ ...first, waitingEpisodeId: rebound.episodeId }, T0 + 5_000)).toBe(
      T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS
    );

    // Replaced on the SAME since: a new id is a new hold, reading the tick now
    // pending (positive control: the since-only gate kept the first hold).
    const replacedAt = T0 + 20_000;
    poller.sessionWaitTickAt = replacedAt + 3_000;
    expect(autoYesHoldEndsAt({ ...first, waitingEpisodeId: 'wep-replacement' }, replacedAt)).toBe(
      replacedAt + AUTO_YES_ANSWER_GRACE_MS
    );
    poller.sessionWaitTickAt = replacedAt + SESSION_TICK;
    const second = autoYesHoldEndsAt({ ...first, waitingEpisodeId: 'wep-replacement-2' }, replacedAt + 1_000);
    expect(second).toBe(replacedAt + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);
  });

  it('positive: two ids on one since are two holds, each from its own first ask', () => {
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-1' }, T0)).toBe(
      T0 + AUTO_YES_ANSWER_GRACE_MS
    );
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-2' }, T0 + 4_000)).toBe(
      T0 + 4_000 + AUTO_YES_ANSWER_GRACE_MS
    );
  });

  it('negative: one id across a different since (a rebind cannot move since, but the id decides) is one hold', () => {
    autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-1' }, T0);
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0 + 1, waitingEpisodeId: 'wep-1' }, T0 + 4_000)).toBe(
      T0 + AUTO_YES_ANSWER_GRACE_MS
    );
  });

  it('negative: id-less callers keep the since-only hold of #3757', () => {
    autoYesHoldEndsAt({ ...base, waitingSince: T0 }, T0);
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0 }, T0 + 4_000)).toBe(T0 + AUTO_YES_ANSWER_GRACE_MS);
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0 + 10 }, T0 + 4_000)).toBe(
      T0 + 4_000 + AUTO_YES_ANSWER_GRACE_MS
    );
  });

  it('wake → capture failure → reschedule with a rebind in between does not extend the hold', () => {
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    observeWaitingEdge({ ...base, waiting: true, kind: 'prompt', now: T0 });
    const opened = getWaitingEpisodeRecord(WT, 'claude')!;
    const ask = { ...base, waitingSince: opened.since, waitingEpisodeId: opened.episodeId };
    expect(autoYesHoldEndsAt(ask, T0)).toBe(T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);

    // Woken: the session was created, the tick comes at 10 s.
    poller.sessionWaitTickAt = T0 + 10_000;
    expect(autoYesHoldEndsAt(ask, T0 + 1_000)).toBe(T0 + 10_000 + AUTO_YES_ANSWER_AFTER_TICK_MS);
    // The 10 s tick's capture failed.
    poller.sessionWaitTickAt = undefined;
    // A rebind in between (the turn's post_tool_use arrived).
    rebindEpisode({ worktreeId: WT, cliToolId: 'claude' }, opened.episodeId, {
      kind: 'turn',
      generation: { kind: 'none' },
      turnId: 'turn-7',
    }, T0 + 11_000);
    // Rescheduled a backoff away.
    poller.sessionWaitTickAt = T0 + 12_000 + SESSION_TICK;
    const rebound = getWaitingEpisodeRecord(WT, 'claude')!;
    expect(autoYesHoldEndsAt({ ...ask, waitingEpisodeId: rebound.episodeId }, T0 + 12_000)).toBe(
      T0 + 10_000 + AUTO_YES_ANSWER_AFTER_TICK_MS
    );
  });
});

describe('[#3798] forgetAutoYesHold by episode', () => {
  it('drops the hold of the named episode only', () => {
    autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-new' }, T0);
    forgetAutoYesHold(KEY, { since: T0, episodeId: 'wep-old' });
    // Still the same hold: its end did not move.
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-new' }, T0 + 3_000)).toBe(
      T0 + AUTO_YES_ANSWER_GRACE_MS
    );
    forgetAutoYesHold(KEY, { since: T0, episodeId: 'wep-new' });
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-new' }, T0 + 3_000)).toBe(
      T0 + 3_000 + AUTO_YES_ANSWER_GRACE_MS
    );
  });

  it('negative: a number still means since (#3776)', () => {
    autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-a' }, T0);
    forgetAutoYesHold(KEY, T0 + 1);
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-a' }, T0 + 3_000)).toBe(
      T0 + AUTO_YES_ANSWER_GRACE_MS
    );
    forgetAutoYesHold(KEY, T0);
    expect(autoYesHoldEndsAt({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-a' }, T0 + 3_000)).toBe(
      T0 + 3_000 + AUTO_YES_ANSWER_GRACE_MS
    );
  });
});

describe('[#3798] the suppression record belongs to a wait', () => {
  it('suppression with episodeId matches by id; without it by at >= since', () => {
    // An earlier episode's record, refreshed after this wait began.
    recordSuppression(T0 + 5_000, 'wep-old');
    // Positive control: by time alone it read as this wait's reason.
    expect(decidePromptPush({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-now' }).reason).toBe(
      'auto-yes-answering'
    );
    // This wait's record, whatever its time.
    recordSuppression(T0 - 5_000, 'wep-now');
    expect(decidePromptPush({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-now' }).reason).toBe(
      'policy-withheld'
    );

    // Either side without an id: #1684's `at >= waitingSince`.
    recordSuppression(T0 + 1, 'wep-other');
    expect(decidePromptPush({ ...base, waitingSince: T0 }).reason).toBe('policy-withheld');
    recordSuppression(T0 + 1);
    expect(decidePromptPush({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-now' }).reason).toBe(
      'policy-withheld'
    );
    recordSuppression(T0 - 1);
    expect(decidePromptPush({ ...base, waitingSince: T0, waitingEpisodeId: 'wep-now' }).reason).toBe(
      'auto-yes-answering'
    );
  });
});
