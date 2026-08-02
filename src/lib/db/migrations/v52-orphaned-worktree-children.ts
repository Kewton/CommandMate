/**
 * Migration v52: delete child rows pointing at a worktree that no longer exists
 * (Issue #1621, Phase 0).
 *
 * `getWorktreeChildTables` used to enumerate child tables from foreign-key
 * metadata alone, so `tasks` (#1548), `verification_runs` (#1544) and
 * `skill_operations` (#1428) — each holding a `worktree_id` with no constraint
 * declared — were invisible to both the rename path and the delete path. No
 * CASCADE fires without a foreign key, so every worktree deleted since those
 * tables landed left their rows behind, and every worktree ID rename left them
 * addressing an ID nothing resolves. The code fix stops new orphans; this
 * migration removes the ones already written.
 *
 * The sweep reuses the shared enumeration rather than naming tables, so the
 * FK-less tables above and the FK-declared ones are treated identically — an
 * orphan in a CASCADE table is equally unreachable, it just needed a
 * `foreign_keys = OFF` window to be created.
 *
 * Three deliberate narrowings:
 *
 * - Append-only ledgers are excluded (`getDeletableWorktreeChildTables`).
 *   `skill_operations` holds a `worktree_id` and does have rows referencing
 *   worktrees that are gone, but it declares `BEFORE DELETE ... RAISE(ABORT)`
 *   (#1234) and is read across every worktree by the audit feed. Deleting from
 *   it aborts the statement, which here would roll back the migration and take
 *   startup with it (measured). Its rows are history, not orphans.
 * - `worktree_id IS NULL` rows are left alone. Every current child table
 *   declares the column NOT NULL, so this cannot fire today; if a future table
 *   makes it nullable, a NULL means "not attached", not "attached to something
 *   gone", and deleting it would be data loss rather than cleanup.
 * - `verification_gate_results` has no `worktree_id` and is not swept directly.
 *   It reaches its worktree through `verification_runs(id) ON DELETE CASCADE`,
 *   so deleting the orphaned runs takes its rows with them (better-sqlite3
 *   enables `foreign_keys` by default, and db-instance.ts sets it explicitly).
 *   `task_events` is *not* in the same position: v51 declares no foreign key to
 *   `tasks` on purpose, because history that vanishes with its subject cannot
 *   be audited afterwards. That is a design choice, not an orphan, so it stays.
 */

import type { Migration } from './runner';
import { getDeletableWorktreeChildTables } from './worktree-child-tables';

export const v52_migrations: Migration[] = [
  {
    version: 52,
    name: 'delete-orphaned-worktree-children',
    up: (db) => {
      let deleted = 0;
      for (const { table, column } of getDeletableWorktreeChildTables(db)) {
        // Identifiers come from sqlite_master / PRAGMA, never from user input.
        // The alias is `cm_parent` rather than something short like `w` so it
        // cannot collide with a child table that happens to be named the same.
        const result = db
          .prepare(
            `DELETE FROM "${table}"
              WHERE "${column}" IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM worktrees AS cm_parent
                  WHERE cm_parent.id = "${table}"."${column}"
                )`
          )
          .run();
        if (result.changes > 0) {
          console.log(
            `Deleted ${result.changes} orphaned row(s) from ${table}.${column}`
          );
          deleted += result.changes;
        }
      }
      if (deleted === 0) {
        console.log('No orphaned worktree child rows found');
      }
    },
    down: () => {
      // Deleted rows cannot be resurrected. Defined anyway so rollback tooling
      // (and the tests that rebuild a v51 database) keep working.
      console.log('No rollback for orphaned child row cleanup (rows are gone)');
    },
  },
];
