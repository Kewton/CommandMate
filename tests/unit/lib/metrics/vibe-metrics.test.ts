/**
 * Unit tests for computeVibeMetrics (Issue #1551, Phase 4).
 *
 * Every expected number here is worked out by hand from the seed and written as
 * a literal. Re-deriving it with the same expression the implementation uses
 * would make the test agree with any consistent mistake.
 *
 * The cases that matter most are the ones where a plausible implementation
 * reports something false: a zero denominator rendered as `0` instead of
 * `null`, a `skipped` gate counted as a failure, the initial `message_sent`
 * counted as a retry, and a window boundary that is inclusive on the wrong end.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  computeVibeMetrics,
  GATE_FAIL_BREAKDOWN_LIMIT,
  MAX_METRICS_DAYS,
  MS_PER_DAY,
} from '@/lib/metrics/vibe-metrics';

/** Fixed clock, so nothing in these tests depends on when they run. */
const UNTIL = 1_800_000_000_000;
const SINCE_7D = UNTIL - 7 * MS_PER_DAY;

/** Middle of the 7-day window; the default timestamp for seeded rows. */
const MID = UNTIL - 3 * MS_PER_DAY;

let db: Database.Database;
let taskSeq = 0;
let runSeq = 0;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  taskSeq = 0;
  runSeq = 0;
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Seed helpers — raw INSERTs so timestamps are exact. createTask() stamps
// Date.now(), which cannot express "one millisecond before the window opens".
// ---------------------------------------------------------------------------

function seedTask(status: string, createdAt: number = MID): string {
  const id = `task-${++taskSeq}`;
  db.prepare(`
    INSERT INTO tasks (id, worktree_id, cli_tool_id, instance_id, title, goal,
                       contract_path, contract_json, status,
                       last_verification_run_id, created_at, updated_at)
    VALUES (?, 'wt-1', 'claude', NULL, 'a task', 'do it', NULL, '{}', ?, NULL, ?, ?)
  `).run(id, status, createdAt, createdAt);
  return id;
}

function seedTasks(status: string, count: number, createdAt: number = MID): void {
  for (let i = 0; i < count; i++) seedTask(status, createdAt);
}

function seedRun(status: string, startedAt: number = MID): number {
  const id = ++runSeq;
  db.prepare(`
    INSERT INTO verification_runs (id, worktree_id, instance_id, task_id, trigger,
                                   status, base_ref, started_at, finished_at)
    VALUES (?, 'wt-1', NULL, NULL, 'manual', ?, NULL, ?, NULL)
  `).run(id, status, startedAt);
  return id;
}

function seedRuns(status: string, count: number, startedAt: number = MID): void {
  for (let i = 0; i < count; i++) seedRun(status, startedAt);
}

function seedGate(runId: number, gateId: string, status: string): void {
  db.prepare(`
    INSERT INTO verification_gate_results (run_id, gate_id, command, status,
                                           exit_code, duration_ms, log_tail, started_at)
    VALUES (?, ?, 'npm run x', ?, NULL, NULL, NULL, ?)
  `).run(runId, gateId, status, MID);
}

