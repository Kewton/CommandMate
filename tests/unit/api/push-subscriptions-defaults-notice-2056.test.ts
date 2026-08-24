/**
 * The defaults-notice route contract (Issue #2056).
 *
 * The notice is only worth anything if the reader can answer it, and answering
 * has to be possible *without* changing a preference — otherwise "keep this
 * device as it is" would be unreachable and the only way to dismiss the banner
 * would be to accept the new default. That is the case this file exists for:
 * PATCH must accept an acknowledgement on its own.
 *
 * `defaultsNoticePending` is asserted as a sibling of `preferences`, never a
 * member of it. `tests/integration/push-subscriptions-api.test.ts` pins
 * `preferences` with `toEqual`, and the client compares that object against its
 * own switch state — a third key inside it would break both.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { getPushSubscriptionByEndpoint } from '@/lib/db';

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

const BASE = 'http://localhost/api/push/subscriptions';
const LEGACY = 'https://push.example/2056-route-legacy';

function jsonRequest(method: string, body: unknown) {
  return new Request(BASE, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A device that subscribed before #2000: opted into everything, never told. */
function seedLegacySubscription(db: Database.Database): void {
  db.prepare(
    `INSERT INTO push_subscriptions
       (id, endpoint, p256dh, auth, device_label, enabled_prompt, enabled_completion, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`
  ).run('legacy-route', LEGACY, 'p', 'a', 'Old Phone', 'ja', 1, 1);
}

describe('push subscriptions API — defaults notice (Issue #2056)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    (setMockDb as (d: Database.Database) => void)(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('GET tells a pre-#2000 device that it is still owed the notice', async () => {
    seedLegacySubscription(db);
    const { GET } = await import('@/app/api/push/subscriptions/route');

    const res = GET(new Request(`${BASE}?endpoint=${encodeURIComponent(LEGACY)}`));
    const data = await res.json();

    expect(data.subscription.defaultsNoticePending).toBe(true);
    // The notice describes these two, so they must still read as they did.
    expect(data.subscription.preferences).toEqual({ prompt: true, completion: true });
  });

  it('POST registers a device that is already at the current defaults', async () => {
    const { POST } = await import('@/app/api/push/subscriptions/route');

    const res = await POST(
      jsonRequest('POST', {
        subscription: {
          endpoint: 'https://push.example/2056-route-new',
          keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
        },
        deviceLabel: 'Pixel 8',
      })
    );
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.subscription.defaultsNoticePending).toBe(false);
    expect(data.subscription.preferences).toEqual({ prompt: true, completion: false });
    expect(JSON.stringify(data)).not.toContain('p256dh-key');
  });

  it('PATCH accepts an acknowledgement on its own and moves no toggle', async () => {
    seedLegacySubscription(db);
    const { PATCH } = await import('@/app/api/push/subscriptions/route');

    const res = await PATCH(
      jsonRequest('PATCH', { endpoint: LEGACY, acknowledgeDefaultsNotice: true })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.subscription.defaultsNoticePending).toBe(false);
    expect(data.subscription.preferences).toEqual({ prompt: true, completion: true });
    expect(getPushSubscriptionByEndpoint(db, LEGACY)?.enabledCompletion).toBe(true);
  });

  it('PATCH adopts the new default and clears the notice in one request', async () => {
    seedLegacySubscription(db);
    const { PATCH } = await import('@/app/api/push/subscriptions/route');

    const res = await PATCH(
      jsonRequest('PATCH', {
        endpoint: LEGACY,
        preferences: { prompt: true, completion: false },
        acknowledgeDefaultsNotice: true,
      })
    );
    const data = await res.json();

    expect(data.subscription.preferences).toEqual({ prompt: true, completion: false });
    expect(data.subscription.defaultsNoticePending).toBe(false);
  });

  it('PATCH still rejects a request that changes nothing at all', async () => {
    seedLegacySubscription(db);
    const { PATCH } = await import('@/app/api/push/subscriptions/route');

    // `acknowledgeDefaultsNotice: false` is not a change — the marker is
    // one-way — so this is the same empty PATCH #1125 already rejected.
    const res = await PATCH(
      jsonRequest('PATCH', { endpoint: LEGACY, acknowledgeDefaultsNotice: false })
    );

    expect(res.status).toBe(400);
    expect(getPushSubscriptionByEndpoint(db, LEGACY)?.defaultsVersion).toBe(0);
  });

  it('PATCH ignores a non-boolean acknowledgement', async () => {
    seedLegacySubscription(db);
    const { PATCH } = await import('@/app/api/push/subscriptions/route');

    const res = await PATCH(
      jsonRequest('PATCH', { endpoint: LEGACY, acknowledgeDefaultsNotice: 'yes' })
    );

    expect(res.status).toBe(400);
    expect(getPushSubscriptionByEndpoint(db, LEGACY)?.defaultsVersion).toBe(0);
  });
});
