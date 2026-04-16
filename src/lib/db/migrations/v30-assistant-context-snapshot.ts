/** Migration v30: Add startup context snapshot column for assistant conversations. */

import type { Migration } from './runner';

export const v30_migrations: Migration[] = [
  {
    version: 30,
    name: 'add-assistant-context-snapshot',
    up: (db) => {
      db.exec(`
        ALTER TABLE assistant_conversations
        ADD COLUMN context_snapshot TEXT;
      `);
    },
    down: (db) => {
      db.exec(`
        ALTER TABLE assistant_conversations
        DROP COLUMN context_snapshot;
      `);
    },
  },
];
