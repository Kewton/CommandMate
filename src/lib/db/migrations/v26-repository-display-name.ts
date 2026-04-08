/** Migration v26: Add display_name column to repositories table (Issue #642). */

import type { Migration } from './runner';

export const v26_migrations: Migration[] = [
  {
    version: 26,
    name: 'add-repository-display-name',
    up: (db) => {
      db.exec('ALTER TABLE repositories ADD COLUMN display_name TEXT;');
      console.log('Added display_name column to repositories table');
    },
    down: (db) => {
      // SQLite does not support DROP COLUMN in older versions,
      // but better-sqlite3 with recent SQLite supports it
      db.exec('ALTER TABLE repositories DROP COLUMN display_name;');
      console.log('Removed display_name column from repositories table');
    },
  },
];
