/**
 * The one-off "the defaults changed" notice, at the storage layer (Issue #2056).
 *
 * #2000 changed what a *new* subscription starts as, and deliberately left every
 * existing row where it was. That is the right call on its own terms — a live
 * subscriber whose completions go quiet cannot tell that from notifications
 * being broken — but it leaves Epic #2002's completion criteria contradicting
 * each other for exactly the rows that predate it:
 *
 *   - criterion 3 wants ordinary completions off by default;
 *   - criterion 6 wants no notification to stop unintentionally.
 *
 * A migration that flipped `enabled_completion` satisfies 3 and breaks 6. Doing
 * nothing satisfies 6 and breaks 3. **Consent is what makes them compatible**:
 * once the reader has been told and has chosen, the change is not unintentional.
 * So the migration adds a marker and nothing else, and the choice happens in the
 * UI. The alternatives — (a) a blanket migration to 0, (b) redefining criterion 3
 * as "new subscriptions only" and writing it down — were not taken because (a)
 * is the criterion-6 break above and (b) leaves the failure kinds that #2000
 * folded into `enabled_prompt` arriving at readers who were never told.
 *
 * The load-bearing claim of this file is the third describe block: applying v57
 * to a populated table changes the fan-out for **no kind and no row**. It is
 * asserted across a real rollback/re-apply of v57 rather than by inspecting the
 * migration source, because "additive" is a property of what the statement does,
 * not of what its docblock says.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  rollbackMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';
import {
  PUSH_DEFAULTS_VERSION,
  getPushSubscriptionByEndpoint,
  getPushSubscriptionsForKind,
  pushSubscriptionNeedsDefaultsNotice,
  updatePushSubscriptionPreferences,
  upsertPushSubscription,
  type PushNotificationKind,
} from '@/lib/db/push-subscriptions-db';

let db: Database.Database;

const NEW_DEVICE = 'https://push.example/2056-new';
const LEGACY_DEVICE = 'https://push.example/2056-legacy';
const LEGACY_QUIET_DEVICE = 'https://push.example/2056-legacy-quiet';

const KINDS: PushNotificationKind[] = ['prompt', 'completion', 'failure'];

/**
 * A row as a pre-#2000 install left it: opted into everything.
 *
 * Written with an explicit column list that omits `defaults_version`, so the
 * v57 backfill is what supplies it — the same path a real upgraded database
 * takes. Binding 0 by hand would assert the test's own assumption instead.
 */
