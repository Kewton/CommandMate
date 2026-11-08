/**
 * Migration v66: the mem store (Issue #4221). Design: `docs/design/mem-store-4221.md` §10.
 *
 * - Settings are per registered root (`mem_repository_settings`, `mem_branch_rules`,
 *   `mem_branch_overrides`) and go with the root (CASCADE). No default rule is
 *   inserted: a repository without rules is `off` (D3).
 * - Items (`mem_items`) carry `repository_id` + branch and survive their worktree, so
 *   the column naming the worktree is `origin_worktree_id`, not `worktree_id`, which
 *   `getWorktreeChildTables()` would sweep with the worktree (§10.3).
 * - The incarnation tables and `session_note_versions` ARE worktree children: they
 *   follow a rename and go with a delete.
 * - `session_notes` gains the columns that make a #2427 note the `now` of mem (D7).
 *   Existing rows get `version = 1` and stay plain notes (`mem_item_id IS NULL`).
 *
 * The rollback drops what this added. SQLite drops columns one at a time.
 */

import type { Migration } from './runner';

const SESSION_NOTE_COLUMNS: ReadonlyArray<[string, string]> = [
  ['version', 'INTEGER NOT NULL DEFAULT 1'],
  ['mem_item_id', 'TEXT'],
  ['mem_repository_id', 'TEXT'],
  ['mem_branch', 'TEXT'],
  ['mem_cli_tool_id', 'TEXT'],
  ['mem_incarnation', 'TEXT'],
  ['mem_worktree_incarnation', 'TEXT'],
  ['mem_session_generation', 'TEXT'],
  ['mem_close_when', 'TEXT'],
  ['mem_evidence', 'TEXT'],
  ['mem_checked_rules_version', 'INTEGER'],
  ['created_by', 'TEXT'],
  ['updated_by', 'TEXT'],
  ['created_at', 'INTEGER'],
];

export const v66_migrations: Migration[] = [
  {
    version: 66,
    name: 'mem-store',
    up: (db) => {
      db.exec(`
        CREATE TABLE mem_repository_settings (
          repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
          inject_on_start INTEGER NOT NULL DEFAULT 0 CHECK (inject_on_start IN (0,1)),
          prompt_on_events INTEGER NOT NULL DEFAULT 0 CHECK (prompt_on_events IN (0,1)),
          popup INTEGER NOT NULL DEFAULT 0 CHECK (popup IN (0,1)),
          version INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE mem_branch_rules (
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          match TEXT NOT NULL CHECK (match IN ('glob','detached')),
          pattern TEXT,
          mode TEXT NOT NULL CHECK (mode IN ('off','derived','on')),
          PRIMARY KEY (repository_id, position),
          CHECK ((match = 'glob') = (pattern IS NOT NULL))
        );

        CREATE TABLE mem_branch_overrides (
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          branch TEXT NOT NULL,
          mode TEXT CHECK (mode IN ('off','derived','on')),
          inject_on_start INTEGER CHECK (inject_on_start IN (0,1)),
          prompt_on_events INTEGER CHECK (prompt_on_events IN (0,1)),
          popup INTEGER CHECK (popup IN (0,1)),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (repository_id, branch)
        );

        CREATE TABLE mem_instance_incarnations (
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          instance_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          incarnation TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (worktree_id, instance_id)
        );

        CREATE TABLE mem_worktree_incarnations (
          worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE CASCADE,
          incarnation TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE session_note_versions (
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          instance_id TEXT NOT NULL,
          last_version INTEGER NOT NULL,
          PRIMARY KEY (worktree_id, instance_id)
        );

        CREATE TABLE mem_items (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          branch TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('now','waiting','decision','next','external','note')),
          state TEXT NOT NULL CHECK (state IN ('open','recorded','promoted','closed')),
          text TEXT NOT NULL,
          close_when TEXT,
          promote_to TEXT,
          quote TEXT,
          quote_at INTEGER,
          evidence TEXT,
          origin_worktree_id TEXT NOT NULL,
          origin_worktree_incarnation TEXT NOT NULL,
          origin_instance_id TEXT NOT NULL,
          origin_cli_tool_id TEXT NOT NULL,
          origin_incarnation TEXT NOT NULL,
          origin_session_generation TEXT,
          created_by TEXT NOT NULL CHECK (created_by IN ('agent','human')),
          updated_by TEXT NOT NULL CHECK (updated_by IN ('agent','human','server')),
          updated_by_instance TEXT,
          version INTEGER NOT NULL,
          checked_rules_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          closed_at INTEGER,
          close_reason TEXT CHECK (close_reason IN ('manual','condition','superseded','slot-removed','withdrawn')),
          close_note TEXT,
          idempotency_key TEXT,
          request_fingerprint TEXT,
          CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
          CHECK (kind = 'decision' OR state IN ('open','closed')),
          CHECK ((idempotency_key IS NULL) = (request_fingerprint IS NULL))
        );
        CREATE UNIQUE INDEX idx_mem_items_key ON mem_items(origin_incarnation, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX idx_mem_items_scope ON mem_items(repository_id, branch, state, kind);
      `);
      for (const [name, type] of SESSION_NOTE_COLUMNS) {
        db.exec(`ALTER TABLE session_notes ADD COLUMN ${name} ${type}`);
      }
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS mem_items;
        DROP TABLE IF EXISTS session_note_versions;
        DROP TABLE IF EXISTS mem_worktree_incarnations;
        DROP TABLE IF EXISTS mem_instance_incarnations;
        DROP TABLE IF EXISTS mem_branch_overrides;
        DROP TABLE IF EXISTS mem_branch_rules;
        DROP TABLE IF EXISTS mem_repository_settings;
      `);
      for (const [name] of [...SESSION_NOTE_COLUMNS].reverse()) {
        db.exec(`ALTER TABLE session_notes DROP COLUMN ${name}`);
      }
    },
  },
];
