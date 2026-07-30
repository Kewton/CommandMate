/**
 * task_events row I/O (Issue #1548, migration v51).
 *
 * `insertTaskEvent` is deliberately NOT re-exported from the `@/lib/db` barrel.
 * The log is only meaningful if every row was produced by a real state-machine
 * decision, so the sole writer is `applyTaskEvent`
 * (`@/lib/tasks/task-transition-service`), which imports this module directly.
 * A caller reaching for the barrel gets the reader and nothing else.
 */

import type Database from 'better-sqlite3';
import type { TaskStatus } from './tasks-db';

/**
 * Structured detail attached to an event.
 *
 * A closed shape rather than an open record: the fields exist to be queried by
 * Phase 4 Eval, and a free-form bag would let each firing point invent its own
 * key for the same thing.
 */
export interface TaskEventPayload {
  /** Verification run the event belongs to. */
  runId?: number;
  /** Prompt classification, for the prompt_* events. */
  promptType?: string;
  /** Why a caller raised the event, when that is not obvious from the event. */
  reason?: string;
}

export interface TaskEventRecord {
  id: number;
  taskId: string;
  event: string;
  fromStatus: TaskStatus;
  /** null when the state machine rejected the transition. */
  toStatus: TaskStatus | null;
  payload: TaskEventPayload | null;
  createdAt: Date;
}

export interface InsertTaskEventInput {
  taskId: string;
  event: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus | null;
  payload?: TaskEventPayload;
  /** Epoch ms; the caller supplies it so a transition and its event share one. */
  createdAt: number;
}

interface TaskEventRow {
  id: number;
  task_id: string;
  event: string;
  from_status: string;
  to_status: string | null;
  payload_json: string | null;
  created_at: number;
}

function mapRow(row: TaskEventRow): TaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    event: row.event,
    fromStatus: row.from_status as TaskStatus,
    toStatus: row.to_status as TaskStatus | null,
    payload: row.payload_json === null ? null : (JSON.parse(row.payload_json) as TaskEventPayload),
    createdAt: new Date(row.created_at),
  };
}

/** Append one event. See the module comment for why this is not barrel-exported. */
export function insertTaskEvent(db: Database.Database, input: InsertTaskEventInput): number {
  // An empty payload is stored as NULL rather than '{}': "nothing was attached"
  // and "an empty object was attached" are the same fact, and one of them makes
  // the column readable at a glance.
  const payloadJson =
    input.payload === undefined || Object.keys(input.payload).length === 0
      ? null
      : JSON.stringify(input.payload);

  const info = db
    .prepare(`
      INSERT INTO task_events (task_id, event, from_status, to_status, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(input.taskId, input.event, input.fromStatus, input.toStatus, payloadJson, input.createdAt);

  return Number(info.lastInsertRowid);
}

/**
 * One task's history, oldest first.
 *
 * `id ASC` breaks ties rather than leaving same-millisecond rows in an arbitrary
 * order — a rejected transition and the retry that followed it routinely share a
 * timestamp, and reading them out of order inverts the story they tell.
 */
export function listTaskEvents(
  db: Database.Database,
  taskId: string,
  limit = 200
): TaskEventRecord[] {
  const rows = db
    .prepare(`
      SELECT id, task_id, event, from_status, to_status, payload_json, created_at
      FROM task_events
      WHERE task_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `)
    .all(taskId, limit) as TaskEventRow[];

  return rows.map(mapRow);
}
