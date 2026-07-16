/**
 * Integration tests for the push subscription API routes (Issue #1125).
 *
 * Auth is enforced globally by src/middleware.ts (these routes are NOT in
 * AUTH_EXCLUDED_PATHS), so the handlers themselves assume an authenticated
 * caller. These tests exercise the handler contract + DB persistence.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { getAllPushSubscriptions } from '@/lib/db';

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

function jsonRequest(method: string, body: unknown) {
  return new Request(BASE, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validSubscription = {
  subscription: {
    endpoint: 'https://push.example/device-1',
    keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
  },
  deviceLabel: 'Pixel 8',
};

describe('push subscriptions API', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    (setMockDb as (db: Database.Database) => void)(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  it('POST registers a subscription and persists it', async () => {
    const { POST } = await import('@/app/api/push/subscriptions/route');
    const res = await POST(jsonRequest('POST', validSubscription));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.subscription.endpoint).toBe('https://push.example/device-1');
    // Response must not leak the encryption keys.
    expect(JSON.stringify(data)).not.toContain('p256dh-key');

    expect(getAllPushSubscriptions(db)).toHaveLength(1);
  });

  /**
   * Issue #1308 — registration is the only place a request context exists, so
   * this is where the reader's language has to be captured. These tests run the
   * real route against a real DB and then build the real payload, which is the
   * end-to-end claim the acceptance criteria make ("subscribe in English -> an
   * English body arrives").
   */
  describe('locale capture', () => {
    function requestWith(headers: Record<string, string>) {
      return new Request(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(validSubscription),
      });
    }

    async function register(headers: Record<string, string>) {
      const { POST } = await import('@/app/api/push/subscriptions/route');
      const res = await POST(requestWith(headers));
      expect(res.status).toBe(201);
      return getAllPushSubscriptions(db)[0];
    }

    it('stores the locale cookie', async () => {
      expect((await register({ cookie: 'locale=ja' })).locale).toBe('ja');
    });

    it('prefers the locale cookie over Accept-Language', async () => {
      const rec = await register({ cookie: 'locale=ja', 'accept-language': 'en-US,en;q=0.9' });
      expect(rec.locale).toBe('ja');
    });

    it('picks the cookie out from among other cookies', async () => {
      const rec = await register({ cookie: 'auth_token=abc; locale=ja; theme=dark' });
      expect(rec.locale).toBe('ja');
    });

    it('falls back to Accept-Language when no cookie is set', async () => {
      expect((await register({ 'accept-language': 'ja-JP,ja;q=0.9' })).locale).toBe('ja');
    });

    it('ignores an unsupported cookie locale', async () => {
      expect((await register({ cookie: 'locale=fr' })).locale).toBe('en');
    });

    it('defaults to en when nothing identifies the reader', async () => {
      expect((await register({})).locale).toBe('en');
    });

    it('delivers an English body to a device registered in English', async () => {
      const rec = await register({ cookie: 'locale=en' });
      const { buildPushPayload } = await import('@/lib/push/push-sender');
      expect(buildPushPayload({ worktreeId: 'w', worktreeName: 'n', kind: 'prompt' }, rec.locale).body).toBe(
        'Waiting for your reply'
      );
    });

    it('delivers a Japanese body to a device registered in Japanese', async () => {
      const rec = await register({ cookie: 'locale=ja' });
      const { buildPushPayload } = await import('@/lib/push/push-sender');
      expect(buildPushPayload({ worktreeId: 'w', worktreeName: 'n', kind: 'prompt' }, rec.locale).body).toBe(
        '応答待ちです'
      );
    });
  });

  it('POST rejects an invalid subscription body', async () => {
    const { POST } = await import('@/app/api/push/subscriptions/route');
    const res = await POST(jsonRequest('POST', { subscription: { endpoint: '' } }));
    expect(res.status).toBe(400);
    expect(getAllPushSubscriptions(db)).toHaveLength(0);
  });

  it('GET returns current preferences for a known endpoint', async () => {
    const { POST, GET } = await import('@/app/api/push/subscriptions/route');
    await POST(jsonRequest('POST', validSubscription));

    const res = await GET(
      new Request(`${BASE}?endpoint=${encodeURIComponent('https://push.example/device-1')}`)
    );
    const data = await res.json();
    expect(data.subscribed).toBe(true);
    expect(data.subscription.preferences).toEqual({ prompt: true, completion: true });
  });

  it('GET reports not-subscribed for an unknown endpoint', async () => {
    const { GET } = await import('@/app/api/push/subscriptions/route');
    const res = await GET(new Request(`${BASE}?endpoint=${encodeURIComponent('https://x/none')}`));
    const data = await res.json();
    expect(data.subscribed).toBe(false);
  });

  it('PATCH updates per-type preferences', async () => {
    const { POST, PATCH } = await import('@/app/api/push/subscriptions/route');
    await POST(jsonRequest('POST', validSubscription));

    const res = await PATCH(
      jsonRequest('PATCH', {
        endpoint: 'https://push.example/device-1',
        preferences: { completion: false },
      })
    );
    const data = await res.json();
    expect(data.subscription.preferences).toEqual({ prompt: true, completion: false });
  });

  it('PATCH returns 404 for an unknown endpoint', async () => {
    const { PATCH } = await import('@/app/api/push/subscriptions/route');
    const res = await PATCH(
      jsonRequest('PATCH', { endpoint: 'https://x/none', preferences: { prompt: false } })
    );
    expect(res.status).toBe(404);
  });

  it('DELETE unsubscribes the device', async () => {
    const { POST, DELETE } = await import('@/app/api/push/subscriptions/route');
    await POST(jsonRequest('POST', validSubscription));

    const res = await DELETE(jsonRequest('DELETE', { endpoint: 'https://push.example/device-1' }));
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.removed).toBe(true);
    expect(getAllPushSubscriptions(db)).toHaveLength(0);
  });

  it('DELETE requires an endpoint', async () => {
    const { DELETE } = await import('@/app/api/push/subscriptions/route');
    const res = await DELETE(jsonRequest('DELETE', {}));
    expect(res.status).toBe(400);
  });
});

describe('push vapid API', () => {
  const KEYS = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reports not-configured when keys are absent', async () => {
    const { GET } = await import('@/app/api/push/vapid/route');
    const data = await (GET() as Response).json();
    expect(data.configured).toBe(false);
    expect(data.publicKey).toBeNull();
  });

  it('returns the public key when configured', async () => {
    process.env.CM_VAPID_PUBLIC_KEY = 'pub-key';
    process.env.CM_VAPID_PRIVATE_KEY = 'priv-key';
    const { GET } = await import('@/app/api/push/vapid/route');
    const data = await (GET() as Response).json();
    expect(data.configured).toBe(true);
    expect(data.publicKey).toBe('pub-key');
  });
});
