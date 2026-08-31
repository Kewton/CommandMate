/**
 * Per-device delivery health, and the two sender paths that write it (#2124).
 *
 * ## What the Issue asked for, and what has to stay unchanged
 *
 * The Issue's acceptance conditions include a *conservation* clause: "a 403 must
 * not delete the subscription (confirm the current behaviour)". So the tests here
 * come in pairs — the new record, and the untouched row. A change that started
 * deleting on 403 would turn a misconfigured `CM_VAPID_SUBJECT` into permanent
 * data loss for every iPhone, which is strictly worse than the silence #2124 was
 * filed about.
 *
 * ## Driven through the real sender against a real database
 *
 * Only `web-push` is stubbed, for the same reason the #2001 and #2057 suites give:
 * the property under test is "what the server records when the push service says
 * no", and a spied `recordPushDeliveryFailure` would pass with the recorder wired
 * to nothing. The subscription table and `app_settings` are real.
 *
 * Nothing here measures APNs. That 403 is what Apple returns for the old default
 * subject is the orchestrator's device measurement from the Epic #2002 UAT
 * (2026-08-27); this file only asserts what CommandMate does with a 403.
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

/**
 * The log is a surface here, not noise. Issue #2124's third measurement was that
 * a fan-out reaching nobody looked exactly like one that was never attempted:
 * `push-send-failed` is per device, and success said nothing at all. So the
 * summary line and the recovery edge are asserted rather than left to drift.
 */
// vi.hoisted so the instance exists when the hoisted vi.mock below runs.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import { upsertPushSubscription, getPushSubscriptionByEndpoint } from '@/lib/db';
import {
  PUSH_DELIVERY_HEALTH_KEY_PREFIX,
  PUSH_DELIVERY_HEALTH_MAX_AGE_MS,
  clearAllPushDeliveryHealth,
  clearPushDeliveryHealth,
  getPushDeliveryHealth,
  recordPushDeliveryFailure,
} from '@/lib/push/delivery-health';
import { notifyPushSubscribers } from '@/lib/push/push-sender';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { clearAllPromptCards } from '@/lib/push/prompt-card-state';

const ENDPOINT = 'https://push.example/device-a';
const OTHER = 'https://push.example/device-b';
const THIRD = 'https://push.example/device-c';
const NOW = 1_800_000_000_000;

function register(endpoint: string): void {
  upsertPushSubscription(db, {
    endpoint,
    p256dh: 'p256dh-placeholder',
    auth: 'auth-placeholder',
    deviceLabel: 'test device',
    locale: 'en',
  });
}

/** An error shaped the way `web-push` rejects. */
function pushError(statusCode?: number): Error & { statusCode?: number } {
  const err = new Error('push service refused') as Error & { statusCode?: number };
  if (statusCode !== undefined) err.statusCode = statusCode;
  return err;
}