function seedLegacySubscription(endpoint: string, enabledCompletion: number): void {
  db.prepare(
    `INSERT INTO push_subscriptions
       (id, endpoint, p256dh, auth, device_label, enabled_prompt, enabled_completion, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(`legacy-${endpoint}`, endpoint, 'p', 'a', 'Old Phone', enabledCompletion, 'ja', 1, 1);
}

/** The fan-out, as the senders see it: which endpoints receive each kind. */
function fanOut(): Record<string, string[]> {
  const snapshot: Record<string, string[]> = {};
  for (const kind of KINDS) {
    snapshot[kind] = getPushSubscriptionsForKind(db, kind)
      .map((s) => s.endpoint)
      .sort();
  }
  return snapshot;
}

/** The same question asked without the module, so it works at v56 too. */
function rawFanOut(): Record<string, string[]> {
  const read = (column: string) =>
    (
      db
        .prepare(`SELECT endpoint FROM push_subscriptions WHERE ${column} = 1`)
        .all() as Array<{ endpoint: string }>
    )
      .map((r) => r.endpoint)
      .sort();

  // Mirrors KIND_COLUMN: `failure` shares the acting bucket with `prompt`.
  return {
    prompt: read('enabled_prompt'),
    failure: read('enabled_prompt'),
    completion: read('enabled_completion'),
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('defaults-notice marker (Issue #2056)', () => {
  it('backfills existing rows as "never told" and creates new ones as told', () => {
    seedLegacySubscription(LEGACY_DEVICE, 1);
    const fresh = upsertPushSubscription(db, { endpoint: NEW_DEVICE, p256dh: 'p', auth: 'a' });

    const legacy = getPushSubscriptionByEndpoint(db, LEGACY_DEVICE);
    expect(legacy?.defaultsVersion).toBe(0);
    expect(pushSubscriptionNeedsDefaultsNotice(legacy!)).toBe(true);

    expect(fresh.defaultsVersion).toBe(PUSH_DEFAULTS_VERSION);
    expect(pushSubscriptionNeedsDefaultsNotice(fresh)).toBe(false);
  });

  it('does not mark a legacy device as told just because it re-registered', () => {
    seedLegacySubscription(LEGACY_DEVICE, 1);

    // A browser rotating its keys is not a reader reading a notice. If the
    // ON CONFLICT clause touched `defaults_version`, the notice would be
    // swallowed by the very devices it exists for.
    const refreshed = upsertPushSubscription(db, {
      endpoint: LEGACY_DEVICE,
      p256dh: 'rotated',
      auth: 'rotated',
      deviceLabel: 'Old Phone (updated)',
    });

    expect(refreshed.keys.p256dh).toBe('rotated');
    expect(refreshed.defaultsVersion).toBe(0);
    expect(pushSubscriptionNeedsDefaultsNotice(refreshed)).toBe(true);
  });

  it('clears the marker when the reader adopts the new default, in one write', () => {
    seedLegacySubscription(LEGACY_DEVICE, 1);

    const updated = updatePushSubscriptionPreferences(db, LEGACY_DEVICE, {
      enabledCompletion: false,
      acknowledgeDefaultsNotice: true,
    });

    expect(updated?.enabledCompletion).toBe(false);
    expect(updated?.defaultsVersion).toBe(PUSH_DEFAULTS_VERSION);
    expect(pushSubscriptionNeedsDefaultsNotice(updated!)).toBe(false);
  });

  it('clears the marker when the reader declines, without moving a toggle', () => {
    seedLegacySubscription(LEGACY_DEVICE, 1);

    const updated = updatePushSubscriptionPreferences(db, LEGACY_DEVICE, {
      acknowledgeDefaultsNotice: true,
    });

    // Declining is a decision, not a no-op: the notice must not come back, and
    // nothing the reader chose to keep may move.
    expect(updated?.enabledPrompt).toBe(true);
    expect(updated?.enabledCompletion).toBe(true);
    expect(pushSubscriptionNeedsDefaultsNotice(updated!)).toBe(false);
  });

  it('does not let an ordinary preference change silently clear the marker', () => {
    seedLegacySubscription(LEGACY_DEVICE, 1);

    updatePushSubscriptionPreferences(db, LEGACY_DEVICE, { enabledPrompt: false });

    // Toggling something else is not being told about the defaults change.
    expect(getPushSubscriptionByEndpoint(db, LEGACY_DEVICE)?.defaultsVersion).toBe(0);
  });

  it('cannot be un-acknowledged by a stale client payload', () => {
    upsertPushSubscription(db, { endpoint: NEW_DEVICE, p256dh: 'p', auth: 'a' });

    const updated = updatePushSubscriptionPreferences(db, NEW_DEVICE, {
      acknowledgeDefaultsNotice: false,
      enabledCompletion: true,
    });

    expect(updated?.defaultsVersion).toBe(PUSH_DEFAULTS_VERSION);
  });
});

describe('v57 registration (Issue #2056)', () => {
  it('advances the schema version the runner claims to support', () => {
    // Without this the future-schema guard (#1353) would fire on the *second*
    // start of every upgraded install: v57 on disk, v56 in the build.
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('rolls back and re-applies cleanly', () => {
    rollbackMigrations(db, 56);
    expect(getCurrentVersion(db)).toBe(56);
    expect(
      (db.prepare('PRAGMA table_info(push_subscriptions)').all() as Array<{ name: string }>).some(
        (c) => c.name === 'defaults_version'
      )
    ).toBe(false);

    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      (db.prepare('PRAGMA table_info(push_subscriptions)').all() as Array<{ name: string }>).some(
        (c) => c.name === 'defaults_version'
      )
    ).toBe(true);
  });
});

describe('applying v57 stops no notification and starts none (Epic #2002 criterion 6)', () => {
  it('leaves the fan-out for every kind byte-identical across the migration', () => {
    rollbackMigrations(db, 56);

    // Populate at v56, the way a real upgraded database is populated.
    seedLegacySubscription(LEGACY_DEVICE, 1);
    seedLegacySubscription(LEGACY_QUIET_DEVICE, 0);
    db.prepare(
      `INSERT INTO push_subscriptions
         (id, endpoint, p256dh, auth, device_label, enabled_prompt, enabled_completion, locale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`
    ).run('new-id', NEW_DEVICE, 'p', 'a', 'New Phone', 'en', 2, 2);

    const before = rawFanOut();
    const togglesBefore = db
      .prepare(
        'SELECT endpoint, enabled_prompt, enabled_completion FROM push_subscriptions ORDER BY endpoint'
      )
      .all();

    runMigrations(db);

    expect(fanOut()).toEqual(before);
    expect(
      db
        .prepare(
          'SELECT endpoint, enabled_prompt, enabled_completion FROM push_subscriptions ORDER BY endpoint'
        )
        .all()
    ).toEqual(togglesBefore);

    // And the marker is what tells the two populations apart afterwards.
    expect(getPushSubscriptionByEndpoint(db, LEGACY_DEVICE)?.defaultsVersion).toBe(0);
    expect(getPushSubscriptionByEndpoint(db, NEW_DEVICE)?.defaultsVersion).toBe(0);
  });
});
