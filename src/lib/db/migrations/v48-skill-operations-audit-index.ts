/**
 * Migration v48: audit version transition and feed indexes (Issue #1248).
 *
 * Two things the applied-state dashboard needs that v44 does not provide.
 *
 * **`from_version` / `to_version`.** v44 records a single `skill_version`, which
 * answers "what version was this operation about" but not "what replaced what".
 * An update is exactly a transition, and reading one out of two adjacent audit
 * rows is guesswork the log should not require. Both columns are nullable
 * because the ends of the timeline are genuinely open: an install onto an empty
 * target has no `from`, an uninstall has no `to`.
 *
 * **Feed indexes.** The existing `idx_skill_operations_target` leads with
 * `worktree_id`, so it cannot serve the dashboard's cross-worktree "newest
 * first" query, and the "show me only the failures" filter has no index at all.
 * Both are added here rather than left to a full scan that grows with history —
 * the table is append-only, so it only ever gets longer.
 *
 * `ALTER TABLE ... ADD COLUMN` is DDL and does not fire the v44 append-only
 * triggers, so existing rows are preserved and read back with NULL transitions.
 */

import type { Migration } from './runner';

export const v48_migrations: Migration[] = [
  {
    version: 48,
    name: 'add-skill-operations-audit-index',
    up: (db) => {
      db.exec('ALTER TABLE skill_operations ADD COLUMN from_version TEXT;');
      db.exec('ALTER TABLE skill_operations ADD COLUMN to_version TEXT;');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_operations_recent
          ON skill_operations(recorded_at DESC, id DESC);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_operations_result
          ON skill_operations(result, recorded_at DESC);
      `);
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_skill_operations_result;');
      db.exec('DROP INDEX IF EXISTS idx_skill_operations_recent;');

      // SQLite < 3.35 cannot DROP COLUMN; rebuild without the two columns. The
      // append-only triggers are recreated afterwards: DROP TABLE removes the
      // triggers bound to the old table, and a log without them is not the log.
      db.exec('DROP TRIGGER IF EXISTS skill_operations_no_delete;');
      db.exec('DROP TRIGGER IF EXISTS skill_operations_no_update;');
      db.exec(`
        CREATE TABLE skill_operations__v47 (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          binding_hash TEXT NOT NULL,
          operation TEXT NOT NULL,
          state TEXT NOT NULL,
          result TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          worktree_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          skill_version TEXT,
          source_origin TEXT,
          source_repository TEXT,
          source_ref TEXT,
          source_commit TEXT,
          artifact_sha256 TEXT,
          error_code TEXT,
          error_message TEXT,
          recorded_at INTEGER NOT NULL
        );
      `);
      db.exec(`
        INSERT INTO skill_operations__v47 (
          id, operation_id, idempotency_key, binding_hash, operation, state, result,
          actor_type, actor_id, worktree_id, skill_id, skill_version,
          source_origin, source_repository, source_ref, source_commit, artifact_sha256,
          error_code, error_message, recorded_at
        )
        SELECT
          id, operation_id, idempotency_key, binding_hash, operation, state, result,
          actor_type, actor_id, worktree_id, skill_id, skill_version,
          source_origin, source_repository, source_ref, source_commit, artifact_sha256,
          error_code, error_message, recorded_at
        FROM skill_operations;
      `);
      db.exec('DROP TABLE skill_operations;');
      db.exec('ALTER TABLE skill_operations__v47 RENAME TO skill_operations;');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_operations_operation_id
          ON skill_operations(operation_id);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_operations_idempotency_key
          ON skill_operations(idempotency_key);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_skill_operations_target
          ON skill_operations(worktree_id, skill_id, recorded_at);
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS skill_operations_no_update
        BEFORE UPDATE ON skill_operations
        BEGIN
          SELECT RAISE(ABORT, 'skill_operations is append-only');
        END;
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS skill_operations_no_delete
        BEFORE DELETE ON skill_operations
        BEGIN
          SELECT RAISE(ABORT, 'skill_operations is append-only');
        END;
      `);
    },
  },
];
