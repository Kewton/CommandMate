/**
 * Migration v51: task_events (Issue #1548, Phase 3-1).
 *
 * An append-only log of every attempt to move a task's status. v50 recorded
 * where a task *is*; this records how it got there — which is what "how many
 * times did a human have to intervene" and "how many re-instruction loops did
 * this take" are computed from (Phase 4 Eval). Neither question is answerable
 * from a status column that only ever holds the latest value.
 *
 * `to_status` is nullable on purpose: a rejected transition is written with
 * `to_status = NULL`. An event the state machine refused is evidence that some
 * caller believed a transition was possible when it was not, and silently
 * dropping it would hide exactly the wiring bug worth finding.
 *
 * No CHECK constraint on `event`, unlike `tasks.status` in v50. The status
 * vocabulary is written by many callers and read by queries that branch on it;
 * events have a single writer (`applyTaskEvent`) whose input is a closed
 * TypeScript union, so a CHECK here would only add a migration to the cost of
 * adding an event without closing a hole the type system leaves open.
 *
 * No foreign key to `tasks` for the same reason v50's
 * `last_verification_run_id` has none: this table is history, and history that
 * disappears when its subject is deleted cannot be audited afterwards.
 *
 * Timestamps are epoch milliseconds (INTEGER), matching v44 onward.
 */

import type { Migration } from './runner';

export const v51_migrations: Migration[] = [
  {
    version: 51,
    name: 'add-task-events',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          event TEXT NOT NULL,
          from_status TEXT NOT NULL,
          to_status TEXT,
          payload_json TEXT,
          created_at INTEGER NOT NULL
        );
      `);

      // (task_id, created_at) is the only read pattern: one task's history in
      // order. id breaks ties, because same-millisecond events are ordinary —
      // a rejected transition and its retry can land in the same tick.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_task_events_task
          ON task_events(task_id, created_at);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS task_events;');
    },
  },
];
