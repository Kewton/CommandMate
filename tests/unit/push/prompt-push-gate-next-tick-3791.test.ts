/**
 * Issue #3791 (item 1): the Auto-Yes hold lasts until the session wait's tick.
 *
 * The 9 s grace assumed the next tick is at most a cooldown away. A poller
 * waiting for its session ticks `MAX_BACKOFF_MS` later, and a session started
 * meanwhile gets its first prompt answered on that tick, so before #3791 such a
 * wait notified once at 9 s. The hold now also reaches that tick
 * (`sessionWaitTickAt`, read once when the hold begins) plus two ticks, while
 * the poller that scheduled it still runs. An error backoff is not waited for:
 * a failing Auto-Yes notifies at 9 s as before.
 *
 * Positive controls fail on the pre-#3791 gate (they notify at 9 s); negative
 * controls hold the 9 s behaviour. Scaffold as in
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
 * Put an Auto-Yes poller state under the default instance of this worktree, as
 * the poller keeps it on `globalThis`, and return it (its identity is what the
 * gate checks). `sessionWaitTickAt` is the session wait's pending tick.
 */
function putPoller(fields: Partial<AutoYesPollerState> = {}): AutoYesPollerState {
  const states = (globalThis.__autoYesPollerStates ??= new Map<string, AutoYesPollerState>());
  const state = { lastServerResponseTimestamp: null, consecutiveErrors: 0, currentInterval: POLLING_INTERVAL_MS, ...fields } as AutoYesPollerState;
  states.set(buildCompositeKey(WT, 'claude'), state);
  return state;
}

function dropPoller(): void {
  globalThis.__autoYesPollerStates?.delete(buildCompositeKey(WT, 'claude'));
}

/** The session wait's tick: 30 s away, well past the 9 s grace. */
const SESSION_TICK = 30_000;
const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };

describe('[#3791] the hold reaches the session wait\'s tick', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    clearAutoYesHolds();
    dropPoller();
  });

  afterEach(() => {
    clearAutoYesHolds();
    dropPoller();
  });

  it('two ticks after the tick', () => {
    expect(AUTO_YES_ANSWER_AFTER_TICK_MS).toBe(2 * POLLING_INTERVAL_MS);
  });

  it('positive: a wait the poller answers on its session-wait tick sends nothing', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });

    startWaiting();
    await flush();
    // Past the 9 s grace: before #3791 this was the one false notification.
    await vi.advanceTimersByTimeAsync(SESSION_TICK - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    // The tick answers: the wait closes.
    await vi.advanceTimersByTimeAsync(1);
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: Date.now() });
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('positive: the tick did not answer either — it notifies two ticks after that tick, once', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });

    startWaiting();
    await flush();
    await vi.advanceTimersByTimeAsync(SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ kind: 'prompt' });
  });

  it('positive (response-checker path): held past 9 s, then "not answered" after the tick', () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });

    expect(isPromptPushSuppressed({ ...gate, now: T0 })).toBe(true);
    expect(isPromptPushSuppressed({ ...gate, now: T0 + AUTO_YES_ANSWER_GRACE_MS })).toBe(true);
    expect(decideAndLogPromptPush({ ...gate, now: T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS }).reason).toBe(
      'auto-yes-not-answered',
    );
  });

  it('positive: Auto-Yes enabled again while on (same poller) keeps the tick', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    startWaiting();
    await flush();

    // Enabled again 5 s in: `enabledAt` moves, the poller is `already_running`.
    await vi.advanceTimersByTimeAsync(5_000);
    setAutoYesEnabled(WT, 'claude', true);

    await vi.advanceTimersByTimeAsync(SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS - 5_000 - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('negative: an error backoff is not waited for — it notifies at 9 s', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    // Failing in a row: the next tick 32 s away, but not the session wait's.
    putPoller({ consecutiveErrors: 7, currentInterval: 32_000 });

    startWaiting();
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('negative: no session-wait tick, or one already running (due in the past), is the 9 s hold', () => {
    setAutoYesEnabled(WT, 'claude', true);
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + AUTO_YES_ANSWER_GRACE_MS);

    clearAutoYesHolds();
    putPoller({ sessionWaitTickAt: T0 - 1 });
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: the tick is read once — a session wait scheduled after the hold began does not extend it', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller();

    startWaiting();
    await flush();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    poller.sessionWaitTickAt = Date.now() + MAX_BACKOFF_MS;

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - POLLING_INTERVAL_MS);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('negative: a tick further than the session wait (a clock that jumped) is capped', () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + 10 * MAX_BACKOFF_MS });
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + MAX_BACKOFF_MS + AUTO_YES_ANSWER_AFTER_TICK_MS);
  });

  it('negative: Auto-Yes off → on (a new poller) drops the old poller\'s tick', () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);

    vi.setSystemTime(T0 + 5_000);
    setAutoYesEnabled(WT, 'claude', false);
    setAutoYesEnabled(WT, 'claude', true);
    putPoller(); // the new poller, first tick a poll interval away
    expect(autoYesHoldEndsAt(gate, T0 + 5_000)).toBe(T0 + 5_000 + AUTO_YES_ANSWER_GRACE_MS);
  });

  it('negative: a poller stopped during the hold ends it at the next grace, not at the tick', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    startWaiting();
    await flush();

    await vi.advanceTimersByTimeAsync(5_000);
    dropPoller();

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 5_000 - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
