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
 * The timestamps describe the *execution*, not the writes (Issue #1625): a
 * caller that measured a gate closes the row with the window it measured, so
 * `finished_at - started_at` equals `duration_ms` instead of the gap between
 * two adjacent INSERT/UPDATE statements.
 *
 * The finish* functions throw when the target row does not exist. A silent
 * no-op would let a caller believe it recorded a verdict it never recorded —
 * exactly the failure this table exists to make impossible.
 */

import Database from 'better-sqlite3';

/**
 * What caused a verification run to start.
 *
 * The runtime tuple mirrors the `trigger` CHECK constraint in migration v49 and
 * is the single source callers validate untrusted input against, so a new
 * trigger cannot be accepted by an API route and then rejected by SQLite.
 */
export const VERIFICATION_TRIGGERS = ['manual', 'wait', 'api', 'task'] as const;

export type VerificationTrigger = (typeof VERIFICATION_TRIGGERS)[number];

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
  /**
   * Whether `startedAt`/`finishedAt` are the endpoints of the interval
   * `durationMs` counted (Issue #1625).
   *
   * Derived, not stored. Until #1625 both stamps were written back to back
   * *after* the gate had finished, so they described the write and their
   * difference had nothing to do with `durationMs`. Those rows are history and
   * are never rewritten, so a reader needs a way to tell them apart — this is
   * it, and it is computed rather than backfilled for exactly that reason.
   *
   * The check is sound in both directions. The fixed writer makes it true by
   * construction. A pre-#1625 row can only satisfy it when its window is empty
   * *and* `durationMs` is 0 — because the two writes were adjacent, the window
   * was always ~0 — and a gate that took no measurable time is one whose write
   * time and execution time are the same instant anyway. `false` therefore
   * means "do not read these stamps as timing"; it covers pre-#1625 rows, rows
   * still open, and rows closed by restart reconciliation, which never observed
   * the gate end.
   */
  timingsMeasured: boolean;
}

/** A run together with its gate results, in execution order. */
export interface VerificationRunWithGates extends VerificationRun {
  gates: VerificationGateResult[];
}

/**
 * A gate verdict without its log body (Issue #1593).
 *
 * `logTail` is absent from the type *and* from the SELECT that builds it, so a
 * history listing cannot leak kilobytes of build output per gate no matter what
 * a caller asks for. Reach for {@link getVerificationRun} when the log is what
 * you actually want.
 */
export interface VerificationGateSummary {
  gateId: string;
  status: VerificationGateStatus;
  exitCode: number | null;
  durationMs: number | null;
}

