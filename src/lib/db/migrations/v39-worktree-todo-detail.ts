/** Migration v39: Add detail column to worktree_todos (ToDo detail, Issue #1034).
 *
 * Extends the branch-scoped ToDo list (v37, 3-state v38) with a free-text
 * `detail` field so each item can carry supplementary notes beyond the
 * single-line `content` (subject).
 *
 * `detail` is NOT NULL with an empty-string default, so existing rows migrate
 * harmlessly to an empty detail. `down()` is a no-op: SQLite cannot drop a
 * column without a table rebuild (mirrors the v35/v36/v38 column-add migrations).
 */

import type { Migration } from './runner';

export const v39_migrations: Migration[] = [
  {
    version: 39,
    name: 'add-detail-to-worktree-todos',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktree_todos
          ADD COLUMN detail TEXT NOT NULL DEFAULT '';
      `);
    },
    down: () => {
      // SQLite cannot drop a column without a table rebuild; no-op rollback
      // (mirrors the v35/v36/v38 column-add migrations).
    },
  },
];
