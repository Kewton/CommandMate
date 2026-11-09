/**
 * Migration v69: what the promote path of mem keeps (Issue #4225). Design:
 * `docs/design/mem-promote-4225.md` §6.1.
 *
 * - `mem_promote_previews`: the diff a person is shown, with everything an approval
 *   is bound to (the item's version and fingerprint, the destination, the
 *   destination's content it was made against, the body, the poster). The operation
 *   id that goes into the body's mark is fixed here, so the body never changes after
 *   it was shown.
 * - `mem_promote_operations`: one approved external write. The approval's validity
 *   (the preview) and the delivery (the attempt's outcome) are kept apart.
 * - `mem_promote_attempts`: each try of an operation, with its outcome
 *   (`success` / `failure` / `unknown`). An unknown outcome is never read as not sent.
 *
 * No foreign key to `mem_items` (a purge must not take the record of an unknown
 * write with it), and no column named `worktree_id` (a worktree's delete must not
 * take it either, as `getWorktreeChildTables()` would).
 *
 * The rollback drops the three tables, which forgets what was written outside.
 */

import type { Migration } from './runner';

export const v69_migrations: Migration[] = [
  {
    version: 69,
    name: 'mem-promote',
    up: (db) => {
      db.exec(`
        CREATE TABLE mem_promote_previews (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          item_id TEXT NOT NULL,
          item_version INTEGER NOT NULL,
          item_fingerprint TEXT NOT NULL,
          repository_id TEXT NOT NULL,
          branch TEXT,
          destination TEXT NOT NULL,
          base_fingerprint TEXT NOT NULL,
          body TEXT NOT NULL,
          body_sha256 TEXT NOT NULL,
          effect TEXT NOT NULL CHECK (effect IN ('spec','record_only')),
          quote_origin TEXT NOT NULL CHECK (quote_origin IN ('agent','human','none')),
          quote_confirmed_at INTEGER,
          rules_version INTEGER NOT NULL,
          context_worktree_id TEXT NOT NULL,
          context_worktree_incarnation TEXT NOT NULL,
          acknowledged_operation_ids TEXT NOT NULL,
          poster_host TEXT,
          poster_id INTEGER,
          poster_login TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          invalidated_reason TEXT
        );
        CREATE INDEX idx_mem_promote_previews_item ON mem_promote_previews(item_id);

        CREATE TABLE mem_promote_operations (
          id TEXT PRIMARY KEY,
          preview_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          item_version INTEGER NOT NULL,
          item_fingerprint TEXT NOT NULL,
          context_worktree_id TEXT NOT NULL,
          context_worktree_incarnation TEXT NOT NULL,
          destination_worktree_incarnation TEXT,
          poster_id INTEGER,
          repository_id TEXT NOT NULL,
          branch TEXT,
          destination_kind TEXT NOT NULL CHECK (destination_kind IN ('issue_comment','worktree_doc')),
          destination TEXT NOT NULL,
          base_fingerprint TEXT NOT NULL,
          body TEXT NOT NULL,
          body_sha256 TEXT NOT NULL,
          block TEXT,
          effect TEXT NOT NULL CHECK (effect IN ('spec','record_only')),
          quote_origin TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('approved','in_flight','succeeded','failed','unknown','abandoned')),
          result_ref TEXT,
          transition_pending INTEGER NOT NULL DEFAULT 0,
          transition_reason TEXT,
          concurrent_edit INTEGER NOT NULL DEFAULT 0,
          unknown_reason TEXT,
          decided_by TEXT CHECK (decided_by IN ('server','human')),
          approved_at INTEGER NOT NULL,
          settled_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_mem_promote_active ON mem_promote_operations(item_id)
          WHERE state IN ('approved','in_flight','unknown') OR (state = 'succeeded' AND transition_pending = 1);
        CREATE INDEX idx_mem_promote_operations_item ON mem_promote_operations(item_id);

        CREATE TABLE mem_promote_attempts (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL REFERENCES mem_promote_operations(id) ON DELETE CASCADE,
          boot_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          outcome TEXT CHECK (outcome IN ('success','failure','unknown')),
          reason TEXT
        );
        CREATE UNIQUE INDEX idx_mem_promote_attempt_open ON mem_promote_attempts(operation_id) WHERE ended_at IS NULL;
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS mem_promote_attempts;
        DROP TABLE IF EXISTS mem_promote_operations;
        DROP TABLE IF EXISTS mem_promote_previews;
      `);
    },
  },
];
