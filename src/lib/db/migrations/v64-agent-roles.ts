/**
 * Migration v64: roles (Epic #4112, Issue #4114).
 *
 * ## The three states of a setting
 *
 * A level holds a role, an explicit "no role", or nothing, in which case the next
 * level decides. No row is "nothing" and a NULL `role_id` is the explicit none.
 * The system level has no explicit none (`role_id NOT NULL`): it is the last level.
 *
 * ## Why no reference to `agent_roles` is `ON DELETE SET NULL`
 *
 * NULL means "explicitly none", so a deleted role would quietly become a decision
 * nobody made. They are `RESTRICT`, and `deleteAgentRole` with `force` removes the
 * rows in one transaction, which reads as "inherit".
 *
 * ## Why `agent_instance_roles` is its own table
 *
 * `setAgentInstances` deletes and re-inserts every roster row, so a column on
 * `agent_instances` would be wiped by each rename and reorder (the same reason as
 * v59). It has no foreign key to `agent_instances` for the same reason: the
 * replace would cascade into it. `pruneAgentInstanceRoles` removes the ids that
 * really left. `worktree_id` follows the convention `getWorktreeChildTables()`
 * looks for, so a row follows a worktree id rename and goes with its worktree.
 *
 * ## The launch record
 *
 * A snapshot of what was resolved, kept as evidence, so `repository_id` and
 * `role_id` are deliberately not foreign keys: a deleted role or repository
 * must neither take the evidence along nor block a `force` delete. There is no
 * body and no secret column. Nothing updates a row, but there is deliberately no
 * `RAISE(ABORT)` trigger enforcing that: `getWriteGuardedTables` reads one as
 * "append-only ledger" and the row would no longer follow a worktree id rename.
 *
 * The rollback drops the five tables, which is the whole of what this adds.
 */

import type { Migration } from './runner';

/** In dependency order. The rollback drops them from the end. */
export const V64_AGENT_ROLE_TABLES = [
  'agent_roles',
  'agent_role_system_defaults',
  'agent_role_repository_defaults',
  'agent_instance_roles',
  'agent_role_launch_records',
] as const;

export const v64_migrations: Migration[] = [
  {
    version: 64,
    name: 'agent-roles',
    up: (db) => {
      db.exec(`
        CREATE TABLE agent_roles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          body TEXT NOT NULL,
          body_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE agent_role_system_defaults (
          cli_tool_id TEXT PRIMARY KEY,
          role_id TEXT NOT NULL REFERENCES agent_roles(id) ON DELETE RESTRICT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE agent_role_repository_defaults (
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          cli_tool_id TEXT NOT NULL,
          role_id TEXT REFERENCES agent_roles(id) ON DELETE RESTRICT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (repository_id, cli_tool_id)
        );

        CREATE TABLE agent_instance_roles (
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          instance_id TEXT NOT NULL,
          role_id TEXT REFERENCES agent_roles(id) ON DELETE RESTRICT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (worktree_id, instance_id)
        );

        CREATE TABLE agent_role_launch_records (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          instance_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('requested','launched')),
          session_generation TEXT NOT NULL,
          source TEXT NOT NULL,
          repository_id TEXT,
          role_id TEXT,
          role_name TEXT,
          body_version INTEGER,
          body_fingerprint TEXT,
          injection_fingerprint TEXT,
          artifact_fingerprint TEXT,
          adapter_id TEXT,
          adapter_version TEXT,
          wrapper_version TEXT,
          artifact_path TEXT,
          effective_agent TEXT,
          composition_source_fingerprint TEXT,
          no_role_reason TEXT,
          recorded_at INTEGER NOT NULL,
          UNIQUE (worktree_id, instance_id, session_generation, phase)
        );

        CREATE INDEX idx_agent_role_repository_defaults_role ON agent_role_repository_defaults(role_id);
        CREATE INDEX idx_agent_instance_roles_role ON agent_instance_roles(role_id);
        CREATE INDEX idx_agent_role_system_defaults_role ON agent_role_system_defaults(role_id);
        CREATE INDEX idx_agent_role_launch_records_latest
          ON agent_role_launch_records(worktree_id, instance_id, phase, recorded_at);
      `);
    },
    down: (db) => {
      for (const table of [...V64_AGENT_ROLE_TABLES].reverse()) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    },
  },
];
