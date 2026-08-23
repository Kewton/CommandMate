/**
 * The server half of the cross-device dismissal (Issue #2001).
 *
 * Driven the way #1790's and #1999's suites are — a real in-memory database
 * with only `web-push` stubbed — because the property under test is whether a
 * resolution payload *leaves the process*, and against which fleet. A spied
 * `notifyPushSubscribers` would pass with the closing edge wired to nothing.
 *
 * The Service Worker half (close-then-show, and the `userVisibleOnly` order it
 * depends on) is `tests/unit/pwa/sw-push.test.ts`; a change to only one side
 * fails one of the two files.
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
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { setPushEscalationSettings } from '@/lib/push/escalation-settings';
import {
  clearAllPromptCards,
  hasPromptCard,
  markPromptCardShown,
  promptCardCount,
} from '@/lib/push/prompt-card-state';
import {
  decidePromptResolution,
  notifyPromptResolved,
  MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR,
} from '@/lib/push/resolution-push-notifier';
import {
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  hasOpenWaitingEpisode,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-2001';
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

function addDevice(suffix: string, locale = 'en'): void {
  upsertPushSubscription(db, {
    endpoint: `https://push.example/${suffix}`,
    p256dh: 'p',
    auth: 'a',
    locale,
  });
}

/** Open a wait for one instance, exactly as the status probe / poller does. */
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

/** Close it again. */
function stopWaiting(instanceId?: string, now = T0 + 5_000): void {
  observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', instanceId, waiting: false, now });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-2001', '/tmp/repo', 'repo', T0);

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
  clearAllPromptCards();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });

  startWaitingPushNotifier();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllPromptCards();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('two devices: answering on one clears the card on the other', () => {
  it('sends exactly one resolution to every subscribed device when the wait ends', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting();
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(2); // the prompt itself
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    for (const payload of payloads()) {
      expect(payload).toMatchObject({
        kind: 'prompt',
        resolved: true,
        // The stale card's own tag. This is the whole mechanism: the Service
        // Worker closes what carries it and shows the replacement under it.
        tag: `${WT}:prompt`,
        title: 'feature-x (claude)',
        body: 'Handled — answered on another device',
        url: `/worktrees/${WT}`,
      });
    }
  });

  it('reaches the endpoints that hold the stale cards, not a subset', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting();
    await flush();
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    const endpoints = sendNotification.mock.calls.map(
      ([subscription]) => (subscription as { endpoint: string }).endpoint
    );
    expect(endpoints.sort()).toEqual([
      'https://push.example/android',
      'https://push.example/iphone',
    ]);
  });

  it('speaks each device’s own language', async () => {
    addDevice('iphone', 'ja');
    addDevice('android', 'en');

    startWaiting();
    await flush();
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    expect(payloads().map((p) => p.body).sort()).toEqual([
      'Handled — answered on another device',
      '対応済みです（他の端末で応答されました）',
    ]);
  });

  it('carries no excerpt of the prompt it is closing', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting();
    await flush();
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    for (const payload of payloads()) {
      expect(payload.body).not.toContain(':');
      expect(payload).not.toHaveProperty('waitingKind');
    }
  });

  it('sends one resolution per wait, not one per closing edge', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting();
    await flush();
    sendNotification.mockClear();

    stopWaiting();
    await flush();
    // A second closing edge for a wait that is already closed — the poller and
    // the status probe both call `observeWaitingEdge(waiting: false)`.
    stopWaiting(undefined, T0 + 6_000);
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(hasPromptCard(WT)).toBe(false);
  });
});

describe('the fleet size decides whether a push is spent', () => {
  it('sends nothing with a single device — the pre-#2001 behaviour, unchanged', async () => {
    addDevice('only');

    startWaiting();
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('names the single-device case in the decision', async () => {
    addDevice('only');
    markPromptCardShown(WT, T0);

    expect(decidePromptResolution(WT)).toEqual({
      send: false,
      reason: 'single-device',
      deviceCount: 1,
    });
  });

  it('sends from the second device onwards', async () => {
    addDevice('iphone');
    addDevice('android');
    markPromptCardShown(WT, T0);

    expect(decidePromptResolution(WT)).toEqual({
      send: true,
      reason: 'cross-device-clear',
      deviceCount: MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR,
    });
  });

  it('does not throw and sends nothing with zero subscriptions', async () => {
    // No device rows at all. The prompt fan-out returns before it can mark a
    // card, so the resolution has nothing to clear and never reads the fleet.
    startWaiting();
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();

    await expect(notifyPromptResolved({ worktreeId: WT, at: T0 + 1 })).resolves.toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(decidePromptResolution(WT).reason).toBe('no-card');
  });
});

describe('a wait that never rang cannot be cleared', () => {
  it('sends nothing for a prompt Auto-Yes answered — #1999’s saving is kept', async () => {
    addDevice('iphone');
    addDevice('android');
    setAutoYesEnabled(WT, 'claude', true);

    startWaiting();
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(promptCardCount()).toBe(0);

    stopWaiting();
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends nothing when push is unconfigured', () => {
    delete process.env.CM_VAPID_PUBLIC_KEY;
    delete process.env.CM_VAPID_PRIVATE_KEY;
    markPromptCardShown(WT, T0);

    expect(decidePromptResolution(WT)).toEqual({ send: false, reason: 'push-unconfigured' });
  });
});

describe('the card belongs to the worktree, not to one instance', () => {
  it('keeps the card while another instance in the worktree is still waiting', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting();
    startWaiting('claude-2', T0 + 1_000);
    await flush();
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    expect(hasOpenWaitingEpisode(WT)).toBe(true);
    expect(sendNotification).not.toHaveBeenCalled();
    // Still marked: the card on the phone is still telling the truth.
    expect(hasPromptCard(WT)).toBe(true);
  });

  it('clears once the last instance has been answered', async () => {
    addDevice('iphone');
    addDevice('android');

    startWaiting();
    startWaiting('claude-2', T0 + 1_000);
    await flush();
    sendNotification.mockClear();

    stopWaiting();
    await flush();
    stopWaiting('claude-2', T0 + 7_000);
    await flush();

    expect(hasOpenWaitingEpisode(WT)).toBe(false);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(payloads()[0]).toMatchObject({ resolved: true });
  });

  it('does not confuse a worktree with one whose id it prefixes', () => {
    observeWaitingEdge({ worktreeId: `${WT}-extra`, cliToolId: 'claude', waiting: true, now: T0 });
    expect(hasOpenWaitingEpisode(WT)).toBe(false);
    expect(hasOpenWaitingEpisode(`${WT}-extra`)).toBe(true);
    observeWaitingEdge({ worktreeId: `${WT}-extra`, cliToolId: 'claude', waiting: false, now: T0 });
  });
});

describe('the resolution is advisory and never disturbs the caller', () => {
  it('swallows a push service failure', async () => {
    addDevice('iphone');
    addDevice('android');
    markPromptCardShown(WT, T0);
    sendNotification.mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));

    await expect(notifyPromptResolved({ worktreeId: WT, at: T0 })).resolves.toBeUndefined();
  });

  it('drops the card mark even when it decided not to send', async () => {
    addDevice('only');
    markPromptCardShown(WT, T0);

    await notifyPromptResolved({ worktreeId: WT, at: T0 });

    expect(hasPromptCard(WT)).toBe(false);
  });
});
