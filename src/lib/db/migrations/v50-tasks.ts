/**
 * Migration v50: tasks (Issue #1545, Phase 2-1).
 *
 * The table the execution contract lands in. Until now a message sent to an
 * agent left only a `chat_messages` row: what the agent was *supposed* to do,
 * which paths it was allowed to touch, and what would count as done existed
 * nowhere the system could read back. A task row is that record.
 *
 * `contract_json` is a parsed snapshot, not a path to re-read. A contract file
 * edited after the send must not retroactively change what the running task
 * agreed to — otherwise "did it meet the contract?" has no fixed answer.
 * `contract_path` is kept alongside it for provenance only.
 *
 * The `status` vocabulary is CHECK-constrained because the distinctions are the
 * point of the table and a typo landing as a new value would create a bucket
 * nothing queries:
 *   pending       — row exists, message not sent yet
 *   running       — sent; the agent is working
 *   waiting_input — blocked on a prompt (used by the Phase 3-1 state machine)
 *   verifying     — a verification run is in flight for this task
 *   succeeded     — that run came back `passed`
 *   failed        — the run came back `failed`, or no verdict was reachable
 *   not_started   — the run came back `not_started` (no work evidence at all)
 *   cancelled     — abandoned explicitly
 *
 * `last_verification_run_id` deliberately carries no REFERENCES clause, for the
 * same reason `verification_runs.task_id` (v49) does not point here: the two
 * tables reference each other, so a foreign key in either direction would order
 * the migrations against themselves. Application code keeps them consistent.
 *
 * Timestamps are epoch milliseconds (INTEGER), matching v44 onward.
 */

import type { Migration } from './runner';

export const v50_migrations: Migration[] = [
  {
    version: 50,
    name: 'add-tasks',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          instance_id TEXT,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          contract_path TEXT,
          contract_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','running','waiting_input','verifying','succeeded','failed','not_started','cancelled')),
          last_verification_run_id INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_worktree
          ON tasks(worktree_id, created_at DESC);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS tasks;');
    },
  },
];
