/**
 * `GET /api/push/subscriptions` reports delivery health (Issue #2124).
 *
 * This is the route that carries "this device is not receiving" to the More
 * screen, and the case it exists for is the one where the subscription is GONE:
 * a 410 deletes the row, so before this the answer for a device the push service
 * had dropped was byte-identical to the answer for a device that never
 * subscribed. Measured during the Epic #2002 device UAT (2026-08-27): a 410
 * removed an Android subscription and the reader's whole experience was
 * "notifications stopped at some point".
 *
 * So the `subscribed: false` branch is the load-bearing test here, not the
 * `subscribed: true` one.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

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

const BASE = 'http://127.0.0.1/api/push/subscriptions';
const ENDPOINT = 'https://push.example/2124-route';

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO push_subscriptions
       (id, endpoint, p256dh, auth, device_label, enabled_prompt, enabled_completion, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`
  ).run('2124-route', ENDPOINT, 'p256dh-key', 'auth-secret', 'iPad', 'en', 1, 1);
}

function get(endpoint: string) {
  return import('@/app/api/push/subscriptions/route').then(({ GET }) =>
    GET(new Request(`${BASE}?endpoint=${encodeURIComponent(endpoint)}`))
  );
}

describe('push subscriptions API — delivery health (Issue #2124)', () => {
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

  it('reports null for a healthy subscribed device', async () => {
    seed(db);
    const data = await (await get(ENDPOINT)).json();

    expect(data.subscribed).toBe(true);
    expect(data.delivery).toBeNull();
  });

  it('reports a 403 streak while the subscription stays registered', async () => {
    seed(db);
    const { recordPushDeliveryFailure } = await import('@/lib/push/delivery-health');
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 });
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 });

    const data = await (await get(ENDPOINT)).json();

    // Both halves matter: the device is told, AND it is still subscribed. A 403
    // is a server misconfiguration and must never cost the reader a subscription.
    expect(data.subscribed).toBe(true);
    expect(data.delivery).toMatchObject({ state: 'failing', statusCode: 403, failureCount: 2 });
  });

  it('reports a removal for an endpoint whose subscription is already gone', async () => {
    // No seed: this is exactly the post-410 state.
    const { recordPushDeliveryFailure } = await import('@/lib/push/delivery-health');
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 410, removed: true });

    const data = await (await get(ENDPOINT)).json();

    expect(data.subscribed).toBe(false);
    expect(data.delivery).toMatchObject({ state: 'removed', statusCode: 410 });
  });

  it('reports null for an endpoint nobody has ever heard of', async () => {
    const data = await (await get('https://push.example/never-seen')).json();
    expect(data.subscribed).toBe(false);
    expect(data.delivery).toBeNull();
  });

  it('never echoes the subscription keys', async () => {
    seed(db);
    const { recordPushDeliveryFailure } = await import('@/lib/push/delivery-health');
    recordPushDeliveryFailure(ENDPOINT, { statusCode: 403 });

    const body = JSON.stringify(await (await get(ENDPOINT)).json());

    expect(body).not.toContain('p256dh-key');
    expect(body).not.toContain('auth-secret');
  });

  it('still requires an endpoint', async () => {
    const { GET } = await import('@/app/api/push/subscriptions/route');
    const res = GET(new Request(BASE));
    expect(res.status).toBe(400);
  });
});
