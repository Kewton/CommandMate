/**
 * Unit tests for listVerificationRunsForPeriod (Issue #1593).
 *
 * The load-bearing property is what the summary does NOT carry: log tails are
 * the reason a history listing would be megabytes instead of kilobytes, and a
 * type declaration alone cannot stop a SELECT from shipping them. Every
 * assertion about absence here reads the runtime object, not the type.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createVerificationRun,
  createGateResult,
  finishGateResult,
  finishVerificationRun,
  listVerificationRunsForPeriod,
  DEFAULT_RUN_HISTORY_LIMIT,
  MAX_RUN_HISTORY_LIMIT,
  MAX_RUN_HISTORY_DAYS,
} from '@/lib/db/verification-db';

const MS_PER_DAY = 86_400_000;

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

/** Overwrite started_at so window assertions do not depend on the wall clock. */
function setStartedAt(runId: number, startedAt: number): void {
  db.prepare('UPDATE verification_runs SET started_at = ? WHERE id = ?').run(startedAt, runId);
}

/** A finished run with one finished gate, started `daysAgo` days back. */
function seedRun(opts: {
  worktreeId: string;
  daysAgo?: number;
  gateId?: string;
  gateStatus?: 'passed' | 'failed';
  logTail?: string;
}): number {
  const run = createVerificationRun(db, { worktreeId: opts.worktreeId, trigger: 'manual' });
  const gate = createGateResult(db, run.id, {
    gateId: opts.gateId ?? 'lint',
    command: 'npm run lint',
    source: 'verify.yaml',
  });
  finishGateResult(db, gate.id, {
    status: opts.gateStatus ?? 'passed',
    exitCode: opts.gateStatus === 'failed' ? 1 : 0,
    durationMs: 1234,
    logTail: opts.logTail ?? 'a'.repeat(4096),
  });
  finishVerificationRun(db, run.id, opts.gateStatus === 'failed' ? 'failed' : 'passed');
  if (opts.daysAgo !== undefined) {
    setStartedAt(run.id, Date.now() - opts.daysAgo * MS_PER_DAY);
  }
  return run.id;
}

describe('listVerificationRunsForPeriod — gate summaries carry no log bodies', () => {
  it('omits logTail from the gate objects it returns', () => {
    seedRun({ worktreeId: 'wt-1', logTail: 'SECRET BUILD OUTPUT' });

    const [run] = listVerificationRunsForPeriod(db);

    expect(run.gates).toHaveLength(1);
    expect(run.gates[0]).not.toHaveProperty('logTail');
    expect(JSON.stringify(run)).not.toContain('SECRET BUILD OUTPUT');
  });

  it('returns exactly the five documented summary fields per gate', () => {
    seedRun({ worktreeId: 'wt-1', gateId: 'unit', gateStatus: 'failed' });

    const [run] = listVerificationRunsForPeriod(db);

    // `source` joined the set in #1791. The point of pinning the whole key list
    // is that `logTail` can never rejoin it by accident, so the pin is widened
    // deliberately rather than loosened.
    expect(Object.keys(run.gates[0]).sort()).toEqual([
      'durationMs',
      'exitCode',
      'gateId',
      'source',
      'status',
    ]);
    expect(run.gates[0]).toEqual({
      gateId: 'unit',
      status: 'failed',
      exitCode: 1,
      durationMs: 1234,
      source: 'verify.yaml',
    });
  });

  it('keeps gates in execution order and groups them under the right run', () => {
    const first = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    for (const gateId of ['work-evidence', 'lint', 'unit']) {
      createGateResult(db, first.id, { gateId, command: `run ${gateId}`, source: 'verify.yaml' });
    }
    const second = createVerificationRun(db, { worktreeId: 'wt-2', trigger: 'api' });
    createGateResult(db, second.id, { gateId: 'build', command: 'npm run build', source: 'verify.yaml' });
    setStartedAt(first.id, 2_000_000_000_000);
    setStartedAt(second.id, 2_000_000_001_000);

    const runs = listVerificationRunsForPeriod(db);

    expect(runs.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(runs[0].gates.map((g) => g.gateId)).toEqual(['build']);
    expect(runs[1].gates.map((g) => g.gateId)).toEqual(['work-evidence', 'lint', 'unit']);
  });

  it('returns an empty gate list for a run that has none', () => {
    createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    expect(listVerificationRunsForPeriod(db)[0].gates).toEqual([]);
  });
});

describe('listVerificationRunsForPeriod — worktree filter', () => {
  it('spans every worktree when worktreeId is omitted', () => {
    seedRun({ worktreeId: 'wt-1' });
    seedRun({ worktreeId: 'wt-2' });
    seedRun({ worktreeId: 'wt-3' });

    expect(listVerificationRunsForPeriod(db)).toHaveLength(3);
  });

  it('narrows to one worktree when worktreeId is given', () => {
    const mine = seedRun({ worktreeId: 'wt-1' });
    seedRun({ worktreeId: 'wt-2' });

    const runs = listVerificationRunsForPeriod(db, { worktreeId: 'wt-1' });

    expect(runs.map((r) => r.id)).toEqual([mine]);
  });

  it('returns an empty list for a worktree that has no runs', () => {
    seedRun({ worktreeId: 'wt-2' });

    expect(listVerificationRunsForPeriod(db, { worktreeId: 'wt-1' })).toEqual([]);
  });
});

describe('listVerificationRunsForPeriod — period filter', () => {
  it('includes runs inside the window and excludes runs outside it', () => {
    const inside = seedRun({ worktreeId: 'wt-1', daysAgo: 3 });
    const outside = seedRun({ worktreeId: 'wt-1', daysAgo: 30 });

    const ids = listVerificationRunsForPeriod(db, { days: 7 }).map((r) => r.id);

    expect(ids).toContain(inside);
    expect(ids).not.toContain(outside);
  });

  it('drops a run that is one millisecond older than the boundary', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    setStartedAt(run.id, Date.now() - 7 * MS_PER_DAY - 1);

    expect(listVerificationRunsForPeriod(db, { days: 7 })).toEqual([]);
  });

  it('applies no lower bound when days is omitted', () => {
    seedRun({ worktreeId: 'wt-1', daysAgo: 3650 });

    expect(listVerificationRunsForPeriod(db)).toHaveLength(1);
  });

  it('clamps days above the maximum to the maximum window', () => {
    const inside = seedRun({ worktreeId: 'wt-1', daysAgo: MAX_RUN_HISTORY_DAYS - 1 });
    seedRun({ worktreeId: 'wt-1', daysAgo: MAX_RUN_HISTORY_DAYS + 1 });

    const ids = listVerificationRunsForPeriod(db, { days: 10_000 }).map((r) => r.id);

    expect(ids).toEqual([inside]);
  });

  it('clamps days below 1 up to a single day rather than emptying the feed', () => {
    const today = seedRun({ worktreeId: 'wt-1' });
    seedRun({ worktreeId: 'wt-1', daysAgo: 5 });

    expect(listVerificationRunsForPeriod(db, { days: 0 }).map((r) => r.id)).toEqual([today]);
    expect(listVerificationRunsForPeriod(db, { days: -3 }).map((r) => r.id)).toEqual([today]);
  });

  it('combines the worktree and period filters', () => {
    const wanted = seedRun({ worktreeId: 'wt-1', daysAgo: 2 });
    seedRun({ worktreeId: 'wt-1', daysAgo: 40 });
    seedRun({ worktreeId: 'wt-2', daysAgo: 2 });

    const runs = listVerificationRunsForPeriod(db, { worktreeId: 'wt-1', days: 7 });

    expect(runs.map((r) => r.id)).toEqual([wanted]);
  });
});

