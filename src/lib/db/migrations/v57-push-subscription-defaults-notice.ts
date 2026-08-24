/**
 * Migration v57: mark which generation of *defaults* a push subscription was
 * created under (Issue #2056).
 *
 * Epic #2002's completion criteria do not both hold for rows that already
 * exist. Criterion 3 wants ordinary completions to be off by default; criterion
 * 6 wants no notification to stop unintentionally. A migration that flipped
 * `enabled_completion` to 0 across the table satisfies the first and breaks the
 * second — "my notifications went quiet" is indistinguishable from "my
 * notifications broke". Doing nothing satisfies the second and breaks the first.
 *
 * The way out is consent: tell the reader, and let them choose. Then the change
 * is no longer *unintentional* and both criteria hold. This column is the only
 * schema that costs — it records whether this device has been told.
 *
 * **This migration changes no notification behaviour whatsoever.** Nothing reads
 * `defaults_version` when fanning out: {@link getPushSubscriptionsForKind} and
 * {@link countPushSubscriptionsForKind} still filter on `enabled_prompt` /
 * `enabled_completion` alone. Applying it stops zero notifications and starts
 * zero notifications — which is exactly what criterion 6 asks for, and what
 * `push-subscription-defaults-notice-2056.test.ts` asserts by counting the
 * fan-out on both sides of the migration.
 *
 * `NOT NULL DEFAULT 0` is the whole trick. SQLite backfills the constant into
 * every existing row, and 0 means "created before #2000 changed the defaults" —
 * precisely the population that was never told. `upsertPushSubscription()` binds
 * `PUSH_DEFAULTS_VERSION` on INSERT, so rows created from here on start already
 * informed, and the `ON CONFLICT` clause deliberately leaves the column alone so
 * that a legacy device re-registering does not silently mark itself as told.
 *
 * The rollback is real, like v42's and unlike v35/v40's no-ops: `DROP COLUMN`
 * has been supported since SQLite 3.35 and this column carries no index and no
 * constraint, so the drop needs no table rebuild.
 */

import type { Migration } from './runner';

export const v57_migrations: Migration[] = [
  {
    version: 57,
    name: 'add-defaults-version-to-push-subscriptions',
    up: (db) => {
      db.exec(`
        ALTER TABLE push_subscriptions
          ADD COLUMN defaults_version INTEGER NOT NULL DEFAULT 0;
      `);
    },
    down: (db) => {
      db.exec(`
        ALTER TABLE push_subscriptions DROP COLUMN defaults_version;
      `);
    },
  },
];
