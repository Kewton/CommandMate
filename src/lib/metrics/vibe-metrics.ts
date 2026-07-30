/**
 * Eval metrics over the harness's own records (Issue #1551, Phase 4).
 *
 * Answers "is the harness actually letting an agent finish work unattended?"
 * from three tables that already exist: `tasks` (what was asked for and how it
 * ended), `verification_runs` / `verification_gate_results` (what the gates
 * said), and `task_events` (how a task got where it is — the only place a
 * human intervention or a re-instruction loop is recorded, because a status
 * column holds one value and forgets every earlier one).
 *
 * Read-only and synchronous: no migration, no new table. Every table is
 * probed in `sqlite_master` before it is queried, so a database that predates
 * v49–v51 degrades to zeros instead of throwing. That matters because the
 * metrics are wired into daily report generation, and a report that fails to
 * generate on an old database would be a regression caused entirely by a
 * feature nobody asked that database to support.
 *
 * A rate whose denominator is zero is `null`, never `0`. "0% of 0 tasks
 * succeeded" reads as a catastrophe and means nothing happened; the two must
 * not be printable as the same string.
 *
 * @module lib/metrics/vibe-metrics
 */

import type Database from 'better-sqlite3';

export const MS_PER_DAY = 86_400_000;

/** Longest window the metrics may be asked for; also the API's `days` cap. */
export const MAX_METRICS_DAYS = 90;

/** How many gates the fail breakdown names before it stops. */
export const GATE_FAIL_BREAKDOWN_LIMIT = 10;

/**
 * Gate verdicts counted as failures in `gateFailBreakdown`.
 *
 * `error` and `skipped` are excluded: neither is a judgement about the work.
 * An `error` gate broke before it could decide anything and a `skipped` one
 * was deliberately not run, so counting either would report gates as failing
 * when nothing failed.
 */
const FAILED_GATE_STATUSES = ['failed', 'timeout'] as const;

/** Task statuses that mean the work did not pass — the retry-loop denominator. */
const UNPASSED_TASK_STATUSES = ['failed', 'not_started'] as const;

export interface VibeTaskMetrics {
  /** Every task created in the window, whatever status it is in now. */
  total: number;
  succeeded: number;
  failed: number;
  notStarted: number;
  cancelled: number;
  /** succeeded / total, as a 0..1 fraction. null when total is 0. */
  successRate: number | null;
  /**
   * Mean number of times a task that did not pass was re-instructed.
   *
   * Numerator: `message_sent` events raised while the task sat in `failed` or
   * `not_started` — the state machine's only re-open path, so each one is one
   * "the agent was told to try again". Denominator: distinct tasks an event in
   * this window moved *into* one of those statuses.
   *
   * Both come from `task_events` alone rather than joining to `tasks`, so the
   * two halves share one filter. A task whose whole history predates v51 is
   * absent from both and cannot skew the mean in either direction.
   *
   * null when nothing failed in the window, or when `task_events` is absent.
   */
  avgRetryLoops: number | null;
}

export interface VibeGateFailure {
  gateId: string;
  failCount: number;
}

export interface VibeVerificationMetrics {
  /** Every run started in the window, including ones still `running`. */
  runs: number;
  passed: number;
  failed: number;
  notStarted: number;
  /** passed / runs, as a 0..1 fraction. null when runs is 0. */
  passRate: number | null;
  /** Worst offenders first, at most GATE_FAIL_BREAKDOWN_LIMIT entries. */
  gateFailBreakdown: VibeGateFailure[];
}

export interface VibeInterventionMetrics {
  /** `prompt_answered_human` events: a person had to unblock the agent. */
  humanResponds: number;
  /** `prompt_answered_auto` events: Auto-Yes unblocked it instead. */
  autoAnswered: number;
  /**
   * Always null in v1.
   *
   * Prompts an Auto-Yes policy refused to answer are only written to the
   * application log (Phase 2-3); nothing persists them to a table, so any
   * number here would be invented. It stays in the shape because the field is
   * what the count will be published as once the log is promoted into
   * `task_events`, and callers that already render it will not need changing.
   */
  suppressedByPolicy: number | null;
}

export interface VibeMetrics {
  /** Window length the numbers cover, echoed back for display. */
  periodDays: number;
  tasks: VibeTaskMetrics;
  verification: VibeVerificationMetrics;
  intervention: VibeInterventionMetrics;
}

export interface VibeMetricsOptions {
  /** Window length in days, ending at `until`. */
  days: number;
  /**
   * Exclusive end of the window, epoch ms. Defaults to now.
   *
   * Daily report generation passes the target day's end so a report for a past
   * date describes that date rather than the last 24 hours.
   */
  until?: number;
}

interface CountRow {
  key: string;
  count: number;
}

interface ScalarRow {
  value: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

/** succeeded/total style rate, or null when the denominator is zero. */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function countsByKey(rows: CountRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.key, row.count);
  }
  return counts;
}

function emptyTaskMetrics(): VibeTaskMetrics {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    notStarted: 0,
    cancelled: 0,
    successRate: null,
    avgRetryLoops: null,
  };
}

function emptyVerificationMetrics(): VibeVerificationMetrics {
  return { runs: 0, passed: 0, failed: 0, notStarted: 0, passRate: null, gateFailBreakdown: [] };
}

