/** Migration v27: Add app_settings table for key-value application settings. */

import type { Migration } from './runner';

export const v27_migrations: Migration[] = [
  {
    version: 27,
    name: 'add-app-settings-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS app_settings');
    },
  },
];
