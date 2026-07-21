/**
 * Migration v47: `skill_installations.install_roots` (Issue #1460).
 *
 * A package is now placed into more than one discovery root — `.agents/skills`
 * (Codex) and `.claude/skills` (Claude) — so the index needs to record the full
 * set, not just the primary `install_root`. The column is a JSON array of
 * repository-relative roots, primary first.
 *
 * Nullable and added by `ALTER TABLE`, so it is backward compatible: rows written
 * before this migration keep `install_root` and read back as the single root they
 * name. The on-disk receipt remains the source of truth; this column, like the
 * rest of the row, is a rebuildable index over it (#1235).
 */

import type { Migration } from './runner';

export const v47_migrations: Migration[] = [
  {
    version: 47,
    name: 'add-skill-installations-roots',
    up: (db) => {
      db.exec('ALTER TABLE skill_installations ADD COLUMN install_roots TEXT;');
    },
    down: (db) => {
      // SQLite < 3.35 cannot DROP COLUMN; rebuild the table without it. The
      // column is nullable and index-only, so no data of record is lost.
      db.exec(`
        CREATE TABLE skill_installations__v46 (
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
        );
      `);
      db.exec(`
        INSERT INTO skill_installations__v46 (
          id, worktree_id, skill_id, version, install_root, receipt_sha256,
          source_repository, source_ref, source_commit, artifact_sha256,
          effective_risk, operation_id, installed_at, updated_at
        )
        SELECT
          id, worktree_id, skill_id, version, install_root, receipt_sha256,
          source_repository, source_ref, source_commit, artifact_sha256,
          effective_risk, operation_id, installed_at, updated_at
        FROM skill_installations;
      `);
      db.exec('DROP TABLE skill_installations;');
      db.exec('ALTER TABLE skill_installations__v46 RENAME TO skill_installations;');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_installations_worktree
          ON skill_installations(worktree_id);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_installations_skill
          ON skill_installations(skill_id, version);
      `);
    },
  },
];