describe('delivery health store (Issue #2124)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    process.env.CM_VAPID_PUBLIC_KEY = 'BPublicKeyPlaceholder';
    process.env.CM_VAPID_PRIVATE_KEY = 'PrivateKeyPlaceholder';
    sendNotification.mockReset();
    setVapidDetails.mockReset();
    resetNotificationDedup();
    resetWaitingPushDedup();
    clearAllPromptCards();
  });

  afterEach(() => {
    delete process.env.CM_VAPID_PUBLIC_KEY;
    delete process.env.CM_VAPID_PRIVATE_KEY;
    db.close();
  });

  it('reports a healthy device as null', () => {
    expect(getPushDeliveryHealth(ENDPOINT, NOW)).toBeNull();
  });

  it('counts a streak and keeps the first failure time', () => {
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 }, NOW);
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 }, NOW + 60_000);
    const health = getPushDeliveryHealth(ENDPOINT, NOW + 60_000);
    expect(health).toMatchObject({
      state: 'failing',
      statusCode: 403,
      failureCount: 2,
      firstFailureAt: NOW,
      lastFailureAt: NOW + 60_000,
    });
  });

  it('keeps devices independent', () => {
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 }, NOW);
    expect(getPushDeliveryHealth(OTHER, NOW)).toBeNull();
  });

  it('does not downgrade a removed record back to failing', () => {
    // Once the push service has said the endpoint is gone, a later refusal on the
    // same endpoint is the same fact — and the UI's advice differs ("re-subscribe"
    // versus "check the server's subject").
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 410, removed: true }, NOW);
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 }, NOW + 1000);
    expect(getPushDeliveryHealth(ENDPOINT, NOW + 1000)?.state).toBe('removed');
  });

  it('records an error that carried no status as statusCode null', () => {
    recordPushDeliveryFailure(ENDPOINT, {}, NOW);
    expect(getPushDeliveryHealth(ENDPOINT, NOW)?.statusCode).toBeNull();
  });

  it('forgets a record older than the max age', () => {
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 }, NOW);
    expect(getPushDeliveryHealth(ENDPOINT, NOW + PUSH_DELIVERY_HEALTH_MAX_AGE_MS - 1)).not.toBeNull();
    expect(getPushDeliveryHealth(ENDPOINT, NOW + PUSH_DELIVERY_HEALTH_MAX_AGE_MS)).toBeNull();
  });

  it('never stores the endpoint itself, only a hash of it', () => {
    // An `app_settings` key is readable by anything that opens the database, and a
    // push endpoint is a bearer capability.
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 }, NOW);
    const rows = db
      .prepare('SELECT key, value FROM app_settings WHERE key GLOB ?')
      .all(`${PUSH_DELIVERY_HEALTH_KEY_PREFIX}*`) as Array<{ key: string; value: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].key).not.toContain('push.example');
    expect(rows[0].key).toMatch(new RegExp(`^${PUSH_DELIVERY_HEALTH_KEY_PREFIX}[0-9a-f]{64}$`));
    expect(rows[0].value).not.toContain('push.example');
  });

  it('clearAllPushDeliveryHealth removes every row', () => {
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 }, NOW);
    recordPushDeliveryFailure(OTHER, { statusCode: 403 }, NOW);
    clearAllPushDeliveryHealth();
    expect(getPushDeliveryHealth(ENDPOINT, NOW)).toBeNull();
    expect(getPushDeliveryHealth(OTHER, NOW)).toBeNull();
  });

  it('clearPushDeliveryHealth reports whether anything was actually cleared', () => {
    expect(clearPushDeliveryHealth(ENDPOINT)).toBe(false);
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 }, NOW);
    expect(clearPushDeliveryHealth(ENDPOINT)).toBe(true);
  });
});

