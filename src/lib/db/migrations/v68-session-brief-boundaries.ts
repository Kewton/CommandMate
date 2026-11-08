/**
 * Migration v68: the ledger of session boundaries a brief is put in front of once
 * (Issue #4274). Design: `docs/design/session-boundary-brief-4274.md` §3.2.
 *
 * One row per conversation boundary of one (worktree, instance): a launch, a reset,
 * a resume, a restart, or an explicit `--with-brief`. A process generation and a
 * conversation are kept apart: a reconnect opens no row, and the same boundary is
 * claimed by one send only. The rows live in the database so the "once" outlives a
 * server restart (the generation of #4115 is in memory).
 *
 * `worktree_id` follows the convention `getWorktreeChildTables()` looks for, so a row
 * follows a worktree id rename and goes with its worktree. Holds no body: the brief
 * itself is never stored, only its size, its mode and the notice ids it carried.
 *
 * v68, not v67: #4222 adds v67 in parallel (PM decision, 2026-11-08). The runner
 * applies every version above the current one, so a database at v66 reaches v68
 * whether or not v67 exists in this build.
 *
 * The rollback drops the table, which forgets which boundaries were served.
 */

import type { Migration } from './runner';

export const v68_migrations: Migration[] = [
  {
    version: 68,
    name: 'session-brief-boundaries',
    up: (db) => {
      db.exec(`
        CREATE TABLE session_brief_boundaries (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          instance_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          instance_incarnation TEXT,
          on_roster INTEGER NOT NULL DEFAULT 0,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('launch','auto_restart','reset','resume','explicit')),
          evidence TEXT NOT NULL CHECK (evidence IN ('launch','hook','send_command','explicit')),
          conversation_id TEXT,
          late INTEGER NOT NULL DEFAULT 0,
          opened_at INTEGER NOT NULL,
          observation_key TEXT,
          opened_by_send TEXT,
          reset_send_token TEXT,
          state TEXT NOT NULL CHECK (state IN ('pending','claimed','sent','unknown','superseded','skipped')),
          skip_reason TEXT,
          claim_token TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_outcome TEXT CHECK (last_outcome IN ('not_sent','unknown','sent')),
          brief_bytes INTEGER,
          brief_mode TEXT,
          included_ids TEXT,
          settled_at INTEGER,
          UNIQUE (worktree_id, instance_id, seq)
        );
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS session_brief_boundaries');
    },
  },
];
