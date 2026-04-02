/** Migration definitions for version 24: daily_reports table for daily summary feature. */

import type { Migration } from './runner';

export const v24_migrations: Migration[] = [
  {
    version: 24,
    name: 'add-daily-reports-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE daily_reports (
          date TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          generated_by_tool TEXT NOT NULL,
          model TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
      `);

      console.log('Created daily_reports table');
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS daily_reports');
      console.log('Dropped daily_reports table');
    },
  },
];
