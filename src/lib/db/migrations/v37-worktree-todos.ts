/** Migration v37: Add worktree_todos table (branch-scoped ToDo list, Issue #1015).
 *
 * A lightweight, checkbox-style ToDo list scoped to a worktree (branch). Mirrors
 * the established worktree_memos pattern: linkage uses worktrees.id and rows are
 * removed via ON DELETE CASCADE when the worktree row is physically deleted.
 *
 * This is intentionally distinct from repository_todos (v34, Home widget). The
 * two ToDo features coexist independently: repository_todos is repository-scoped
 * (Home page), worktree_todos is branch-scoped (worktree detail screen).
 */

import type { Migration } from './runner';

export const v37_migrations: Migration[] = [
  {
    version: 37,
    name: 'add-worktree-todos',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worktree_todos (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          content TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktree_todos_wt
          ON worktree_todos(worktree_id, position);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS worktree_todos;');
    },
  },
];
