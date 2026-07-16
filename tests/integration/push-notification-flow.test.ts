/**
 * Integration tests for the Web Push fan-out flow (Issue #1125).
 *
 * Verifies the end-to-end path with web-push mocked:
 *   detection event → notifyPushSubscribers → per-type fan-out → 410 auto-delete,
 * plus notification dedup (no double-send for the same event).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  upsertPushSubscription,
  updatePushSubscriptionPreferences,
  getAllPushSubscriptions,
} from '@/lib/db';

// Mock web-push so no real network calls are made.
const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

// Mock the DB singleton so the fan-out uses our in-memory DB.
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

describe('push notification flow', () => {
  let db: Database.Database;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    (setMockDb as (db: Database.Database) => void)(db);

    savedEnv = {};
    for (const k of VAPID_ENV) savedEnv[k] = process.env[k];
    process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
    process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

    sendNotification.mockReset();
    setVapidDetails.mockReset();
    sendNotification.mockResolvedValue({ statusCode: 201 });

    const { resetNotificationDedup } = await import('@/lib/push');
    resetNotificationDedup();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    for (const k of VAPID_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const sub = (endpoint: string) => ({
    endpoint,
    p256dh: 'p256dh',
    auth: 'auth',
    deviceLabel: 'device',
  });

  it('fans out a prompt notification to all opted-in subscriptions with a minimal payload', async () => {
    upsertPushSubscription(db, sub('https://push.example/a'));
    upsertPushSubscription(db, sub('https://push.example/b'));

    const { notifyPushSubscribers } = await import('@/lib/push');
    await notifyPushSubscribers({
      worktreeId: 'wt-1',
      worktreeName: 'feature-x',
      kind: 'prompt',
      agentName: 'claude',
      excerpt: 'Continue with the migration?',
    });

    expect(setVapidDetails).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    const [subscriptionArg, payloadArg] = sendNotification.mock.calls[0];
    expect(subscriptionArg).toEqual({
      endpoint: 'https://push.example/a',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    });
    const payload = JSON.parse(payloadArg as string);
    expect(payload).toMatchObject({
      kind: 'prompt',
      title: 'feature-x (claude)',
      url: '/worktrees/wt-1',
      worktreeId: 'wt-1',
    });
    expect(payload.body).toContain('Continue with the migration?');
    // Never carries the full terminal — only the short excerpt fields.
    expect(JSON.stringify(payload)).not.toContain('p256dh');
  });

  it('only sends to subscriptions opted into the event kind', async () => {
    upsertPushSubscription(db, sub('https://push.example/a'));
    upsertPushSubscription(db, sub('https://push.example/b'));
    // b opts out of completion.
    updatePushSubscriptionPreferences(db, 'https://push.example/b', { enabledCompletion: false });

    const { notifyPushSubscribers } = await import('@/lib/push');
    await notifyPushSubscribers({
      worktreeId: 'wt-1',
      worktreeName: 'feature-x',
      kind: 'completion',
      excerpt: 'done',
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ endpoint: 'https://push.example/a' });
  });

  it('auto-deletes a subscription when the push service returns 410 Gone', async () => {
    upsertPushSubscription(db, sub('https://push.example/live'));
    upsertPushSubscription(db, sub('https://push.example/gone'));

    sendNotification.mockImplementation((subscription: { endpoint: string }) => {
      if (subscription.endpoint === 'https://push.example/gone') {
        return Promise.reject({ statusCode: 410 });
      }
      return Promise.resolve({ statusCode: 201 });
    });

    const { notifyPushSubscribers } = await import('@/lib/push');
    await notifyPushSubscribers({
      worktreeId: 'wt-1',
      worktreeName: 'feature-x',
      kind: 'prompt',
      excerpt: 'q1',
    });

    const remaining = getAllPushSubscriptions(db).map((s) => s.endpoint);
    expect(remaining).toEqual(['https://push.example/live']);
  });

  it('does not double-send for the same repeated event (dedup)', async () => {
    upsertPushSubscription(db, sub('https://push.example/a'));
    const { notifyPushSubscribers } = await import('@/lib/push');

    const event = {
      worktreeId: 'wt-1',
      worktreeName: 'feature-x',
      kind: 'prompt' as const,
      excerpt: 'Continue?',
    };
    await notifyPushSubscribers(event);
    await notifyPushSubscribers(event);

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * Issue #1308. One agent event fans out to every device at once, but the
   * devices need not share a language — so the body is resolved per
   * subscription, not once for the whole batch.
   */
  describe('per-subscription locale', () => {
    /** Bodies actually handed to web-push, keyed by endpoint. */
    function sentByEndpoint(): Record<string, string> {
      return Object.fromEntries(
        sendNotification.mock.calls.map(([target, payload]) => [
          (target as { endpoint: string }).endpoint,
          (JSON.parse(payload as string) as { body: string }).body,
        ])
      );
    }

    const event = {
      worktreeId: 'wt-1',
      worktreeName: 'feature-x',
      kind: 'prompt' as const,
      excerpt: 'Continue?',
    };

    it('gives each device the body in its own language', async () => {
      upsertPushSubscription(db, { ...sub('https://push.example/en'), locale: 'en' });
      upsertPushSubscription(db, { ...sub('https://push.example/ja'), locale: 'ja' });

      const { notifyPushSubscribers } = await import('@/lib/push');
      await notifyPushSubscribers(event);

      expect(sendNotification).toHaveBeenCalledTimes(2);
      expect(sentByEndpoint()).toEqual({
        'https://push.example/en': 'Waiting for reply: Continue?',
        'https://push.example/ja': '応答待ち: Continue?',
      });
    });

    it('sends English to a subscription that predates the locale column', async () => {
      // Registered before v42 — reads back as NULL, must not break or go blank.
      upsertPushSubscription(db, sub('https://push.example/legacy'));

      const { notifyPushSubscribers } = await import('@/lib/push');
      await notifyPushSubscribers(event);

      expect(sentByEndpoint()).toEqual({
        'https://push.example/legacy': 'Waiting for reply: Continue?',
      });
    });

    it('still reaches every device when locales are mixed with legacy rows', async () => {
      upsertPushSubscription(db, { ...sub('https://push.example/ja'), locale: 'ja' });
      upsertPushSubscription(db, sub('https://push.example/legacy'));
      upsertPushSubscription(db, { ...sub('https://push.example/en'), locale: 'en' });

      const { notifyPushSubscribers } = await import('@/lib/push');
      await notifyPushSubscribers(event);

      // Grouping by locale must not drop or duplicate anyone.
      expect(sendNotification).toHaveBeenCalledTimes(3);
      expect(sentByEndpoint()).toEqual({
        'https://push.example/ja': '応答待ち: Continue?',
        'https://push.example/legacy': 'Waiting for reply: Continue?',
        'https://push.example/en': 'Waiting for reply: Continue?',
      });
    });
  });

  it('is a no-op when push is not configured', async () => {
    delete process.env.CM_VAPID_PUBLIC_KEY;
    delete process.env.CM_VAPID_PRIVATE_KEY;
    upsertPushSubscription(db, sub('https://push.example/a'));

    const { notifyPushSubscribers } = await import('@/lib/push');
    await notifyPushSubscribers({
      worktreeId: 'wt-1',
      worktreeName: 'feature-x',
      kind: 'prompt',
      excerpt: 'q',
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });
});
