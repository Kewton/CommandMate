/**
 * Issue #3791 (item 1): the Auto-Yes hold lasts until the poller's pending tick.
 *
 * The 9 s grace assumed the next tick is at most a cooldown away. A poller in
 * error backoff ticks later, and that tick still answers, so before #3791 a
 * wait in the answering flow notified once at 9 s. The hold now also reaches
 * the tick the poller had scheduled when the hold began (`nextPollAt`) plus two
 * ticks — that tick only, read once, so a wait Auto-Yes does not answer still
 * notifies instead of being held for every later tick.
 *
 * Positive controls fail on the pre-#3791 gate (they notify at 9 s); negative
 * controls hold the 9 s behaviour where the tick is near. Scaffold as in
 * `waiting-push-answer-grace-3757.test.ts`: real database, only `web-push` stubbed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { upsertPushSubscription } from '@/lib/db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { AutoYesPollerState } from '@/lib/auto-yes-poller';
import {
  AUTO_YES_ANSWER_AFTER_TICK_MS,
  AUTO_YES_ANSWER_GRACE_MS,
  AUTO_YES_HOLD_LIMIT_MS,
  autoYesHoldEndsAt,
  clearAutoYesHolds,
  decideAndLogPromptPush,
  isPromptPushSuppressed,
} from '@/lib/push/prompt-push-gate';
import { MAX_BACKOFF_MS, POLLING_INTERVAL_MS } from '@/lib/auto-yes-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import {
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3791';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

/** Let the fire-and-forget fan-out reach `web-push`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function payloads(): Array<Record<string, unknown>> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as Record<string, unknown>
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-3791', '/tmp/repo', 'repo', T0);
  upsertPushSubscription(db, { endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a', locale: 'en' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  setVapidDetails.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });

  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  stopWaitingPushNotifier();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });

  startWaitingPushNotifier();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  vi.useRealTimers();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Open the wait this file is about. */
function startWaiting(instanceId?: string, now = T0): void {
  observeWaitingEdge({
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId,
    waiting: true,
    kind: 'prompt',
    now,
  });
}

/**
 * The Auto-Yes poller's pending tick, as the poller keeps it on `globalThis`
 * (`nextPollAt`), for the default instance of this worktree. Null: no poller.
 */
function pollerTickDueAt(at: number | null): void {
  const states = (globalThis.__autoYesPollerStates ??= new Map<string, AutoYesPollerState>());
  const key = buildCompositeKey(WT, 'claude');
  if (at === null) states.delete(key);
  else states.set(key, { lastServerResponseTimestamp: null, nextPollAt: at } as AutoYesPollerState);
}

/** A tick a backoff away: 30 s, well past the 9 s grace. */
const BACKOFF_TICK = 30_000;

describe('[#3791] the hold reaches the poller tick that will see the wait', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    clearAutoYesHolds();
    pollerTickDueAt(null);
  });

  afterEach(() => {
    clearAutoYesHolds();
    pollerTickDueAt(null);
  });

  it('the limits: two ticks after the tick, a full backoff at most', () => {
    expect(AUTO_YES_ANSWER_AFTER_TICK_MS).toBe(2 * POLLING_INTERVAL_MS);
    expect(AUTO_YES_HOLD_LIMIT_MS).toBe(MAX_BACKOFF_MS + 2 * POLLING_INTERVAL_MS);
  });

  it('positive: in backoff, a wait the poller answers on its late tick sends nothing', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    pollerTickDueAt(T0 + BACKOFF_TICK);

    startWaiting();
    await flush();
    // Past the 9 s grace: before #3791 this was the one false notification.
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS + 1_000);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    // The late tick answers: the wait closes.
    await vi.advanceTimersByTimeAsync(BACKOFF_TICK - AUTO_YES_ANSWER_GRACE_MS - 1_000);
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: Date.now() });

    await vi.advanceTimersByTimeAsync(AUTO_YES_HOLD_LIMIT_MS);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('positive: the late tick did not answer either — it notifies two ticks after that tick, once', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    pollerTickDueAt(T0 + BACKOFF_TICK);

    startWaiting();
    await flush();
    await vi.advanceTimersByTimeAsync(BACKOFF_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ kind: 'prompt' });
  });

  it('positive (response-checker path): held past 9 s, then "not answered" after the tick', () => {
    setAutoYesEnabled(WT, 'claude', true);
    pollerTickDueAt(T0 + BACKOFF_TICK);
    const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };

    expect(isPromptPushSuppressed({ ...gate, now: T0 })).toBe(true);
    expect(isPromptPushSuppressed({ ...gate, now: T0 + AUTO_YES_ANSWER_GRACE_MS })).toBe(true);
    expect(decideAndLogPromptPush({ ...gate, now: T0 + BACKOFF_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS }).reason).toBe(
      'auto-yes-not-answered',
    );
  });

  it('negative: a tick within the grace leaves the 9 s hold as it was', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    pollerTickDueAt(T0 + POLLING_INTERVAL_MS);

    startWaiting();
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('negative: no poller, or a tick already running (due in the past), is the 9 s hold', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + AUTO_YES_ANSWER_GRACE_MS);

    clearAutoYesHolds();
    pollerTickDueAt(T0 - 1);
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: the tick is read once — a poller that puts it off again does not extend the hold', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    pollerTickDueAt(T0 + POLLING_INTERVAL_MS);

    startWaiting();
    await flush();
    // The tick ran, saw nothing to answer, and backed off further.
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    pollerTickDueAt(Date.now() + MAX_BACKOFF_MS);

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - POLLING_INTERVAL_MS);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('negative: a tick further than a backoff (a clock that jumped) is capped', () => {
    setAutoYesEnabled(WT, 'claude', true);
    pollerTickDueAt(T0 + 10 * MAX_BACKOFF_MS);
    const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + AUTO_YES_HOLD_LIMIT_MS);
  });

  it('negative: Auto-Yes re-enabled inside the episode drops the old poller tick', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const real = Date.now();
    pollerTickDueAt(real + 40_000);
    const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };
    // The hold began 10 s ago, with the old poller's tick 50 s after it.
    expect(autoYesHoldEndsAt(gate, real - 10_000)).toBe(real + 40_000 + AUTO_YES_ANSWER_AFTER_TICK_MS);
    // Auto-Yes was (re-)enabled just now (`enabledAt` = real): the grace from then, not the old tick.
    expect(autoYesHoldEndsAt(gate, real + 1)).toBe(real + AUTO_YES_ANSWER_GRACE_MS);
  });
});
