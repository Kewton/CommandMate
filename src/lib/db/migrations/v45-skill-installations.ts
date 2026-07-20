/**
 * Migration v45: `skill_installations` index (Issue #1235).
 *
 * One row per (worktree, skill): the index answers "what is installed here"
 * without walking every worktree on disk. It is an *index*, not the truth — the
 * receipt inside `.agents/skills/<id>/` is. That ordering is what lets a crash
 * between the atomic rename and this row be reconciled forward (#1234) instead
 * of being reported as a rollback that the filesystem contradicts.
 *
 * `receipt_sha256` is the join back to the payload: reconciliation compares it
 * against the receipt actually on disk, so a row that describes a different
 * install than the one present is detectable rather than merely stale.
 *
 * No column holds a URL, a token or a machine-absolute path; `install_root` is
 * repository-relative by construction.
 */

import type { Migration } from './runner';

export const v45_migrations: Migration[] = [
  {
    version: 45,
    name: 'add-skill-installations',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_installations (
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
        CREATE INDEX IF NOT EXISTS idx_skill_installations_worktree
          ON skill_installations(worktree_id);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_installations_skill
          ON skill_installations(skill_id, version);
      `);
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_skill_installations_skill;');
      db.exec('DROP INDEX IF EXISTS idx_skill_installations_worktree;');
      db.exec('DROP TABLE IF EXISTS skill_installations;');
    },
  },
];
