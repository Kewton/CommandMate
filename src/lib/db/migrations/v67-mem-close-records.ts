/**
 * Migration v67: what a condition's close leaves behind (Issue #4222). Design:
 * `docs/design/mem-close-when-4222.md` §3.1.
 *
 * - `mem_close_records`: one row per close by a condition. The condition being met
 *   and the end's reason / outcome are separate columns (D8).
 * - `mem_notice_attempts`: one brief that carried notices (D sends it).
 * - `mem_notices`: the "it ended" notice of a close, one per close, with the origin
 *   kept apart from whoever receives it (§3.3).
 * - `mem_instance_incarnations.issued_by`: which way an incarnation was made, so only
 *   a roster's new pair counts as "born after the item" (S6, 2nd review ①).
 *
 * No column is named `worktree_id`: `getWorktreeChildTables()` would delete these
 * rows with a worktree (§3.4), and a notice must outlive its author's worktree.
 */

import type { Migration } from './runner';

export const v67_migrations: Migration[] = [
  {
    version: 67,
    name: 'mem-close-records',
    up: (db) => {
      db.exec(`
        CREATE TABLE mem_close_records (
          item_id TEXT PRIMARY KEY REFERENCES mem_items(id) ON DELETE CASCADE,
          condition_json TEXT NOT NULL,
          condition_type TEXT NOT NULL,
          evaluated_version INTEGER NOT NULL,
          observation_json TEXT NOT NULL,
          end_reason TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','unknown')),
          trigger TEXT NOT NULL CHECK (trigger IN ('list','check','brief','preview')),
          triggered_by_worktree_ref TEXT,
          triggered_by_instance_id TEXT,
          closed_at INTEGER NOT NULL
        );

        CREATE TABLE mem_notice_attempts (
          id TEXT PRIMARY KEY,
          boot_id TEXT NOT NULL,
          recipient_worktree_ref TEXT NOT NULL,
          recipient_worktree_incarnation TEXT NOT NULL,
          recipient_instance_id TEXT NOT NULL,
          recipient_incarnation TEXT,
          created_at INTEGER NOT NULL,
          settled_at INTEGER,
          result TEXT CHECK (result IN ('sent','not-sent','indeterminate','abandoned')),
          CHECK ((settled_at IS NULL) = (result IS NULL))
        );

        CREATE TABLE mem_notices (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL UNIQUE REFERENCES mem_items(id) ON DELETE CASCADE,
          repository_id TEXT NOT NULL,
          branch TEXT,
          origin_worktree_ref TEXT NOT NULL,
          origin_worktree_incarnation TEXT NOT NULL,
          origin_instance_id TEXT NOT NULL,
          origin_cli_tool_id TEXT NOT NULL,
          origin_incarnation TEXT NOT NULL,
          item_created_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','reserved','acknowledged')),
          attempt_id TEXT REFERENCES mem_notice_attempts(id),
          attempt_audience TEXT CHECK (attempt_audience IN ('creator','successor')),
          uncertain_count INTEGER NOT NULL DEFAULT 0,
          acknowledged_at INTEGER,
          acknowledged_by TEXT CHECK (acknowledged_by IN ('creator','successor','human')),
          acknowledged_instance_id TEXT,
          acknowledged_incarnation TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          CHECK ((state = 'reserved') = (attempt_id IS NOT NULL)),
          CHECK ((attempt_id IS NULL) = (attempt_audience IS NULL)),
          CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL))
        );
        CREATE INDEX idx_mem_notices_scope ON mem_notices(repository_id, branch, state);

        ALTER TABLE mem_instance_incarnations ADD COLUMN issued_by TEXT CHECK (issued_by IN ('roster','lazy'));
      `);
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_mem_notices_scope;
        DROP TABLE IF EXISTS mem_notices;
        DROP TABLE IF EXISTS mem_notice_attempts;
        DROP TABLE IF EXISTS mem_close_records;
        ALTER TABLE mem_instance_incarnations DROP COLUMN issued_by;
      `);
    },
  },
];