function computeTaskCounts(
  db: Database.Database,
  since: number,
  until: number
): Omit<VibeTaskMetrics, 'avgRetryLoops'> {
  const rows = db
    .prepare(`
      SELECT status AS key, COUNT(*) AS count
      FROM tasks
      WHERE created_at >= ? AND created_at < ?
      GROUP BY status
    `)
    .all(since, until) as CountRow[];

  const counts = countsByKey(rows);
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }

  const succeeded = counts.get('succeeded') ?? 0;

  return {
    total,
    succeeded,
    failed: counts.get('failed') ?? 0,
    notStarted: counts.get('not_started') ?? 0,
    cancelled: counts.get('cancelled') ?? 0,
    successRate: rate(succeeded, total),
  };
}

function computeAvgRetryLoops(
  db: Database.Database,
  since: number,
  until: number
): number | null {
  const placeholders = UNPASSED_TASK_STATUSES.map(() => '?').join(', ');

  const reinstructions = (
    db
      .prepare(`
        SELECT COUNT(*) AS value
        FROM task_events
        WHERE created_at >= ? AND created_at < ?
          AND event = 'message_sent'
          AND from_status IN (${placeholders})
      `)
      .get(since, until, ...UNPASSED_TASK_STATUSES) as ScalarRow
  ).value;

  const unpassedTasks = (
    db
      .prepare(`
        SELECT COUNT(DISTINCT task_id) AS value
        FROM task_events
        WHERE created_at >= ? AND created_at < ?
          AND to_status IN (${placeholders})
      `)
      .get(since, until, ...UNPASSED_TASK_STATUSES) as ScalarRow
  ).value;

  return rate(reinstructions, unpassedTasks);
}

function computeVerificationMetrics(
  db: Database.Database,
  since: number,
  until: number
): VibeVerificationMetrics {
  const rows = db
    .prepare(`
      SELECT status AS key, COUNT(*) AS count
      FROM verification_runs
      WHERE started_at >= ? AND started_at < ?
      GROUP BY status
    `)
    .all(since, until) as CountRow[];

  const counts = countsByKey(rows);
  let runs = 0;
  for (const count of counts.values()) {
    runs += count;
  }

  const passed = counts.get('passed') ?? 0;

  return {
    runs,
    passed,
    failed: counts.get('failed') ?? 0,
    notStarted: counts.get('not_started') ?? 0,
    passRate: rate(passed, runs),
    gateFailBreakdown: tableExists(db, 'verification_gate_results')
      ? computeGateFailBreakdown(db, since, until)
      : [],
  };
}

function computeGateFailBreakdown(
  db: Database.Database,
  since: number,
  until: number
): VibeGateFailure[] {
  const placeholders = FAILED_GATE_STATUSES.map(() => '?').join(', ');

  // Ties break on gateId so the top-N cut is deterministic: two gates with the
  // same fail count must not swap places between calls, or the breakdown looks
  // like it changed when nothing did.
  return db
    .prepare(`
      SELECT g.gate_id AS gateId, COUNT(*) AS failCount
      FROM verification_gate_results g
      JOIN verification_runs r ON r.id = g.run_id
      WHERE r.started_at >= ? AND r.started_at < ?
        AND g.status IN (${placeholders})
      GROUP BY g.gate_id
      ORDER BY failCount DESC, gateId ASC
      LIMIT ?
    `)
    .all(since, until, ...FAILED_GATE_STATUSES, GATE_FAIL_BREAKDOWN_LIMIT) as VibeGateFailure[];
}

function computeInterventionCounts(
  db: Database.Database,
  since: number,
  until: number
): { humanResponds: number; autoAnswered: number } {
  // Rejected events count too. The state machine may refuse to move the task —
  // a human answering a prompt that arrived while gates were running, say — but
  // the person still had to stop and answer it, which is what this measures.
  const rows = db
    .prepare(`
      SELECT event AS key, COUNT(*) AS count
      FROM task_events
      WHERE created_at >= ? AND created_at < ?
        AND event IN ('prompt_answered_human', 'prompt_answered_auto')
      GROUP BY event
    `)
    .all(since, until) as CountRow[];

  const counts = countsByKey(rows);

  return {
    humanResponds: counts.get('prompt_answered_human') ?? 0,
    autoAnswered: counts.get('prompt_answered_auto') ?? 0,
  };
}

/**
 * Aggregate Eval metrics over the last `days` days.
 *
 * @param opts.days - Window length; clamped to 1..MAX_METRICS_DAYS
 * @param opts.until - Exclusive end of the window, epoch ms; defaults to now
 */
export function computeVibeMetrics(db: Database.Database, opts: VibeMetricsOptions): VibeMetrics {
  const days = Math.min(Math.max(Math.trunc(opts.days), 1), MAX_METRICS_DAYS);
  const until = opts.until ?? Date.now();
  const since = until - days * MS_PER_DAY;

  const hasTasks = tableExists(db, 'tasks');
  const hasTaskEvents = tableExists(db, 'task_events');

  const taskCounts = hasTasks ? computeTaskCounts(db, since, until) : emptyTaskMetrics();

  return {
    periodDays: days,
    tasks: {
      ...taskCounts,
      avgRetryLoops: hasTaskEvents ? computeAvgRetryLoops(db, since, until) : null,
    },
    verification: tableExists(db, 'verification_runs')
      ? computeVerificationMetrics(db, since, until)
      : emptyVerificationMetrics(),
    intervention: {
      ...(hasTaskEvents
        ? computeInterventionCounts(db, since, until)
        : { humanResponds: 0, autoAnswered: 0 }),
      suppressedByPolicy: null,
    },
  };
}
