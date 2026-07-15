/**
 * Migration v41: Add push_subscriptions table for Web Push notifications (Issue #1125).
 *
 * One row per browser push subscription (device). `endpoint` is the natural key
 * (unique) used for upsert and for 410-Gone auto-removal. Per-type toggles let a
 * device opt in/out of "prompt waiting" and "completion" notifications independently.
 */

import type { Migration } from './runner';

export const v41_migrations: Migration[] = [
  {
    version: 41,
    name: 'add-push-subscriptions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id TEXT PRIMARY KEY,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          device_label TEXT,
          enabled_prompt INTEGER NOT NULL DEFAULT 1,
          enabled_completion INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint
          ON push_subscriptions(endpoint);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS push_subscriptions;');
    },
  },
];
