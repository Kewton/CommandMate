/**
 * Producer 2 of 2 (Issue #1999): the waiting-edge notifier.
 *
 * Driven the way #1790's own suite is — a real in-memory database with only
 * `web-push` stubbed — because the property under test is whether a
 * notification *leaves the process*, and a spied `notifyPushSubscribers` would
 * pass with the gate wired to the wrong producer. `tests/integration/
 * auto-yes-prompt-push-suppression-1999.test.ts` covers the other producer
 * (`response-checker`); a gate added to only one of them fails one of the two.
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
import {
  clearPolicySuppressions,
  recordPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import {
  pendingEscalationCount,
  runEscalationTick,
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-1999';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const MINUTE = 60_000;
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
  ).run(WT, 'feature-x', '/tmp/wt-1999', '/tmp/repo', 'repo', T0);
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

describe('a worktree running under Auto-Yes does not buzz the phone', () => {
  it('sends nothing for a prompt Auto-Yes is about to answer', async () => {
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting();
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('still tracks the wait, so the reminder survives the suppression', async () => {
    // The gate drops the notification only. Removing the wait from `pending`
    // instead would discard the escalation that makes the whole thing safe.
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting();
    await flush();

    expect(pendingEscalationCount()).toBe(1);
  });

  it('suppresses only the instance that has Auto-Yes on', async () => {
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting();
    startWaiting('claude-2', T0 + 1_000);
    await flush();

    expect(payloads().map((p) => p.title)).toEqual(['feature-x (claude-2)']);
  });
});

describe('Auto-Yes off: not one byte of the old behaviour changes', () => {
  it('sends the same notification it sent before the gate existed', async () => {
    startWaiting();
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(payloads()[0]).toMatchObject({
      kind: 'prompt',
      title: 'feature-x (claude)',
      body: 'Waiting for your reply',
      url: `/worktrees/${WT}`,
      waitingKind: 'prompt',
    });
  });

  it('sends once Auto-Yes has been switched back off', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    setAutoYesEnabled(WT, 'claude', false);

    startWaiting();
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});

describe('the cases where a human is still needed', () => {
  it('notifies immediately when the policy already withheld this answer', async () => {
    setAutoYesEnabled(WT, 'claude', true);
    recordPolicySuppression(
      WT,
      'claude',
      undefined,
      { reason: 'deny-pattern', mode: 'safe', promptType: 'approval', pattern: 'force-push' },
      T0
    );

    startWaiting();
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('reminds after the threshold even though Auto-Yes is still enabled', async () => {
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting();
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    runEscalationTick(T0 + 9 * MINUTE);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    runEscalationTick(T0 + 11 * MINUTE);
    await flush();
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({ body: 'Still waiting for your reply (11 min)' });
  });

  it('never reminds about a wait Auto-Yes actually answered', async () => {
    // The acceptance criterion's own parenthetical: a resolved wait is dropped
    // by the episode re-read in `runEscalationTick`, so it cannot escalate.
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting();
    await flush();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now: T0 + 4_000 });

    runEscalationTick(T0 + 30 * MINUTE);
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
    expect(pendingEscalationCount()).toBe(0);
  });
});
