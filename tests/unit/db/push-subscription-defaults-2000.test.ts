/**
 * The new-subscription default, and the promise that existing rows do not move
 * (Issue #2000).
 *
 * The adjudication on the Issue is two separate claims and this file pins both:
 *
 *  1. a **newly registered** device opts into the "you need to act" bucket only
 *     — `enabled_completion` starts at 0;
 *  2. a device that was already registered keeps whatever it had. "Notifications
 *     went quiet" is indistinguishable from "notifications broke" from the
 *     outside, so nothing may change a row that already exists.
 *
 * Claim 2 is asserted against the migration runner rather than against a code
 * path, because the failure it guards against is a *future* migration that
 * decides to tidy the column up. Re-running `runMigrations` over a seeded row is
 * what would catch that.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  NEW_SUBSCRIPTION_DEFAULTS,
  getPushSubscriptionByEndpoint,
  getPushSubscriptionsForKind,
  updatePushSubscriptionPreferences,
  upsertPushSubscription,
} from '@/lib/db/push-subscriptions-db';

let db: Database.Database;

const NEW_DEVICE = 'https://push.example/2000-new';
const LEGACY_DEVICE = 'https://push.example/2000-legacy';

/** A row as it looked before #2000: opted into everything. */
function seedLegacySubscription(endpoint: string): void {
  db.prepare(
    `INSERT INTO push_subscriptions
       (id, endpoint, p256dh, auth, device_label, enabled_prompt, enabled_completion, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`
  ).run('legacy-id', endpoint, 'p', 'a', 'Old Phone', 'ja', 1, 1);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('push subscription defaults (Issue #2000)', () => {
  it('creates a new subscription with completions OFF and the action bucket ON', () => {
    const record = upsertPushSubscription(db, { endpoint: NEW_DEVICE, p256dh: 'p', auth: 'a' });

    expect(record.enabledPrompt).toBe(true);
    expect(record.enabledCompletion).toBe(false);
  });

  it('writes the declared defaults rather than the schema DEFAULT', () => {
    // The v41 schema still declares `DEFAULT 1` for both columns. This asserts
    // that the row reflects NEW_SUBSCRIPTION_DEFAULTS instead — i.e. that the
    // INSERT binds them, which is why #2000 needed no migration.
    upsertPushSubscription(db, { endpoint: NEW_DEVICE, p256dh: 'p', auth: 'a' });
    const row = db
      .prepare('SELECT enabled_prompt, enabled_completion FROM push_subscriptions WHERE endpoint = ?')
      .get(NEW_DEVICE) as { enabled_prompt: number; enabled_completion: number };

    expect(row.enabled_prompt).toBe(NEW_SUBSCRIPTION_DEFAULTS.enabledPrompt ? 1 : 0);
    expect(row.enabled_completion).toBe(NEW_SUBSCRIPTION_DEFAULTS.enabledCompletion ? 1 : 0);
    expect(NEW_SUBSCRIPTION_DEFAULTS.enabledCompletion).toBe(false);
  });

  it('leaves an existing subscription untouched when the migrations re-run', () => {
    seedLegacySubscription(LEGACY_DEVICE);

    // Idempotent re-run: this is what a server restart does, and what a future
    // migration that "aligned" the column would ride in on.
    runMigrations(db);

    const record = getPushSubscriptionByEndpoint(db, LEGACY_DEVICE);
    expect(record?.enabledPrompt).toBe(true);
    expect(record?.enabledCompletion).toBe(true);
  });

  it('does not reset an existing device to the new default when it re-registers', () => {
    seedLegacySubscription(LEGACY_DEVICE);

    const refreshed = upsertPushSubscription(db, {
      endpoint: LEGACY_DEVICE,
      p256dh: 'rotated',
      auth: 'rotated',
      deviceLabel: 'Old Phone (updated)',
    });

    expect(refreshed.keys.p256dh).toBe('rotated');
    // The whole point of the ON CONFLICT clause: keys and label refresh, the
    // user's own toggles do not.
    expect(refreshed.enabledCompletion).toBe(true);
  });

  it('routes the failure kind through the action bucket, not the completion one', () => {
    upsertPushSubscription(db, { endpoint: NEW_DEVICE, p256dh: 'p', auth: 'a' });

    // A brand-new device: prompt on, completion off. A failure has to reach it.
    expect(getPushSubscriptionsForKind(db, 'failure').map((s) => s.endpoint)).toEqual([NEW_DEVICE]);
    expect(getPushSubscriptionsForKind(db, 'completion')).toEqual([]);

    // Turning completions ON must not be what governs failures...
    updatePushSubscriptionPreferences(db, NEW_DEVICE, { enabledCompletion: true });
    expect(getPushSubscriptionsForKind(db, 'failure').map((s) => s.endpoint)).toEqual([NEW_DEVICE]);

    // ...and turning the action bucket OFF must silence them.
    updatePushSubscriptionPreferences(db, NEW_DEVICE, { enabledPrompt: false });
    expect(getPushSubscriptionsForKind(db, 'failure')).toEqual([]);
    expect(getPushSubscriptionsForKind(db, 'completion').map((s) => s.endpoint)).toEqual([
      NEW_DEVICE,
    ]);
  });
});
