/**
 * Issue #3796 item 3: the Auto-Yes hold follows the session wait's tick when
 * the session's creation brings that tick forward.
 *
 * #3791 read the tick once, when the hold began, so a wait opened while the
 * poller waited `MAX_BACKOFF_MS` for its session was held until that tick plus
 * two ticks (~64 s) even after the session appeared and the poller had ticked.
 * The hold now ends two ticks after the tick that really ran
 * (`sessionAppearedAt`) or is due (`sessionWaitTickAt`, rescheduled earlier) —
 * never later than #3791's.
 *
 * Positive controls fail on the #3791 gate (held to ~64 s); negative controls
 * keep #3791's behaviour. Scaffold as in prompt-push-gate-next-tick-3791.test.ts.
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

const WT = 'wt-3796';
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
  ).run(WT, 'feature-x', '/tmp/wt-3796', '/tmp/repo', 'repo', T0);
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

/** The session wait's tick: a backoff away, as the poller schedules it. */
const SESSION_TICK = MAX_BACKOFF_MS;
const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };

describe('[#3796] the hold follows a session-wait tick brought forward', () => {
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

  it('positive: the tick ran early (session created) — the hold ends at the 9 s grace, not a backoff later', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);

    // Woken at 1 s, ticked at 3 s and found the session.
    poller.sessionWaitTickAt = undefined;
    poller.sessionAppearedAt = T0 + 3_000;
    expect(autoYesHoldEndsAt(gate, T0 + 3_000)).toBe(T0 + AUTO_YES_ANSWER_GRACE_MS);
    expect(decideAndLogPromptPush({ ...gate, now: T0 + AUTO_YES_ANSWER_GRACE_MS }).reason).toBe('auto-yes-not-answered');
  });

  it('positive: the woken tick still pending — the hold ends two ticks after it', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    autoYesHoldEndsAt(gate, T0);
    poller.sessionWaitTickAt = T0 + 10_000;
    expect(autoYesHoldEndsAt(gate, T0 + 8_000)).toBe(T0 + 10_000 + AUTO_YES_ANSWER_AFTER_TICK_MS);
  });

  it('positive (notifier): the session appeared at 3 s — notified when the 9 s grace ends', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    startWaiting();
    await flush();

    await vi.advanceTimersByTimeAsync(3_000);
    poller.sessionWaitTickAt = undefined;
    poller.sessionAppearedAt = T0 + 3_000;

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 3_000 - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    // Before #3796: held until 64 s.
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ kind: 'prompt' });
  });

  it('negative: a session that appeared before the hold began does not shorten it', () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + SESSION_TICK, sessionAppearedAt: T0 - 1 });
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);
  });

  it('negative: a session wait rescheduled later does not extend the hold', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    autoYesHoldEndsAt(gate, T0);
    poller.sessionWaitTickAt = T0 + 2 * SESSION_TICK;
    expect(autoYesHoldEndsAt(gate, T0 + 5_000)).toBe(T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);
  });

  it('negative: a poller replaced meanwhile ends the hold at the grace, as in #3791', () => {
    setAutoYesEnabled(WT, 'claude', true);
    putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    autoYesHoldEndsAt(gate, T0);
    putPoller({ sessionAppearedAt: T0 + 30_000 });
    expect(autoYesHoldEndsAt(gate, T0 + 30_000)).toBe(T0 + AUTO_YES_ANSWER_GRACE_MS);
  });
});

describe('[#3796 review B] an earlier tick once adopted stays on the hold', () => {
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

  it('negative: woken to 10 s, then that tick fails and schedules an ordinary one — the end stays at 10 s + two ticks', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    expect(autoYesHoldEndsAt(gate, T0)).toBe(T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);

    poller.sessionWaitTickAt = T0 + 10_000;
    expect(autoYesHoldEndsAt(gate, T0 + 1_000)).toBe(T0 + 10_000 + AUTO_YES_ANSWER_AFTER_TICK_MS);

    // The 10 s tick's capture failed: an error backoff, no session-wait tick
    // pending and no session seen. Before the review fix the end went back to 64 s.
    poller.sessionWaitTickAt = undefined;
    expect(autoYesHoldEndsAt(gate, T0 + 11_000)).toBe(T0 + 10_000 + AUTO_YES_ANSWER_AFTER_TICK_MS);
    // ... nor does a session wait scheduled again move it out.
    poller.sessionWaitTickAt = T0 + 11_000 + SESSION_TICK;
    expect(autoYesHoldEndsAt(gate, T0 + 12_000)).toBe(T0 + 10_000 + AUTO_YES_ANSWER_AFTER_TICK_MS);
  });

  it('negative: the woken tick ran (and failed) before the gate was asked again — its start counts', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    autoYesHoldEndsAt(gate, T0);
    poller.sessionWaitTickAt = undefined;
    poller.sessionWaitTickRanAt = T0 + 10_000;
    expect(autoYesHoldEndsAt(gate, T0 + 11_000)).toBe(T0 + 10_000 + AUTO_YES_ANSWER_AFTER_TICK_MS);
  });

  it('positive: nothing brought forward — the tick read when the hold began, as in #3791', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const poller = putPoller({ sessionWaitTickAt: T0 + SESSION_TICK });
    autoYesHoldEndsAt(gate, T0);
    poller.sessionWaitTickRanAt = T0 - 1; // a session-wait tick before the hold began
    expect(autoYesHoldEndsAt(gate, T0 + 5_000)).toBe(T0 + SESSION_TICK + AUTO_YES_ANSWER_AFTER_TICK_MS);
  });
});
