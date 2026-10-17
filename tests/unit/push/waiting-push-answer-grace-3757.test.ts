/**
 * Issue #3757 (P2): the waiting-edge notifier asks the Auto-Yes gate again when
 * its `auto-yes-answering` hold ends.
 *
 * The edge fires once. Before #3757 a wait the gate held as "Auto-Yes is
 * answering" was never asked about again, so a screen Auto-Yes could not read
 * (and recorded nothing about) stayed silent until the ten-minute reminder.
 * Scaffold as in `auto-yes-waiting-push-1999.test.ts`: real database, only
 * `web-push` stubbed.
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
  AUTO_YES_ANSWER_GRACE_MS,
  clearAutoYesHolds,
  isPromptPushSuppressed,
} from '@/lib/push/prompt-push-gate';
import {
  clearPolicySuppressions,
  recordPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import {
  pendingEscalationCount,
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3757';
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
  ).run(WT, 'feature-x', '/tmp/wt-3757', '/tmp/repo', 'repo', T0);
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
 * The Auto-Yes poller's last answer, as the poller keeps it on `globalThis`
 * (`lastServerResponseTimestamp`), for the default instance of this worktree.
 */
function pollerAnsweredAt(at: number | null): void {
  const states = (globalThis.__autoYesPollerStates ??= new Map<string, AutoYesPollerState>());
  const key = buildCompositeKey(WT, 'claude');
  if (at === null) states.delete(key);
  else states.set(key, { lastServerResponseTimestamp: at } as AutoYesPollerState);
}

describe('the Auto-Yes hold ends after a cooldown and two poller ticks', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0);
    clearAutoYesHolds();
    pollerAnsweredAt(null);
  });

  afterEach(() => {
    clearAutoYesHolds();
    pollerAnsweredAt(null);
  });

  it('the hold is a cooldown plus two ticks (9 s)', () => {
    expect(AUTO_YES_ANSWER_GRACE_MS).toBe(9_000);
  });

  it('positive: a wait Auto-Yes neither answered nor explained (the trust screen) notifies when the hold ends', async () => {
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting();
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 1);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ kind: 'prompt', body: 'Waiting for your reply' });

    // Once: the episode's one slot is spent, and the reminder is still armed.
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 3);
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(pendingEscalationCount()).toBe(1);
  });

  it("negative (a): a hook's older `structuredSince` does not eat the hold", async () => {
    // The hook said the wait began 5.5 s before the probe opened the edge.
    setAutoYesEnabled(WT, 'claude', true);
    observeWaitingEdge({
      worktreeId: WT,
      cliToolId: 'claude',
      waiting: true,
      kind: 'prompt',
      structuredSince: T0 - 5_500,
      now: T0,
    });
    await flush();

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 1_000);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('negative (b): an answer during the hold (the cooldown after it) restarts the hold', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    startWaiting();
    await flush();

    // The poller answered 5 s in; the next prompt of the episode is a cooldown away.
    await vi.advanceTimersByTimeAsync(5_000);
    pollerAnsweredAt(Date.now());

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS - 1_000);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    // No further answer: a full hold after the last one, it notifies.
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('negative (c): the second prompt of one episode, right after an answer, stays quiet on the response-checker path', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const gate = { worktreeId: WT, cliToolId: 'claude' as const, waitingSince: T0 };

    // First prompt of the episode: held from now.
    expect(isPromptPushSuppressed({ ...gate, now: T0 })).toBe(true);
    // Auto-Yes answered it 20 s later; `since` stays frozen at T0 (no waiting:false between).
    pollerAnsweredAt(T0 + 20_000);
    // The second prompt is read 1 s after that answer: still Auto-Yes's to answer.
    expect(isPromptPushSuppressed({ ...gate, now: T0 + 21_000 })).toBe(true);
    // Unanswered for the whole hold after the answer: notifies.
    expect(isPromptPushSuppressed({ ...gate, now: T0 + 20_000 + AUTO_YES_ANSWER_GRACE_MS })).toBe(false);
  });

  it('negative: a wait Auto-Yes answered inside the hold sends nothing', async () => {
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting();
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS / 2);
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: Date.now() });

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 2);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('negative: a recorded suppression still notifies on the edge, once', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    recordPolicySuppression(
      WT,
      'claude',
      undefined,
      { reason: 'startup-trust-unhandled', mode: null, promptType: 'multiple_choice' },
      T0,
    );

    startWaiting();
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AUTO_YES_ANSWER_GRACE_MS * 2);
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
