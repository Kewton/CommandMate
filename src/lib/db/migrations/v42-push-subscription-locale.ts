/**
 * Migration v42: Add locale column to push_subscriptions (Issue #1308).
 *
 * Push bodies are built by the background poller, which has no request scope and
 * therefore cannot resolve the reader's locale the way `src/i18n.ts` does
 * (cookie -> Accept-Language). Registration *does* have a request, so we capture
 * the locale there and read it back at send time.
 *
 * Backward compatibility: nullable with no backfill. Subscriptions registered
 * before v42 keep `locale = NULL`, which the sender resolves to DEFAULT_LOCALE.
 * Such rows self-heal the next time the browser re-registers the subscription.
 */

import type { Migration } from './runner';

export const v42_migrations: Migration[] = [
  {
    version: 42,
    name: 'add-locale-to-push-subscriptions',
    up: (db) => {
      db.exec(`
        ALTER TABLE push_subscriptions ADD COLUMN locale TEXT;
      `);
    },
    // Unlike the v35/v40 no-op rollbacks, this one is real: DROP COLUMN has been
    // supported since SQLite 3.35 (2021) and `locale` is carried by no index or
    // constraint, so the drop needs no table rebuild.
    down: (db) => {
      db.exec(`
        ALTER TABLE push_subscriptions DROP COLUMN locale;
      `);
    },
  },
];