describe('push-sender wiring (Issue #2124)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    process.env.CM_VAPID_PUBLIC_KEY = 'BPublicKeyPlaceholder';
    process.env.CM_VAPID_PRIVATE_KEY = 'PrivateKeyPlaceholder';
    sendNotification.mockReset();
    setVapidDetails.mockReset();
    resetNotificationDedup();
    resetWaitingPushDedup();
    clearAllPromptCards();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    register(ENDPOINT);
  });

  afterEach(() => {
    delete process.env.CM_VAPID_PUBLIC_KEY;
    delete process.env.CM_VAPID_PRIVATE_KEY;
    db.close();
  });

  const event = {
    kind: 'prompt' as const,
    worktreeId: 'wt-2124',
    worktreeName: 'wt',
    excerpt: 'continue?',
  };

  it('a 403 records "failing" and leaves the subscription in place', async () => {
    sendNotification.mockRejectedValue(pushError(403));
    await notifyPushSubscribers(event, NOW);

    // The conservation clause: the row must survive.
    expect(getPushSubscriptionByEndpoint(db, ENDPOINT)).not.toBeNull();
    expect(getPushDeliveryHealth(ENDPOINT, NOW)).toMatchObject({
      state: 'failing',
      statusCode: 403,
      failureCount: 1,
    });
  });

  it('a 410 records "removed" and the health record outlives the deleted subscription', async () => {
    sendNotification.mockRejectedValue(pushError(410));
    await notifyPushSubscribers(event, NOW);

    expect(getPushSubscriptionByEndpoint(db, ENDPOINT)).toBeNull();
    // This is the whole point: without it, "dropped by the push service" and
    // "never subscribed" are the same answer to the device that asks.
    expect(getPushDeliveryHealth(ENDPOINT, NOW)).toMatchObject({
      state: 'removed',
      statusCode: 410,
    });
  });

  it('a 404 is handled exactly like a 410', async () => {
    sendNotification.mockRejectedValue(pushError(404));
    await notifyPushSubscribers(event, NOW);
    expect(getPushSubscriptionByEndpoint(db, ENDPOINT)).toBeNull();
    expect(getPushDeliveryHealth(ENDPOINT, NOW)?.state).toBe('removed');
  });

  it('a successful send clears a previous failure', async () => {
    sendNotification.mockRejectedValueOnce(pushError(403));
    await notifyPushSubscribers(event, NOW);
    expect(getPushDeliveryHealth(ENDPOINT, NOW)?.state).toBe('failing');

    sendNotification.mockResolvedValue(undefined);
    resetNotificationDedup();
    resetWaitingPushDedup();
    await notifyPushSubscribers({ ...event, worktreeId: 'wt-2124b' }, NOW + 60_000);
    expect(getPushDeliveryHealth(ENDPOINT, NOW + 60_000)).toBeNull();
  });

  it('a healthy send records nothing at all', async () => {
    sendNotification.mockResolvedValue(undefined);
    await notifyPushSubscribers(event, NOW);
    expect(getPushDeliveryHealth(ENDPOINT, NOW)).toBeNull();
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM app_settings WHERE key GLOB ?')
        .get(`${PUSH_DELIVERY_HEALTH_KEY_PREFIX}*`)
    ).toEqual({ n: 0 });
  });

  it('logs one fan-out summary naming both delivered and failed', async () => {
    // Before #2124 a fan-out that reached nobody was indistinguishable from one
    // that never ran: failures were per device at WARN, and success was silent.
    // Three devices, asymmetric on purpose: with one of each, a summary that
    // swapped the two counts would still read `{delivered: 1, failed: 1}` and
    // this test would pass while the log lied.
    register(OTHER);
    register(THIRD);
    sendNotification.mockImplementation((sub: { endpoint: string }) =>
      sub.endpoint === ENDPOINT ? Promise.reject(pushError(403)) : Promise.resolve(undefined)
    );

    await notifyPushSubscribers(event, NOW);

    // `worktreeId` joined the line in #2133 — see `fanout-attribution-2133` for
    // why. It is asserted here too because this is the exact-shape assertion for
    // the summary: a key added without updating this object is a silent drift.
    expect(mockLogger.info).toHaveBeenCalledWith('push-fanout-complete', {
      kind: 'prompt',
      worktreeId: 'wt-2124',
      delivered: 2,
      failed: 1,
    });
  });

  it('carries the streak length on the failure line, so a blip reads differently to a misconfiguration', async () => {
    sendNotification.mockRejectedValue(pushError(403));
    await notifyPushSubscribers(event, NOW);
    resetNotificationDedup();
    resetWaitingPushDedup();
    await notifyPushSubscribers({ ...event, worktreeId: 'wt-2124c' }, NOW + 1000);

    expect(mockLogger.warn).toHaveBeenLastCalledWith('push-send-failed', {
      statusCode: 403,
      consecutiveFailures: 2,
    });
  });

  it('logs the recovery edge, and only the edge', async () => {
    sendNotification.mockRejectedValueOnce(pushError(403));
    await notifyPushSubscribers(event, NOW);

    // Recovery: the device that was failing receives again.
    sendNotification.mockResolvedValue(undefined);
    resetNotificationDedup();
    resetWaitingPushDedup();
    mockLogger.info.mockClear();
    await notifyPushSubscribers({ ...event, worktreeId: 'wt-2124d' }, NOW + 1000);
    expect(mockLogger.info).toHaveBeenCalledWith('push-delivery-recovered');

    // The next ordinary success is unremarkable and must stay silent, or the log
    // gains one line per device per notification.
    resetNotificationDedup();
    resetWaitingPushDedup();
    mockLogger.info.mockClear();
    await notifyPushSubscribers({ ...event, worktreeId: 'wt-2124e' }, NOW + 2000);
    expect(mockLogger.info).not.toHaveBeenCalledWith('push-delivery-recovered');
  });

  it('records per device when one fails and another succeeds', async () => {
    register(OTHER);
    sendNotification.mockImplementation((sub: { endpoint: string }) =>
      sub.endpoint === ENDPOINT ? Promise.reject(pushError(403)) : Promise.resolve(undefined)
    );
    await notifyPushSubscribers(event, NOW);

    expect(getPushDeliveryHealth(ENDPOINT, NOW)?.state).toBe('failing');
    expect(getPushDeliveryHealth(OTHER, NOW)).toBeNull();
  });
});
