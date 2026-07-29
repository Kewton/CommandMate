/**
 * Verification run database operations (Issue #1542, migration v49).
 *
 * Persists the outcome of a verification gate run: one `verification_runs` row
 * per attempt, one `verification_gate_results` row per command inside it.
 *
 * Both create* functions open a record in `running` state and both finish*
 * functions close it. That split is deliberate: a run that crashes mid-flight
 * leaves a `running` row behind, which is recoverable evidence, whereas a
 * single write-on-completion would leave nothing at all.
 *
 * The finish* functions throw when the target row does not exist. A silent
 * no-op would let a caller believe it recorded a verdict it never recorded —
 * exactly the failure this table exists to make impossible.
 */

import Database from 'better-sqlite3';

/** What caused a verification run to start. */
export type VerificationTrigger = 'manual' | 'wait' | 'api' | 'task';

/**
 * Overall verdict of a run.
 *
 * `not_started` = the work-evidence gate failed (no commits, no uncommitted
 * changes), so there was nothing to verify. `error` = the runner broke before
 * any gate produced a verdict (bad config, spawn failure); distinct from
 * `failed`, which means the work was judged and found wanting.
 */
export type VerificationRunStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'not_started'
  | 'error'
  | 'cancelled';

/** Statuses a run can be closed with. `running` is an opening state only. */
export type VerificationRunTerminalStatus = Exclude<VerificationRunStatus, 'running'>;

/**
 * Verdict of a single gate.
 *
 * `skipped` = deliberately not run (e.g. skipInPrimaryCheckout); the reason
 * belongs in `logTail` so a skip is never read as a pass.
 */
export type VerificationGateStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'timeout'
  | 'skipped'
  | 'error';

/** Statuses a gate result can be closed with. */
export type VerificationGateTerminalStatus = Exclude<VerificationGateStatus, 'running'>;