function seedEvent(
  taskId: string,
  event: string,
  fromStatus: string,
  toStatus: string | null,
  createdAt: number = MID
): void {
  db.prepare(`
    INSERT INTO task_events (task_id, event, from_status, to_status, payload_json, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(taskId, event, fromStatus, toStatus, createdAt);
}

function metrics(days = 7, until = UNTIL) {
  return computeVibeMetrics(db, { days, until });
}

// ---------------------------------------------------------------------------
// Task aggregation
// ---------------------------------------------------------------------------

describe('computeVibeMetrics — tasks', () => {
  it('counts each terminal status and reports succeeded/total as the success rate', () => {
    seedTasks('succeeded', 9);
    seedTasks('failed', 2);
    seedTasks('not_started', 1);

    const m = metrics();

    expect(m.tasks.total).toBe(12);
    expect(m.tasks.succeeded).toBe(9);
    expect(m.tasks.failed).toBe(2);
    expect(m.tasks.notStarted).toBe(1);
    expect(m.tasks.cancelled).toBe(0);
    expect(m.tasks.successRate).toBe(0.75);
  });

  it('counts in-flight tasks in the total but not in any terminal bucket', () => {
    seedTasks('succeeded', 1);
    seedTasks('running', 1);
    seedTasks('pending', 1);
    seedTasks('waiting_input', 1);

    const m = metrics();

    expect(m.tasks.total).toBe(4);
    expect(m.tasks.succeeded).toBe(1);
    expect(m.tasks.failed).toBe(0);
    expect(m.tasks.notStarted).toBe(0);
    expect(m.tasks.cancelled).toBe(0);
    expect(m.tasks.successRate).toBe(0.25);
  });

  it('counts cancelled tasks', () => {
    seedTasks('cancelled', 3);
    seedTasks('succeeded', 1);

    const m = metrics();

    expect(m.tasks.cancelled).toBe(3);
    expect(m.tasks.total).toBe(4);
  });

  // The distinction this feature would be worthless without: no tasks is not
  // a 0% success rate.
  it('reports successRate as null — not 0 — when no task was created', () => {
    const m = metrics();

    expect(m.tasks.total).toBe(0);
    expect(m.tasks.successRate).toBeNull();
    expect(m.tasks.successRate).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Window boundaries
// ---------------------------------------------------------------------------

describe('computeVibeMetrics — window boundaries', () => {
  it('includes the row at `since` and excludes the row at `until`', () => {
    seedTask('succeeded', SINCE_7D - 1); // out: one ms too early
    seedTask('succeeded', SINCE_7D); // in: window opens here
    seedTask('succeeded', UNTIL - 1); // in: last countable millisecond
    seedTask('succeeded', UNTIL); // out: window is half-open

    expect(metrics().tasks.total).toBe(2);
  });

  it('applies the same boundaries to verification runs', () => {
    seedRun('passed', SINCE_7D - 1);
    seedRun('passed', SINCE_7D);
    seedRun('passed', UNTIL - 1);
    seedRun('passed', UNTIL);

    expect(metrics().verification.runs).toBe(2);
  });

  it('applies the same boundaries to task events', () => {
    seedEvent('t-a', 'prompt_answered_human', 'waiting_input', 'running', SINCE_7D - 1);
    seedEvent('t-a', 'prompt_answered_human', 'waiting_input', 'running', SINCE_7D);
    seedEvent('t-a', 'prompt_answered_human', 'waiting_input', 'running', UNTIL - 1);
    seedEvent('t-a', 'prompt_answered_human', 'waiting_input', 'running', UNTIL);

    expect(metrics().intervention.humanResponds).toBe(2);
  });

  it('narrows the window when fewer days are asked for', () => {
    seedTask('succeeded', UNTIL - 6 * MS_PER_DAY);
    seedTask('succeeded', UNTIL - 2 * MS_PER_DAY);

    expect(metrics(7).tasks.total).toBe(2);
    expect(metrics(3).tasks.total).toBe(1);
    expect(metrics(1).tasks.total).toBe(0);
  });

  it('defaults `until` to now', () => {
    const now = Date.now();
    seedTask('succeeded', now - 60_000);
    seedTask('succeeded', now - 8 * MS_PER_DAY);

    expect(computeVibeMetrics(db, { days: 7 }).tasks.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// periodDays
// ---------------------------------------------------------------------------

describe('computeVibeMetrics — periodDays', () => {
  it('echoes the requested window', () => {
    expect(metrics(7).periodDays).toBe(7);
    expect(metrics(30).periodDays).toBe(30);
  });

  it('clamps to 1..MAX_METRICS_DAYS and truncates fractions', () => {
    expect(metrics(0).periodDays).toBe(1);
    expect(metrics(-5).periodDays).toBe(1);
    expect(metrics(1000).periodDays).toBe(MAX_METRICS_DAYS);
    expect(metrics(7.9).periodDays).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Verification aggregation
// ---------------------------------------------------------------------------

describe('computeVibeMetrics — verification', () => {
  it('counts run verdicts and reports passed/runs as the pass rate', () => {
    seedRuns('passed', 6);
    seedRuns('failed', 2);
    seedRuns('not_started', 1);
    seedRuns('error', 1);
    seedRuns('running', 2);

    const m = metrics();

    expect(m.verification.runs).toBe(12);
    expect(m.verification.passed).toBe(6);
    expect(m.verification.failed).toBe(2);
    expect(m.verification.notStarted).toBe(1);
    expect(m.verification.passRate).toBe(0.5);
  });

  it('reports passRate as null — not 0 — when no run started', () => {
    const m = metrics();

    expect(m.verification.runs).toBe(0);
    expect(m.verification.passRate).toBeNull();
    expect(m.verification.passRate).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gate fail breakdown
// ---------------------------------------------------------------------------

describe('computeVibeMetrics — gateFailBreakdown', () => {
  it('ranks failed and timed-out gates, and ignores skipped and errored ones', () => {
    const run = seedRun('failed');
    for (let i = 0; i < 4; i++) seedGate(run, 'unit', 'failed');
    for (let i = 0; i < 2; i++) seedGate(run, 'lint', 'failed');
    seedGate(run, 'build', 'timeout');
    for (let i = 0; i < 3; i++) seedGate(run, 'e2e', 'skipped');
    for (let i = 0; i < 5; i++) seedGate(run, 'tsc', 'error');
    seedGate(run, 'scope', 'passed');

    expect(metrics().verification.gateFailBreakdown).toEqual([
      { gateId: 'unit', failCount: 4 },
      { gateId: 'lint', failCount: 2 },
      { gateId: 'build', failCount: 1 },
    ]);
  });

  it('excludes gates whose run started outside the window', () => {
    const outside = seedRun('failed', SINCE_7D - 1);
    seedGate(outside, 'unit', 'failed');
    const inside = seedRun('failed');
    seedGate(inside, 'lint', 'failed');

    expect(metrics().verification.gateFailBreakdown).toEqual([{ gateId: 'lint', failCount: 1 }]);
  });

  it('breaks count ties on gate id so the ranking is stable', () => {
    const run = seedRun('failed');
    for (const gateId of ['zebra', 'alpha', 'middle']) {
      seedGate(run, gateId, 'failed');
      seedGate(run, gateId, 'failed');
    }

    expect(metrics().verification.gateFailBreakdown.map((g) => g.gateId)).toEqual([
      'alpha',
      'middle',
      'zebra',
    ]);
  });

  it('reports at most GATE_FAIL_BREAKDOWN_LIMIT gates, worst first', () => {
    const run = seedRun('failed');
    // gate-01 fails once, gate-02 twice, ... gate-12 twelve times.
    for (let i = 1; i <= 12; i++) {
      const gateId = `gate-${String(i).padStart(2, '0')}`;
      for (let n = 0; n < i; n++) seedGate(run, gateId, 'failed');
    }

    const breakdown = metrics().verification.gateFailBreakdown;

    expect(breakdown).toHaveLength(GATE_FAIL_BREAKDOWN_LIMIT);
    expect(breakdown[0]).toEqual({ gateId: 'gate-12', failCount: 12 });
    expect(breakdown[9]).toEqual({ gateId: 'gate-03', failCount: 3 });
    expect(breakdown.map((g) => g.gateId)).not.toContain('gate-01');
  });

  it('is empty when nothing failed', () => {
    const run = seedRun('passed');
    seedGate(run, 'unit', 'passed');

    expect(metrics().verification.gateFailBreakdown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Intervention
// ---------------------------------------------------------------------------

describe('computeVibeMetrics — intervention', () => {
  it('separates human answers from auto answers', () => {
    for (let i = 0; i < 5; i++) {
      seedEvent('t-a', 'prompt_answered_human', 'waiting_input', 'running');
    }
    for (let i = 0; i < 23; i++) {
      seedEvent('t-a', 'prompt_answered_auto', 'waiting_input', 'running');
    }
    seedEvent('t-a', 'prompt_detected', 'running', 'waiting_input');
    seedEvent('t-a', 'agent_idle', 'running', 'running');

    const m = metrics();

    expect(m.intervention.humanResponds).toBe(5);
    expect(m.intervention.autoAnswered).toBe(23);
  });

  // A human who answers a prompt the state machine then refuses still stopped
  // what they were doing to answer it. That is the cost being measured.
  it('counts answers the state machine rejected', () => {
    seedEvent('t-a', 'prompt_answered_human', 'verifying', null);
    seedEvent('t-a', 'prompt_answered_auto', 'verifying', null);

    const m = metrics();

    expect(m.intervention.humanResponds).toBe(1);
    expect(m.intervention.autoAnswered).toBe(1);
  });

  it('leaves suppressedByPolicy null — the policy log is not persisted in v1', () => {
    seedEvent('t-a', 'prompt_answered_auto', 'waiting_input', 'running');

    expect(metrics().intervention.suppressedByPolicy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retry loops
// ---------------------------------------------------------------------------

describe('computeVibeMetrics — avgRetryLoops', () => {
  /**
   * One task's real history: it is sent, fails, is re-instructed, fails again…
   *
   * Each retry is preceded by its own failure, because that is the only way a
   * task gets back into `failed`. A task that failed once and was never
   * re-instructed still produces one failure event, so it counts toward the
   * denominator — that is what makes the mean a mean.
   */
  function seedFailedTask(taskId: string, status: 'failed' | 'not_started', retries: number): void {
    const verdict = status === 'failed' ? 'verify_failed' : 'verify_not_started';
    seedEvent(taskId, 'message_sent', 'pending', 'running');
    seedEvent(taskId, verdict, 'verifying', status);
    for (let i = 0; i < retries; i++) {
      seedEvent(taskId, 'message_sent', status, 'running');
      if (i < retries - 1) seedEvent(taskId, verdict, 'verifying', status);
    }
  }

  it('divides re-instructions by the number of tasks that did not pass', () => {
    seedFailedTask('t-a', 'failed', 3);
    seedFailedTask('t-b', 'failed', 2);
    seedFailedTask('t-c', 'not_started', 1);
    seedFailedTask('t-d', 'failed', 0);

    // 6 re-instructions across 4 distinct tasks that reached failed/not_started.
    // Those 4 tasks produced 3+2+1+1 = 7 failure events between them, so a
    // denominator that counted events instead of tasks would report 6/7.
    expect(metrics().tasks.avgRetryLoops).toBe(1.5);
  });

  // The denominator is tasks, not events. With 6 re-instructions over 3 tasks
  // that failed twice each, a per-event denominator would report 1.0 and hide
  // every repeat.
  it('counts repeats against the same task', () => {
    seedFailedTask('t-a', 'failed', 2);
    seedFailedTask('t-b', 'failed', 2);
    seedFailedTask('t-c', 'failed', 2);

    expect(metrics().tasks.avgRetryLoops).toBe(2);
  });

  it('does not count the first send as a retry', () => {
    seedFailedTask('t-a', 'failed', 0);

    expect(metrics().tasks.avgRetryLoops).toBe(0);
  });

  it('reports null — not 0 — when nothing failed in the window', () => {
    seedEvent('t-a', 'message_sent', 'pending', 'running');
    seedEvent('t-a', 'verify_passed', 'verifying', 'succeeded');

    const m = metrics();

    expect(m.tasks.avgRetryLoops).toBeNull();
    expect(m.tasks.avgRetryLoops).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Degradation on databases without the Phase 1–3 tables
// ---------------------------------------------------------------------------

describe('computeVibeMetrics — missing tables', () => {
  it('returns zeros and nulls on a database with none of the tables', () => {
    const bare = new Database(':memory:');
    try {
      const m = computeVibeMetrics(bare, { days: 7, until: UNTIL });

      expect(m).toEqual({
        periodDays: 7,
        tasks: {
          total: 0,
          succeeded: 0,
          failed: 0,
          notStarted: 0,
          cancelled: 0,
          successRate: null,
          avgRetryLoops: null,
        },
        verification: {
          runs: 0,
          passed: 0,
          failed: 0,
          notStarted: 0,
          passRate: null,
          gateFailBreakdown: [],
        },
        intervention: { humanResponds: 0, autoAnswered: 0, suppressedByPolicy: null },
      });
    } finally {
      bare.close();
    }
  });

  it('still reports the other sections when `tasks` is absent', () => {
    seedRuns('passed', 2);
    seedEvent('t-a', 'prompt_answered_human', 'waiting_input', 'running');
    db.exec('DROP TABLE tasks');

    const m = metrics();

    expect(m.tasks.total).toBe(0);
    expect(m.tasks.successRate).toBeNull();
    expect(m.verification.runs).toBe(2);
    expect(m.intervention.humanResponds).toBe(1);
  });

  it('still reports the other sections when `task_events` is absent', () => {
    seedTasks('succeeded', 2);
    seedRuns('passed', 1);
    db.exec('DROP TABLE task_events');

    const m = metrics();

    expect(m.tasks.total).toBe(2);
    expect(m.tasks.avgRetryLoops).toBeNull();
    expect(m.intervention.humanResponds).toBe(0);
    expect(m.intervention.autoAnswered).toBe(0);
    expect(m.verification.runs).toBe(1);
  });

  it('reports runs without a breakdown when `verification_gate_results` is absent', () => {
    seedRuns('passed', 3);
    db.exec('DROP TABLE verification_gate_results');

    const m = metrics();

    expect(m.verification.runs).toBe(3);
    expect(m.verification.passRate).toBe(1);
    expect(m.verification.gateFailBreakdown).toEqual([]);
  });

  it('zeroes the verification section when `verification_runs` is absent', () => {
    seedTasks('succeeded', 1);
    db.exec('DROP TABLE verification_gate_results');
    db.exec('DROP TABLE verification_runs');

    const m = metrics();

    expect(m.verification).toEqual({
      runs: 0,
      passed: 0,
      failed: 0,
      notStarted: 0,
      passRate: null,
      gateFailBreakdown: [],
    });
    expect(m.tasks.total).toBe(1);
  });
});
