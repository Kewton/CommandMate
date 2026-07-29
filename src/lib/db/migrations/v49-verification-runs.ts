/**
 * Migration v49: verification_runs / verification_gate_results (Issue #1542).
 *
 * The first place an *interactive* agent's work gets a recorded verdict.
 * `execution_logs` already stores status + exit_code + result, but only for
 * scheduled executions; interactive sessions leave nothing behind but
 * `chat_messages`, so "the agent finished" has never been distinguishable from
 * "the agent produced something that passes".
 *
 * One run per verification attempt, one gate result per command inside it.
 * Gate results cascade with their run: a run is the only thing that gives a
 * gate result meaning, so an orphan row is not a record, it is noise.
 *
 * Both status vocabularies are CHECK-constrained rather than validated in the
 * writer alone. The distinctions they encode are the point of the table and a
 * typo that lands as a new status value would silently create a bucket nothing
 * queries:
 *   run.not_started — the work-evidence gate failed (no commits, no diff);
 *                     distinct from `failed`, which means the work was judged.
 *   run.error       — the runner broke before any gate ran (bad config, spawn
 *                     failure); no verdict was reached about the work at all.
 *   gate.skipped    — deliberately not run (e.g. skipInPrimaryCheckout); the
 *                     reason belongs in log_tail so a skip is never mistaken
 *                     for a pass.
 *
 * `task_id` is a free column, not a foreign key: the `tasks` table arrives in
 * Phase 2 (#1545). Declaring a REFERENCES clause against a table that does not
 * exist yet would make every insert fail once foreign_keys is ON.
 *
 * Timestamps are epoch milliseconds (INTEGER), matching v44 onward.
 */

import type { Migration } from './runner';

export const v49_migrations: Migration[] = [
  {
    version: 49,
    name: 'add-verification-runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS verification_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          worktree_id TEXT NOT NULL,
          instance_id TEXT,
          task_id TEXT,
          trigger TEXT NOT NULL CHECK (trigger IN ('manual','wait','api','task')),
          status TEXT NOT NULL CHECK (status IN ('running','passed','failed','not_started','error','cancelled')),
          base_ref TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS verification_gate_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,
          gate_id TEXT NOT NULL,
          command TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running','passed','failed','timeout','skipped','error')),
          exit_code INTEGER,
          duration_ms INTEGER,
          log_tail TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_verification_runs_worktree
          ON verification_runs(worktree_id, started_at DESC);
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_verification_gate_results_run
          ON verification_gate_results(run_id);
      `);
    },
    down: (db) => {
      // Child first, mirroring the dependency direction. Under
      // PRAGMA foreign_keys = ON (how db-instance.ts opens the database) the
      // reverse order also works today, but only because the cascade absorbs
      // the parent's implicit DELETE — that is a property of the cascade, not
      // of DROP TABLE.
      db.exec('DROP TABLE IF EXISTS verification_gate_results;');
      db.exec('DROP TABLE IF EXISTS verification_runs;');
    },
  },
];
