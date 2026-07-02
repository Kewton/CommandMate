/** Migration v36: Add branch column to worktrees (Issue #1003).
 *
 * `ls --branch` historically filtered on the worktree `name` field, which for
 * sync-generated worktrees is the git branch but for others can diverge (the id
 * slug / display name). To let `ls --branch` filter on the real branch, we
 * persist the branch captured at sync time (scanWorktrees) in a dedicated
 * column.
 *
 * This is a third, distinct branch concept from the two that already exist:
 *   - worktrees.initial_branch (Issue #111): branch recorded at session start.
 *   - gitStatus.currentBranch: the live branch resolved on read.
 *   - worktrees.branch (this migration): sync-time snapshot from `git worktree list`.
 *
 * No backfill: there is no in-DB source for the real branch, so the column is
 * NULL-initialized and populated on the next sync (scanWorktrees -> upsert).
 * Consumers fall back to `name` while the column is NULL, preserving legacy
 * behavior. The column is nullable so existing rows and non-sync writers (which
 * omit branch) are unaffected.
 */

import type { Migration } from './runner';

export const v36_migrations: Migration[] = [
  {
    version: 36,
    name: 'add-branch-to-worktrees',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN branch TEXT;
      `);

      // No backfill: no in-DB source for the real branch. Populated on next sync.
      console.log('Added branch column to worktrees table');
    },
    down: () => {
      // SQLite cannot drop a column without a table rebuild; no-op rollback
      // (mirrors the v35 timer instance_id migration).
      console.log('No rollback for branch column (SQLite limitation)');
    },
  },
];
