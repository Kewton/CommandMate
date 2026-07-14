/**
 * Unit tests for push-subscriptions-db (Issue #1125).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  upsertPushSubscription,
  getPushSubscriptionByEndpoint,
  getAllPushSubscriptions,
  getPushSubscriptionsForKind,
  updatePushSubscriptionPreferences,
  deletePushSubscriptionByEndpoint,
} from '@/lib/db';

describe('push-subscriptions-db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  const sub = (endpoint: string) => ({
    endpoint,
    p256dh: 'p256dh-key',
    auth: 'auth-secret',
    deviceLabel: 'Pixel 8',
  });

  it('creates a subscription with both kinds enabled by default', () => {
    const rec = upsertPushSubscription(db, sub('https://push.example/a'));
    expect(rec.id).toBeTruthy();
    expect(rec.endpoint).toBe('https://push.example/a');
    expect(rec.keys).toEqual({ p256dh: 'p256dh-key', auth: 'auth-secret' });
    expect(rec.deviceLabel).toBe('Pixel 8');
    expect(rec.enabledPrompt).toBe(true);
    expect(rec.enabledCompletion).toBe(true);
  });

  it('upsert on the same endpoint refreshes keys but preserves preferences', () => {
    upsertPushSubscription(db, sub('https://push.example/a'));
    updatePushSubscriptionPreferences(db, 'https://push.example/a', {
      enabledCompletion: false,
    });

    const updated = upsertPushSubscription(db, {
      endpoint: 'https://push.example/a',
      p256dh: 'rotated-key',
      auth: 'rotated-auth',
      deviceLabel: 'Pixel 8 Pro',
    });

    expect(getAllPushSubscriptions(db)).toHaveLength(1);
    expect(updated.keys.p256dh).toBe('rotated-key');
    expect(updated.deviceLabel).toBe('Pixel 8 Pro');
    expect(updated.enabledCompletion).toBe(false); // preserved
    expect(updated.enabledPrompt).toBe(true);
  });

  it('getPushSubscriptionByEndpoint returns null for unknown endpoint', () => {
    expect(getPushSubscriptionByEndpoint(db, 'https://push.example/none')).toBeNull();
  });

  it('filters subscriptions by kind', () => {
    upsertPushSubscription(db, sub('https://push.example/a'));
    upsertPushSubscription(db, sub('https://push.example/b'));
    updatePushSubscriptionPreferences(db, 'https://push.example/b', {
      enabledPrompt: false,
    });

    const forPrompt = getPushSubscriptionsForKind(db, 'prompt');
    expect(forPrompt.map((s) => s.endpoint)).toEqual(['https://push.example/a']);

    const forCompletion = getPushSubscriptionsForKind(db, 'completion');
    expect(forCompletion.map((s) => s.endpoint).sort()).toEqual([
      'https://push.example/a',
      'https://push.example/b',
    ]);
  });

  it('updates preferences independently', () => {
    upsertPushSubscription(db, sub('https://push.example/a'));
    const updated = updatePushSubscriptionPreferences(db, 'https://push.example/a', {
      enabledPrompt: false,
      enabledCompletion: true,
    });
    expect(updated?.enabledPrompt).toBe(false);
    expect(updated?.enabledCompletion).toBe(true);
  });

  it('updatePushSubscriptionPreferences returns null for unknown endpoint', () => {
    expect(
      updatePushSubscriptionPreferences(db, 'https://push.example/none', { enabledPrompt: false })
    ).toBeNull();
  });

  it('deletes a subscription by endpoint', () => {
    upsertPushSubscription(db, sub('https://push.example/a'));
    expect(deletePushSubscriptionByEndpoint(db, 'https://push.example/a')).toBe(true);
    expect(getAllPushSubscriptions(db)).toHaveLength(0);
  });

  it('delete returns false when nothing was removed', () => {
    expect(deletePushSubscriptionByEndpoint(db, 'https://push.example/none')).toBe(false);
  });
});
