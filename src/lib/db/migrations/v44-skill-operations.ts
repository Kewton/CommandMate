/**
 * Migration v44: append-only skill_operations audit log (Issue #1234).
 *
 * One row per audit event, not per operation: a single operationId appends a row
 * when it fails and another when reconciliation converges it, so the sequence of
 * events survives instead of being overwritten. Append-only is enforced in the
 * database by BEFORE UPDATE/DELETE triggers rather than by convention, so a bug
 * or a direct sqlite3 session cannot silently rewrite history.
 *
 * Source coordinates (repository/ref/resolved commit/artifact digest) are stored
 * as separate columns so an install can be traced back to an immutable source
 * without parsing a blob. No column holds a URL, token or machine-absolute path.
 */

import type { Migration } from './runner';

export const v44_migrations: Migration[] = [
  {
    version: 44,
    name: 'add-skill-operations',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_operations (
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
    down: (db) => {
      // Triggers first: the delete guard would otherwise be the only thing
      // standing between a rollback and an ABORT on any later cleanup.
      db.exec('DROP TRIGGER IF EXISTS skill_operations_no_delete;');
      db.exec('DROP TRIGGER IF EXISTS skill_operations_no_update;');
      db.exec('DROP TABLE IF EXISTS skill_operations;');
    },
  },
];
