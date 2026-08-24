/**
 * End-to-end cross-device dismissal (Issue #2001): a browser registers, a wait
 * opens and closes, and the encrypted resolution reaches the other device.
 *
 * What this file adds over `tests/unit/push/cross-device-dismissal-2001.test.ts`
 * is the two ends the unit suite short-circuits:
 *
 *  - devices arrive through the real `POST /api/push/subscriptions` handler, so
 *    the fleet the decision counts is the one #2000's `NEW_SUBSCRIPTION_DEFAULTS`
 *    actually writes, not one a test constructed;
 *  - the acting bucket can be switched off through the real `PATCH` handler, so
 *    "two devices" and "two devices that would receive a prompt" are told apart
 *    by the same column the fan-out reads.
 *
 * Only `web-push` is stubbed. Everything between the HTTP handler and the
 * ciphertext — migrations, the waiting edge, the notifier, the dictionaries — is
 * the shipped code.
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

import { clearAllPromptCards } from '@/lib/push/prompt-card-state';
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

const WT = 'wt-2001i';
const BASE = 'http://localhost/api/push/subscriptions';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

function jsonRequest(method: string, body: unknown, acceptLanguage?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (acceptLanguage) headers['Accept-Language'] = acceptLanguage;
  return new Request(BASE, { method, headers, body: JSON.stringify(body) });
}

/**
 * Register a device exactly as `NotificationsSettings` does after subscribing.
 *
 * The language rides on `Accept-Language`, not on the body — the route derives
 * the stored locale from the request (#1308), and that is the value the
 * resolution body is later rendered in.
 */
async function registerDevice(name: string, locale: string): Promise<string> {
  const { POST } = await import('@/app/api/push/subscriptions/route');
  const endpoint = `https://push.example/${name}`;
  const res = await POST(
    jsonRequest(
      'POST',
      {
        subscription: { endpoint, keys: { p256dh: `p-${name}`, auth: `a-${name}` } },
        deviceLabel: name,
      },
      locale
    )
  );
  expect(res.status).toBe(201);
  return endpoint;
}

/** Turn the "when you need to act" bucket off for one device, through the API. */
async function disableActingBucket(endpoint: string): Promise<void> {
  const { PATCH } = await import('@/app/api/push/subscriptions/route');
  const res = await PATCH(jsonRequest('PATCH', { endpoint, preferences: { prompt: false } }));
  expect(res.status).toBe(200);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function payloads(): Array<Record<string, unknown>> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as Record<string, unknown>
  );
}

function startWaiting(now = T0): void {
  observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now });
}

function stopWaiting(now = T0 + 5_000): void {
  observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: false, now });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-2001i', '/tmp/repo', 'repo', T0);

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
  setPushEscalationSettings({ enabled: true, thresholdMinutes: 10 });

  startWaitingPushNotifier();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  clearAllPromptCards();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Issue #2001: an iPhone and an Android registered through the API', () => {
  it('both get the prompt, then both get the card that replaces it', async () => {
    await registerDevice('iphone', 'ja');
    await registerDevice('android', 'en');

    startWaiting();
    await flush();
    expect(payloads().map((p) => p.tag)).toEqual([`${WT}:prompt`, `${WT}:prompt`]);
    expect(payloads().every((p) => p.resolved === undefined)).toBe(true);
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(payloads().map((p) => p.resolved)).toEqual([true, true]);
    // Same tag as the prompt: on each device the Service Worker closes what
    // carries it and shows this one in its place.
    expect(payloads().map((p) => p.tag)).toEqual([`${WT}:prompt`, `${WT}:prompt`]);
    expect(payloads().map((p) => p.body).sort()).toEqual([
      'Handled — answered on another device',
      '対応済みです（他の端末で応答されました）',
    ]);
  });

  it('stops clearing when one of the two opts out of the acting bucket', async () => {
    await registerDevice('iphone', 'en');
    const android = await registerDevice('android', 'en');
    await disableActingBucket(android);

    startWaiting();
    await flush();
    // Only the device still in the acting bucket was told, so only one card
    // exists — and one card is not a cross-device problem.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends nothing extra to an install with a single device', async () => {
    await registerDevice('only', 'en');

    startWaiting();
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    sendNotification.mockClear();

    stopWaiting();
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('survives an install with no devices at all', async () => {
    startWaiting();
    await flush();
    stopWaiting();
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });
});
