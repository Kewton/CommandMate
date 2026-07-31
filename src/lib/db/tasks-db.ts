/**
 * Task database operations (Issue #1545, migration v50).
 *
 * A task row is the durable record of an execution contract: the goal that was
 * sent, the paths the agent was allowed to touch, the gates that decide
 * completion, and where the task got to. `contract_json` holds the *parsed
 * snapshot* taken at send time, so editing the contract file afterwards cannot
 * change what a running task agreed to.
 *
 * `updateTaskStatus` throws when the row does not exist. A silent no-op would
 * let a caller believe it recorded a transition it never recorded — the same
 * failure `verification-db.ts` guards against.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { TaskContract } from '@/lib/tasks/contract-parser';

/**
 * Lifecycle of a task.
 *
 * The runtime tuple mirrors the `status` CHECK constraint in migration v50 and
 * is what callers validate untrusted input against, so a status cannot be
 * accepted by an API route and then rejected by SQLite.
 *
 * `not_started` is distinct from `failed`: the work was never produced, so
 * nothing was judged. `failed` means a verdict was reached, or that no verdict
 * could be reached at all — either way the task did not pass.
 */
export const TASK_STATUSES = [
  'pending',
  'running',
  'waiting_input',
  'verifying',
  'succeeded',
  'failed',
  'not_started',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a task can no longer move out of. */
export const TERMINAL_TASK_STATUSES = [
  'succeeded',
  'failed',
  'not_started',
  'cancelled',
] as const satisfies readonly TaskStatus[];

export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

/**
 * Statuses that mean "this task is the one a verification run belongs to".
 *
 * `pending` is excluded on purpose: nothing has been sent, so there is no work
 * a run could be judging.
 */
export const ACTIVE_TASK_STATUSES = [
  'running',
  'waiting_input',
  'verifying',
] as const satisfies readonly TaskStatus[];

export function isTerminalTaskStatus(status: TaskStatus): status is TerminalTaskStatus {
  return (TERMINAL_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}

export interface Task {
  id: string;
  worktreeId: string;
  cliToolId: string;
  /** Agent instance the task was sent to; null for the primary instance. */
  instanceId: string | null;
  title: string;
  goal: string;
  /** Contract path relative to the worktree root, recorded for provenance. */
  contractPath: string | null;
  /** Parsed contract as it was at send time. */
  contract: TaskContract;
  status: TaskStatus;
  /** Most recent verification run for this task; no FK (see migration v50). */
  lastVerificationRunId: number | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface CreateTaskInput {
  worktreeId: string;
  cliToolId: string;
  instanceId?: string | null;
  contractPath?: string | null;
  contract: TaskContract;
  /** Defaults to 'pending': the row exists before the message is sent. */
  status?: TaskStatus;
}

export interface UpdateTaskStatusPatch {
  /** Recorded alongside the transition; omitted leaves the existing value. */
  lastVerificationRunId?: number;
}

interface TaskRow {
  id: string;
  worktree_id: string;
  cli_tool_id: string;
  instance_id: string | null;
  title: string;
  goal: string;
  contract_path: string | null;
  contract_json: string;
  status: string;
  last_verification_run_id: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const TASK_COLUMNS = `
  id, worktree_id, cli_tool_id, instance_id, title, goal, contract_path, contract_json,
  status, last_verification_run_id, created_at, updated_at, started_at, finished_at
`;

function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    cliToolId: row.cli_tool_id,
    instanceId: row.instance_id,
    title: row.title,
    goal: row.goal,
    contractPath: row.contract_path,
    contract: JSON.parse(row.contract_json) as TaskContract,
    status: row.status as TaskStatus,
    lastVerificationRunId: row.last_verification_run_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  };
}

/** Insert a task, `pending` unless the caller says otherwise. */
export function createTask(db: Database.Database, input: CreateTaskInput): Task {
  const now = Date.now();
  const id = randomUUID();
  const status = input.status ?? 'pending';

  db.prepare(`
    INSERT INTO tasks (
      id, worktree_id, cli_tool_id, instance_id, title, goal, contract_path, contract_json,
      status, last_verification_run_id, created_at, updated_at, started_at, finished_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
  `).run(
    id,
    input.worktreeId,
    input.cliToolId,
    input.instanceId ?? null,
    input.contract.title,
    input.contract.goal,
    input.contractPath ?? null,
    JSON.stringify(input.contract),
    status,
    now,
    now,
    status === 'pending' ? null : now
  );

  const task = getTask(db, id);
  if (!task) {
    throw new Error('Failed to persist task');
  }
  return task;
}

export function getTask(db: Database.Database, taskId: string): Task | null {
  const row = db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
    .get(taskId) as TaskRow | undefined;

  return row ? mapTaskRow(row) : null;
}

/**
 * Tasks for a worktree, newest first.
 *
 * `rowid DESC` breaks ties, not `id DESC`: ids are random UUIDs, so comparing
 * them orders same-millisecond rows arbitrarily. rowid is insertion order, which
 * is what "newest" means when two tasks share a timestamp.
 */
export function listTasks(db: Database.Database, worktreeId: string, limit = 20): Task[] {
  const rows = db
    .prepare(`
      SELECT ${TASK_COLUMNS} FROM tasks
      WHERE worktree_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(worktreeId, limit) as TaskRow[];

  return rows.map(mapTaskRow);
}

/**
 * Move a task to `status`, stamping the timestamps that status implies.
 *
 * `started_at` is written on the first transition out of `pending` and never
 * overwritten — it records when the work began, not when it last changed state.
 * `finished_at` is written for terminal statuses only.
 *
 * @throws Error when the task does not exist
 */
export function updateTaskStatus(
  db: Database.Database,
  taskId: string,
  status: TaskStatus,
  patch: UpdateTaskStatusPatch = {}
): Task {
  const now = Date.now();
  const info = db
    .prepare(`
      UPDATE tasks
      SET status = ?,
          updated_at = ?,
          started_at = CASE WHEN ? = 'pending' THEN started_at ELSE COALESCE(started_at, ?) END,
          finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END,
          last_verification_run_id = COALESCE(?, last_verification_run_id)
      WHERE id = ?
    `)
    .run(
      status,
      now,
      status,
      now,
      isTerminalTaskStatus(status) ? 1 : 0,
      now,
      patch.lastVerificationRunId ?? null,
      taskId
    );

  if (info.changes === 0) {
    throw new Error(`Task ${taskId} not found`);
  }

  return getTask(db, taskId) as Task;
}

/**
 * The task a verification run for this worktree belongs to, or null.
 *
 * Filters are applied only when supplied. A verification run is worktree-scoped
 * — the gates execute over the whole working tree and a worktree admits one run
 * at a time — so the runner resolves without filters and takes the most recently
 * updated active task.
 */
export function getActiveTask(
  db: Database.Database,
  worktreeId: string,
  cliToolId?: string,
  instanceId?: string
): Task | null {
  const conditions = ['worktree_id = ?'];
  const params: unknown[] = [worktreeId];

  if (cliToolId !== undefined) {
    conditions.push('cli_tool_id = ?');
    params.push(cliToolId);
  }
  if (instanceId !== undefined) {
    conditions.push('instance_id = ?');
    params.push(instanceId);
  }

  const placeholders = ACTIVE_TASK_STATUSES.map(() => '?').join(', ');
  const row = db
    .prepare(`
      SELECT ${TASK_COLUMNS} FROM tasks
      WHERE ${conditions.join(' AND ')} AND status IN (${placeholders})
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `)
    .get(...params, ...ACTIVE_TASK_STATUSES) as TaskRow | undefined;

  return row ? mapTaskRow(row) : null;
}

/**
 * The active task governing one agent instance, or null.
 *
 * Distinct from {@link getActiveTask} because the primary instance is recorded
 * two different ways: `instance_id` is NULL when no `--instance` was given, and
 * the tool id itself (`'claude'`) when `--instance claude` was. Both mean the
 * primary instance, so both must match — `= ?` cannot express either, since
 * `instance_id = NULL` is never true in SQL.
 *
 * Auto-Yes needs this precision: a contract sent to `codex-2` must not govern
 * the auto-answering of `codex`, and taking the worktree's most recent active
 * task would do exactly that.
 *
 * @param instanceId - Agent instance id; pass the tool id itself for the primary
 */
export function getActiveTaskForInstance(
  db: Database.Database,
  worktreeId: string,
  cliToolId: string,
  instanceId: string
): Task | null {
  const isPrimary = instanceId === cliToolId;
  const placeholders = ACTIVE_TASK_STATUSES.map(() => '?').join(', ');
  const row = db
    .prepare(`
      SELECT ${TASK_COLUMNS} FROM tasks
      WHERE worktree_id = ?
        AND cli_tool_id = ?
        AND (instance_id = ? OR (instance_id IS NULL AND ?))
        AND status IN (${placeholders})
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
      LIMIT 1
    `)
    .get(worktreeId, cliToolId, instanceId, isPrimary ? 1 : 0, ...ACTIVE_TASK_STATUSES) as
    | TaskRow
    | undefined;

  return row ? mapTaskRow(row) : null;
}