/** A run with per-gate verdicts but no log bodies, for history listings. */
export interface VerificationRunWithGateSummaries extends VerificationRun {
  gates: VerificationGateSummary[];
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

/**
 * The interval a gate actually occupied, in epoch milliseconds (Issue #1625).
 *
 * Declared as one object so the two ends cannot be supplied separately: half a
 * window is worse than none, because it looks like a window.
 */
export interface GateExecutionWindow {
  startedAt: number;
  finishedAt: number;
}

/** Outcome written when a gate finishes. Omitted fields are stored as NULL. */
export interface FinishGateResultPatch {
  status: VerificationGateTerminalStatus;
  exitCode?: number | null;
  durationMs?: number | null;
  logTail?: string | null;
  /**
   * The measured execution window, when the caller has one (Issue #1625).
   *
   * Supplying it replaces the provisional `started_at` written when the row was
   * opened, so the pair brackets exactly what `durationMs` counted rather than
   * the two database writes. Omit it when nothing observed the gate run —
   * restart reconciliation does — and the opening stamp is kept with
   * `finished_at = now`.
   */
  executionWindow?: GateExecutionWindow;
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
    timingsMeasured:
      row.finished_at !== null &&
      row.duration_ms !== null &&
      row.finished_at - row.started_at === row.duration_ms,
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

/**
 * Close a gate result with its outcome and the interval it occupied.
 *
 * `started_at` is rewritten only when the caller declares an
 * {@link FinishGateResultPatch.executionWindow}: the value written when the row
 * was opened is a placeholder for "this gate was entered", and the measured
 * start is a few milliseconds later — after the insert this call is closing.
 * Leaving the placeholder would put that gap inside the reported window.
 */
export function finishGateResult(
  db: Database.Database,
  gateResultId: number,
  patch: FinishGateResultPatch
): void {
  const info = db
    .prepare(`
      UPDATE verification_gate_results
      SET status = ?, exit_code = ?, duration_ms = ?, log_tail = ?,
          started_at = COALESCE(?, started_at),
          finished_at = ?
      WHERE id = ?
    `)
    .run(
      patch.status,
      patch.exitCode ?? null,
      patch.durationMs ?? null,
      patch.logTail ?? null,
      patch.executionWindow?.startedAt ?? null,
      patch.executionWindow?.finishedAt ?? Date.now(),
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
 * The open run for a worktree, or null when none is in flight.
 *
 * A worktree admits one run at a time: two runs sharing a working tree would
 * see each other's build output and their exit codes would describe neither.
 * `id DESC` is a safety net — the invariant says there is at most one row, and
 * if a bug ever breaks it the newest is the one a caller means.
 */
export function getRunningVerificationRun(
  db: Database.Database,
  worktreeId: string
): VerificationRun | null {
  const row = db
    .prepare(`
      SELECT ${RUN_COLUMNS} FROM verification_runs
      WHERE worktree_id = ? AND status = 'running'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(worktreeId) as VerificationRunRow | undefined;

  return row ? mapRunRow(row) : null;
}

/**
 * Every run still marked `running`, across all worktrees, oldest first.
 *
 * Used by startup reconciliation: after a restart no run is actually in flight,
 * so every row this returns is an orphan whose verdict was lost.
 */
export function listRunningVerificationRuns(db: Database.Database): VerificationRun[] {
  const rows = db
    .prepare(`
      SELECT ${RUN_COLUMNS} FROM verification_runs
      WHERE status = 'running'
      ORDER BY id ASC
    `)
    .all() as VerificationRunRow[];

  return rows.map(mapRunRow);
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

/** Default page size for {@link listVerificationRunsForPeriod}. */
export const DEFAULT_RUN_HISTORY_LIMIT = 50;

/** Largest page {@link listVerificationRunsForPeriod} will return. */
export const MAX_RUN_HISTORY_LIMIT = 500;

/** Longest window {@link listVerificationRunsForPeriod} will look back over. */
export const MAX_RUN_HISTORY_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** Options accepted by {@link listVerificationRunsForPeriod}. */
export interface ListVerificationRunsForPeriodOptions {
  /** Restrict to one worktree. Omitted means every worktree. */
  worktreeId?: string;
  /** Look back this many days. Omitted means no lower bound on `started_at`. */
  days?: number;
  /** Page size; clamped to 1..{@link MAX_RUN_HISTORY_LIMIT}. */
  limit?: number;
}

/** Clamp to an integer inside [min, max]; non-finite input falls back to `fallback`. */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Recent runs across worktrees, newest first, each with its gate verdicts but
 * no log bodies (Issue #1593).
 *
 * `worktreeId` is optional because the advisor that consumes this (#1594) looks
 * at a repository's trend, not one worktree's. Ordering follows the same
 * `started_at DESC, id DESC` contract as {@link listVerificationRuns} so both
 * feeds agree about what "newest" means.
 *
 * `days` and `limit` are clamped rather than rejected: this is a read-only feed
 * and a caller asking for 10000 runs wants as many as it can have, not an
 * exception. API routes validate before calling so a user typo still 400s.
 */
export function listVerificationRunsForPeriod(
  db: Database.Database,
  opts: ListVerificationRunsForPeriodOptions = {}
): VerificationRunWithGateSummaries[] {
  const limit = clampInt(opts.limit, DEFAULT_RUN_HISTORY_LIMIT, 1, MAX_RUN_HISTORY_LIMIT);

  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (opts.worktreeId !== undefined) {
    conditions.push('worktree_id = ?');
    params.push(opts.worktreeId);
  }

  if (opts.days !== undefined) {
    const days = clampInt(opts.days, MAX_RUN_HISTORY_DAYS, 1, MAX_RUN_HISTORY_DAYS);
    conditions.push('started_at >= ?');
    params.push(Date.now() - days * MS_PER_DAY);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const runRows = db
    .prepare(`
      SELECT ${RUN_COLUMNS} FROM verification_runs
      ${where}
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `)
    .all(...params, limit) as VerificationRunRow[];

  if (runRows.length === 0) return [];

  const placeholders = runRows.map(() => '?').join(', ');
  const gateRows = db
    .prepare(`
      SELECT run_id, gate_id, status, exit_code, duration_ms
      FROM verification_gate_results
      WHERE run_id IN (${placeholders})
      ORDER BY started_at ASC, id ASC
    `)
    .all(...runRows.map((row) => row.id)) as Array<{
    run_id: number;
    gate_id: string;
    status: string;
    exit_code: number | null;
    duration_ms: number | null;
  }>;

  const byRun = new Map<number, VerificationGateSummary[]>();
  for (const row of gateRows) {
    const summary: VerificationGateSummary = {
      gateId: row.gate_id,
      status: row.status as VerificationGateStatus,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
    };
    const bucket = byRun.get(row.run_id);
    if (bucket) bucket.push(summary);
    else byRun.set(row.run_id, [summary]);
  }

  return runRows.map((row) => ({ ...mapRunRow(row), gates: byRun.get(row.id) ?? [] }));
}
