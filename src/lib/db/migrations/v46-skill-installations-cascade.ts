/**
 * Migration v46: `skill_installations` follows the worktree it belongs to (Issue #1430).
 *
 * v45 created the table with `worktree_id TEXT NOT NULL` and no foreign key, so
 * deleting a worktree left its install rows behind forever (`UNIQUE(worktree_id,
 * skill_id)` keeps them). Recreating a worktree at the same path mints a new
 * UUID, so the UI reports "not installed" while the payload and receipt are
 * still on disk: re-install fails with SKILL_INSTALL_DESTINATION_EXISTS and
 * uninstall has no record to act on.
 *
 * The fix follows the convention every other worktree-scoped table already uses
 * — `ON DELETE CASCADE` — rather than an explicit DELETE at one call site. Two
 * reasons beyond consistency: `deleteWorktreesByIds` is not the only path that
 * removes a worktree row, and `migrateWorktreeIdPreservingChildren` (#1151)
 * discovers child tables through `PRAGMA foreign_key_list`, so the constraint is
 * also what makes a same-directory branch switch *carry* installs forward
 * instead of orphaning them.
 *
 * SQLite cannot add a constraint in place, so the table is rebuilt (same pattern
 * as v33). Rows whose worktree is already gone are dropped by the copy filter,
 * which is what clears the dangling rows existing databases have accumulated —
 * `PRAGMA foreign_keys` cannot be toggled inside the migration transaction, so
 * the filter must be in the SELECT rather than deferred to the constraint.
 */

import type Database from 'better-sqlite3';
import type { Migration } from './runner';

const COLUMNS = `
  id, worktree_id, skill_id, version, install_root, receipt_sha256,
  source_repository, source_ref, source_commit, artifact_sha256,
  effective_risk, operation_id, installed_at, updated_at
`;

const COLUMN_DEFINITIONS = `
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  install_root TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  source_repository TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  effective_risk TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (worktree_id, skill_id)
`;

function createIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skill_installations_worktree
      ON skill_installations(worktree_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_skill_installations_skill
      ON skill_installations(skill_id, version);
  `);
}

export const v46_migrations: Migration[] = [
  {
    version: 46,
    name: 'skill-installations-worktree-cascade',
    up: (db) => {
      db.exec(`
        CREATE TABLE skill_installations_new (
          ${COLUMN_DEFINITIONS},
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      // The WHERE clause is the dangling-row sweep: rows pointing at a worktree
      // that no longer exists are not carried over.
      db.exec(`
        INSERT INTO skill_installations_new (${COLUMNS})
        SELECT ${COLUMNS} FROM skill_installations
        WHERE worktree_id IN (SELECT id FROM worktrees);
      `);

      const dangling = db
        .prepare(
          `SELECT COUNT(*) AS n FROM skill_installations
           WHERE worktree_id NOT IN (SELECT id FROM worktrees)`
        )
        .get() as { n: number };

      // Dropping the table drops its indexes too; recreate them on the new one.
      db.exec('DROP TABLE skill_installations;');
      db.exec('ALTER TABLE skill_installations_new RENAME TO skill_installations;');
      createIndexes(db);

      if (dangling.n > 0) {
        console.log(`Removed ${dangling.n} skill_installations row(s) with no worktree`);
      }
      console.log('skill_installations now cascades with its worktree');
    },
    down: (db) => {
      db.exec(`
        CREATE TABLE skill_installations_old (
          ${COLUMN_DEFINITIONS}
        );
      `);
      db.exec(`
        INSERT INTO skill_installations_old (${COLUMNS})
        SELECT ${COLUMNS} FROM skill_installations;
      `);
      db.exec('DROP TABLE skill_installations;');
      db.exec('ALTER TABLE skill_installations_old RENAME TO skill_installations;');
      createIndexes(db);

      console.log('Rolled back skill_installations cascade (v46)');
    },
  },
];