/** One verification attempt against a worktree. */
export interface VerificationRun {
  id: number;
  worktreeId: string;
  /** Agent instance the run is attributed to; null for worktree-level runs. */
  instanceId: string | null;
  /** Free column until the `tasks` table lands in Phase 2 (#1545). No FK. */
  taskId: string | null;
  trigger: VerificationTrigger;
  status: VerificationRunStatus;
  /** Git ref the work was diffed against; null when the run did not need one. */
  baseRef: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** One command executed inside a run. */
export interface VerificationGateResult {
  id: number;
  runId: number;
  gateId: string;
  command: string;
  status: VerificationGateStatus;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** A run together with its gate results, in execution order. */
export interface VerificationRunWithGates extends VerificationRun {
  gates: VerificationGateResult[];
}

/** Fields needed to open a run. */
export interface CreateVerificationRunInput {
  worktreeId: string;
  trigger: VerificationTrigger;
  instanceId?: string | null;
  taskId?: string | null;
  baseRef?: string | null;
}

/** Fields needed to open a gate result. */
export interface CreateGateResultInput {
  gateId: string;
  command: string;
}

/** Outcome written when a gate finishes. Omitted fields are stored as NULL. */
export interface FinishGateResultPatch {
  status: VerificationGateTerminalStatus;
  exitCode?: number | null;
  durationMs?: number | null;
  logTail?: string | null;
}

interface VerificationRunRow {
  id: number;
  worktree_id: string;
  instance_id: string | null;
  task_id: string | null;
  trigger: string;
  status: string;
  base_ref: string | null;
  started_at: number;
  finished_at: number | null;
}

interface VerificationGateResultRow {
  id: number;
  run_id: number;
  gate_id: string;
  command: string;
  status: string;
  exit_code: number | null;
  duration_ms: number | null;
  log_tail: string | null;
  started_at: number;
  finished_at: number | null;
}

const RUN_COLUMNS = `
  id, worktree_id, instance_id, task_id, trigger, status, base_ref, started_at, finished_at
`;

const GATE_COLUMNS = `
  id, run_id, gate_id, command, status, exit_code, duration_ms, log_tail, started_at, finished_at
`;

function mapRunRow(row: VerificationRunRow): VerificationRun {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    instanceId: row.instance_id,
    taskId: row.task_id,
    trigger: row.trigger as VerificationTrigger,
    status: row.status as VerificationRunStatus,
    baseRef: row.base_ref,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  };
}

function mapGateRow(row: VerificationGateResultRow): VerificationGateResult {
  return {
    id: row.id,
    runId: row.run_id,
    gateId: row.gate_id,
    command: row.command,
    status: row.status as VerificationGateStatus,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    logTail: row.log_tail,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  };
}

/** Open a run in `running` state. */
export function createVerificationRun(
  db: Database.Database,
  input: CreateVerificationRunInput
): VerificationRun {
  const now = Date.now();
  const info = db
    .prepare(`
      INSERT INTO verification_runs (
        worktree_id, instance_id, task_id, trigger, status, base_ref, started_at, finished_at
      )
      VALUES (?, ?, ?, ?, 'running', ?, ?, NULL)
    `)
    .run(
      input.worktreeId,
      input.instanceId ?? null,
      input.taskId ?? null,
      input.trigger,
      input.baseRef ?? null,
      now
    );

  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM verification_runs WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as VerificationRunRow | undefined;

  if (!row) {
    throw new Error('Failed to persist verification run');
  }
  return mapRunRow(row);
}

/** Close a run with its final verdict, stamping `finished_at`. */
export function finishVerificationRun(
  db: Database.Database,
  runId: number,
  status: VerificationRunTerminalStatus
): void {
  const info = db
    .prepare('UPDATE verification_runs SET status = ?, finished_at = ? WHERE id = ?')
    .run(status, Date.now(), runId);

  if (info.changes === 0) {
    throw new Error(`Verification run ${runId} not found`);
  }
}

/** Open a gate result under an existing run, in `running` state. */
export function createGateResult(
  db: Database.Database,
  runId: number,
  input: CreateGateResultInput
): VerificationGateResult {
  const now = Date.now();
  const info = db
    .prepare(`
      INSERT INTO verification_gate_results (
        run_id, gate_id, command, status, exit_code, duration_ms, log_tail, started_at, finished_at
      )
      VALUES (?, ?, ?, 'running', NULL, NULL, NULL, ?, NULL)
    `)
    .run(runId, input.gateId, input.command, now);

  const row = db
    .prepare(`SELECT ${GATE_COLUMNS} FROM verification_gate_results WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as VerificationGateResultRow | undefined;

  if (!row) {
    throw new Error('Failed to persist verification gate result');
  }
  return mapGateRow(row);
}

/** Close a gate result with its outcome, stamping `finished_at`. */
export function finishGateResult(
  db: Database.Database,
  gateResultId: number,
  patch: FinishGateResultPatch
): void {
  const info = db
    .prepare(`
      UPDATE verification_gate_results
      SET status = ?, exit_code = ?, duration_ms = ?, log_tail = ?, finished_at = ?
      WHERE id = ?
    `)
    .run(
      patch.status,
      patch.exitCode ?? null,
      patch.durationMs ?? null,
      patch.logTail ?? null,
      Date.now(),
      gateResultId
    );

  if (info.changes === 0) {
    throw new Error(`Verification gate result ${gateResultId} not found`);
  }
}

/** Fetch a run with its gate results, or null when the run does not exist. */
export function getVerificationRun(
  db: Database.Database,
  runId: number
): VerificationRunWithGates | null {
  const runRow = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM verification_runs WHERE id = ?`)
    .get(runId) as VerificationRunRow | undefined;

  if (!runRow) {
    return null;
  }

  const gateRows = db
    .prepare(`
      SELECT ${GATE_COLUMNS} FROM verification_gate_results
      WHERE run_id = ?
      ORDER BY started_at ASC, id ASC
    `)
    .all(runId) as VerificationGateResultRow[];

  return { ...mapRunRow(runRow), gates: gateRows.map(mapGateRow) };
}

/**
 * Most recent runs for a worktree, newest first.
 *
 * `id DESC` breaks ties: runs started within the same millisecond are common
 * enough that without it the "newest first" contract would be unordered.
 */
export function listVerificationRuns(
  db: Database.Database,
  worktreeId: string,
  limit = 20
): VerificationRun[] {
  const rows = db
    .prepare(`
      SELECT ${RUN_COLUMNS} FROM verification_runs
      WHERE worktree_id = ?
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `)
    .all(worktreeId, limit) as VerificationRunRow[];

  return rows.map(mapRunRow);
}
