/** Migration definitions for version 25: report_templates table for report template feature. */

import type { Migration } from './runner';

export const v25_migrations: Migration[] = [
  {
    version: 25,
    name: 'add-report-templates-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE report_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
      `);

      console.log('Created report_templates table');
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS report_templates');
      console.log('Dropped report_templates table');
    },
  },
];