describe('listVerificationRunsForPeriod — limit', () => {
  /** N runs, oldest last, spaced 1s apart so ordering is deterministic. */
  function seedMany(count: number): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
      setStartedAt(run.id, 2_000_000_000_000 - i * 1000);
      ids.push(run.id);
    }
    return ids;
  }

  it('defaults to 50 runs, keeping the newest', () => {
    const ids = seedMany(DEFAULT_RUN_HISTORY_LIMIT + 5);

    const runs = listVerificationRunsForPeriod(db);

    expect(runs).toHaveLength(DEFAULT_RUN_HISTORY_LIMIT);
    expect(runs.map((r) => r.id)).toEqual(ids.slice(0, DEFAULT_RUN_HISTORY_LIMIT));
  });

  it('honours an explicit limit', () => {
    seedMany(10);

    expect(listVerificationRunsForPeriod(db, { limit: 3 })).toHaveLength(3);
  });

  it('clamps a limit above the maximum instead of returning everything', () => {
    seedMany(5);

    const runs = listVerificationRunsForPeriod(db, { limit: 10_000 });

    // Fewer rows exist than the cap, so the observable proof is that the query
    // ran with the clamped bound rather than throwing on an unbounded LIMIT.
    expect(runs).toHaveLength(5);
    expect(MAX_RUN_HISTORY_LIMIT).toBe(500);
  });

  it('clamps a limit at or below zero up to one row', () => {
    seedMany(5);

    expect(listVerificationRunsForPeriod(db, { limit: 0 })).toHaveLength(1);
    expect(listVerificationRunsForPeriod(db, { limit: -10 })).toHaveLength(1);
  });

  it('truncates a non-integer limit rather than passing a float to SQLite', () => {
    seedMany(10);

    expect(listVerificationRunsForPeriod(db, { limit: 3.9 })).toHaveLength(3);
  });

  it('applies the limit to runs, not to gate rows', () => {
    for (let i = 0; i < 3; i += 1) {
      const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
      for (const gateId of ['lint', 'unit', 'build']) {
        createGateResult(db, run.id, { gateId, command: `run ${gateId}`, source: 'verify.yaml' });
      }
      setStartedAt(run.id, 2_000_000_000_000 - i * 1000);
    }

    const runs = listVerificationRunsForPeriod(db, { limit: 2 });

    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.gates.length === 3)).toBe(true);
  });
});

describe('listVerificationRunsForPeriod — ordering contract', () => {
  it('orders by started_at DESC then id DESC, matching listVerificationRuns', () => {
    const older = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const tieA = createVerificationRun(db, { worktreeId: 'wt-2', trigger: 'manual' });
    const tieB = createVerificationRun(db, { worktreeId: 'wt-3', trigger: 'manual' });
    setStartedAt(older.id, 1_700_000_000_000);
    setStartedAt(tieA.id, 1_700_000_001_000);
    setStartedAt(tieB.id, 1_700_000_001_000);

    const runs = listVerificationRunsForPeriod(db);

    expect(runs.map((r) => r.id)).toEqual([tieB.id, tieA.id, older.id]);
  });

  it('carries the run verdict so the feed reads without a join', () => {
    const run = createVerificationRun(db, {
      worktreeId: 'wt-1',
      trigger: 'wait',
      instanceId: 'codex-2',
      baseRef: 'origin/develop',
    });
    finishVerificationRun(db, run.id, 'not_started');

    const [listed] = listVerificationRunsForPeriod(db);

    expect(listed.status).toBe('not_started');
    expect(listed.trigger).toBe('wait');
    expect(listed.instanceId).toBe('codex-2');
    expect(listed.baseRef).toBe('origin/develop');
    expect(listed.finishedAt).toBeInstanceOf(Date);
  });
});
