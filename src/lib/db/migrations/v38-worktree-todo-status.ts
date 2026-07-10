/** Migration v38: Add status column to worktree_todos (3-state ToDo, Issue #1032).
 *
 * Extends the branch-scoped ToDo list (v37) from a binary `done` flag to a
 * three-state `status` ('todo' = not started / 'doing' = in progress /
 * 'done' = completed) so progress is distinguishable at a glance.
 *
 * `status` becomes the source of truth; the legacy `done` column is retained
 * (SQLite cannot drop a column without a table rebuild, and keeping it avoids
 * breaking any raw reader). The DB mapper derives `done := status === 'done'`,
 * and writers keep the two consistent. Existing rows are backfilled from `done`
 * (`done=1` -> 'done', `done=0` -> 'todo').
 */

import type { Migration } from './runner';

export const v38_migrations: Migration[] = [
  {
    version: 38,
    name: 'add-status-to-worktree-todos',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktree_todos
          ADD COLUMN status TEXT NOT NULL DEFAULT 'todo';
      `);

      // Backfill from the legacy binary flag: completed rows become 'done',
      // everything else keeps the 'todo' default.
      db.exec(`
        UPDATE worktree_todos SET status = 'done' WHERE done = 1;
      `);
    },
    down: () => {
      // SQLite cannot drop a column without a table rebuild; no-op rollback
      // (mirrors the v35/v36 column-add migrations).
    },
  },
];
