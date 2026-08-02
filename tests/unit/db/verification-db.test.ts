/**
 * Unit tests for verification-db (Issue #1542).
 *
 * Covers the full CRUD surface, cascade deletion, feed ordering/limit, and the
 * two ways a write can be wrong without anyone noticing: a status outside the
 * CHECK vocabulary, and a finish* call against a row that is not there.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createVerificationRun,
  finishVerificationRun,
  createGateResult,
  finishGateResult,
  getVerificationRun,
  listVerificationRuns,
  type VerificationRunTerminalStatus,
  type VerificationTrigger,
  type VerificationGateTerminalStatus,
} from '@/lib/db/verification-db';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Mirrors db-instance.ts. Without it ON DELETE CASCADE never fires and the
  // cascade assertions below would pass against a table that kept its rows.
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

/** Overwrite started_at so ordering assertions do not depend on clock spacing. */
function setStartedAt(runId: number, startedAt: number): void {
  db.prepare('UPDATE verification_runs SET started_at = ? WHERE id = ?').run(startedAt, runId);
}

describe('createVerificationRun', () => {
  it('opens a run in running state with no finish timestamp', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    expect(run.id).toBeGreaterThan(0);
    expect(run.worktreeId).toBe('wt-1');
    expect(run.trigger).toBe('manual');
    expect(run.status).toBe('running');
    expect(run.finishedAt).toBeNull();
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.startedAt.getTime()).toBeGreaterThan(0);
  });

  it('defaults the optional columns to null rather than empty strings', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'wait' });

    expect(run.instanceId).toBeNull();
    expect(run.taskId).toBeNull();
    expect(run.baseRef).toBeNull();
  });

  it('persists instance, task and base ref when supplied', () => {
    const run = createVerificationRun(db, {
      worktreeId: 'wt-1',
      trigger: 'task',
      instanceId: 'codex-2',
      taskId: 'task-abc',
      baseRef: 'origin/develop',
    });

    const reloaded = getVerificationRun(db, run.id);
    expect(reloaded?.instanceId).toBe('codex-2');
    expect(reloaded?.taskId).toBe('task-abc');
    expect(reloaded?.baseRef).toBe('origin/develop');
  });

  it('assigns distinct ids to concurrent runs on the same worktree', () => {
    const a = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const b = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    expect(b.id).not.toBe(a.id);
  });

  it('rejects a trigger outside the vocabulary instead of storing it', () => {
    expect(() =>
      createVerificationRun(db, {
        worktreeId: 'wt-1',
        trigger: 'cron' as VerificationTrigger,
      })
    ).toThrow(/CHECK constraint failed/);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM verification_runs').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe('finishVerificationRun', () => {
  it.each<VerificationRunTerminalStatus>([
    'passed',
    'failed',
    'not_started',
    'error',
    'cancelled',
  ])('records the %s verdict and stamps finished_at', (status) => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    finishVerificationRun(db, run.id, status);

    const reloaded = getVerificationRun(db, run.id);
    expect(reloaded?.status).toBe(status);
    expect(reloaded?.finishedAt).toBeInstanceOf(Date);
    expect(reloaded!.finishedAt!.getTime()).toBeGreaterThanOrEqual(reloaded!.startedAt.getTime());
  });

  it('throws when the run does not exist, rather than silently recording nothing', () => {
    expect(() => finishVerificationRun(db, 4242, 'passed')).toThrow(/4242 not found/);
  });

  it('does not close a different run when the id is wrong', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    expect(() => finishVerificationRun(db, run.id + 1, 'failed')).toThrow();

    expect(getVerificationRun(db, run.id)?.status).toBe('running');
  });

  it('rejects a status outside the vocabulary', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    expect(() =>
      finishVerificationRun(db, run.id, 'done' as VerificationRunTerminalStatus)
    ).toThrow(/CHECK constraint failed/);
    expect(getVerificationRun(db, run.id)?.status).toBe('running');
  });
});

describe('createGateResult / finishGateResult', () => {
  it('opens a gate result in running state with an empty outcome', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    const gate = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });

    expect(gate.runId).toBe(run.id);
    expect(gate.gateId).toBe('lint');
    expect(gate.command).toBe('npm run lint');
    expect(gate.status).toBe('running');
    expect(gate.exitCode).toBeNull();
    expect(gate.durationMs).toBeNull();
    expect(gate.logTail).toBeNull();
    expect(gate.finishedAt).toBeNull();
  });

  it('records a passing gate, keeping exit code 0 as 0', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const gate = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });

    finishGateResult(db, gate.id, {
      status: 'passed',
      exitCode: 0,
      durationMs: 0,
      logTail: 'ok',
    });

    const stored = getVerificationRun(db, run.id)!.gates[0];
    expect(stored.status).toBe('passed');
    // A `|| null` here would store NULL and turn "exited 0" into "no exit code".
    expect(stored.exitCode).toBe(0);
    expect(stored.durationMs).toBe(0);
    expect(stored.logTail).toBe('ok');
    expect(stored.finishedAt).toBeInstanceOf(Date);
  });

  it('records a failing gate with its non-zero exit code and log tail', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const gate = createGateResult(db, run.id, { gateId: 'test', command: 'npm run test:unit' });

    finishGateResult(db, gate.id, {
      status: 'failed',
      exitCode: 1,
      durationMs: 12345,
      logTail: 'Errors  1 error',
    });

    const stored = getVerificationRun(db, run.id)!.gates[0];
    expect(stored.status).toBe('failed');
    expect(stored.exitCode).toBe(1);
    expect(stored.durationMs).toBe(12345);
    expect(stored.logTail).toBe('Errors  1 error');
  });

  it('records a skipped gate with a reason and no exit code', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const gate = createGateResult(db, run.id, { gateId: 'build', command: 'npm run build' });

    finishGateResult(db, gate.id, {
      status: 'skipped',
      logTail: 'skipInPrimaryCheckout',
    });

    const stored = getVerificationRun(db, run.id)!.gates[0];
    expect(stored.status).toBe('skipped');
    expect(stored.exitCode).toBeNull();
    expect(stored.durationMs).toBeNull();
    expect(stored.logTail).toBe('skipInPrimaryCheckout');
  });

  it('throws when the gate result does not exist', () => {
    expect(() => finishGateResult(db, 4242, { status: 'passed' })).toThrow(/4242 not found/);
  });

  it('rejects a gate status outside the vocabulary', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const gate = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });

    expect(() =>
      finishGateResult(db, gate.id, {
        status: 'aborted' as VerificationGateTerminalStatus,
      })
    ).toThrow(/CHECK constraint failed/);
    expect(getVerificationRun(db, run.id)!.gates[0].status).toBe('running');
  });

  it('refuses to attach a gate result to a run that does not exist', () => {
    expect(() =>
      createGateResult(db, 9999, { gateId: 'lint', command: 'npm run lint' })
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

/**
 * Issue #1625: the timestamps have to describe the execution, not the write.
 *
 * The runner opens the row before spawning the gate so an open row exists while
 * it runs, and closes it with the window its own measurement covered. Without
 * an explicit window here, the close would stamp `finished_at = now` and leave
 * `started_at` at the moment the row was opened — which is what made every gate
 * report a window unrelated to `duration_ms`.
 */
describe('finishGateResult — measured execution window', () => {
  const WINDOW = { startedAt: 1_800_000_000_000, finishedAt: 1_800_000_004_010 };

  it('writes the supplied window over the provisional opening stamp', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const gate = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });

    finishGateResult(db, gate.id, {
      status: 'passed',
      exitCode: 0,
      durationMs: 4010,
      logTail: 'ok',
      executionWindow: WINDOW,
    });

    const stored = getVerificationRun(db, run.id)!.gates[0];
    expect(stored.startedAt.getTime()).toBe(WINDOW.startedAt);
    expect(stored.finishedAt!.getTime()).toBe(WINDOW.finishedAt);
    expect(stored.finishedAt!.getTime() - stored.startedAt.getTime()).toBe(stored.durationMs);
  });

  it('keeps the opening stamp and closes at now when no window is supplied', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const gate = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });
    const openedAt = gate.startedAt.getTime();

    // The reconciler's call shape (#1543): it never observed the gate, so it
    // has no window to declare and must not invent one.
    finishGateResult(db, gate.id, { status: 'error', durationMs: null, logTail: 'orphan' });

    const stored = getVerificationRun(db, run.id)!.gates[0];
    expect(stored.startedAt.getTime()).toBe(openedAt);
    expect(stored.finishedAt!.getTime()).toBeGreaterThanOrEqual(openedAt);
  });

  it('reports timingsMeasured only when the window matches duration_ms', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    const measured = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });
    finishGateResult(db, measured.id, {
      status: 'passed',
      exitCode: 0,
      durationMs: 4010,
      executionWindow: WINDOW,
    });

    // A row shaped like the ones written before #1625: both stamps taken after
    // the gate finished, so the window is empty while duration_ms says 4s.
    const legacy = createGateResult(db, run.id, { gateId: 'test', command: 'npm run test:unit' });
    finishGateResult(db, legacy.id, {
      status: 'passed',
      exitCode: 0,
      durationMs: 4010,
      executionWindow: { startedAt: WINDOW.finishedAt, finishedAt: WINDOW.finishedAt },
    });

    const gates = getVerificationRun(db, run.id)!.gates;
    expect(gates.find((g) => g.gateId === 'lint')!.timingsMeasured).toBe(true);
    // This is the discriminator a history reader applies to pre-#1625 rows:
    // no backfill can repair them, so they have to be recognisable instead.
    expect(gates.find((g) => g.gateId === 'test')!.timingsMeasured).toBe(false);
  });

  it('reports timingsMeasured false while a gate is still open', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const gate = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });

    expect(gate.timingsMeasured).toBe(false);
    expect(getVerificationRun(db, run.id)!.gates[0].timingsMeasured).toBe(false);
  });

  it('reports timingsMeasured false for a gate closed without a duration', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const gate = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });

    finishGateResult(db, gate.id, { status: 'error', durationMs: null, logTail: 'orphan' });

    // A reconciled orphan: started_at is real, finished_at is when the restart
    // noticed. Nothing measured that interval, so it must not be advertised.
    expect(getVerificationRun(db, run.id)!.gates[0].timingsMeasured).toBe(false);
  });
});

describe('getVerificationRun', () => {
  it('returns null for an unknown run', () => {
    expect(getVerificationRun(db, 1)).toBeNull();
  });

  it('returns an empty gate list for a run that has not executed a gate yet', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });

    expect(getVerificationRun(db, run.id)?.gates).toEqual([]);
  });

  it('returns gate results in execution order', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const lint = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });
    const tsc = createGateResult(db, run.id, { gateId: 'tsc', command: 'npx tsc --noEmit' });
    const test = createGateResult(db, run.id, { gateId: 'test', command: 'npm run test:unit' });

    const gates = getVerificationRun(db, run.id)!.gates;
    expect(gates.map((g) => g.id)).toEqual([lint.id, tsc.id, test.id]);
    expect(gates.map((g) => g.gateId)).toEqual(['lint', 'tsc', 'test']);
  });

  it('does not mix in gate results belonging to another run', () => {
    const runA = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const runB = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    createGateResult(db, runA.id, { gateId: 'lint', command: 'npm run lint' });
    createGateResult(db, runB.id, { gateId: 'build', command: 'npm run build' });

    expect(getVerificationRun(db, runA.id)!.gates.map((g) => g.gateId)).toEqual(['lint']);
    expect(getVerificationRun(db, runB.id)!.gates.map((g) => g.gateId)).toEqual(['build']);
  });

  it('deletes a run\'s gate results with the run (ON DELETE CASCADE)', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const survivor = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint' });
    createGateResult(db, run.id, { gateId: 'tsc', command: 'npx tsc --noEmit' });
    createGateResult(db, survivor.id, { gateId: 'lint', command: 'npm run lint' });

    db.prepare('DELETE FROM verification_runs WHERE id = ?').run(run.id);

    expect(getVerificationRun(db, run.id)).toBeNull();
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM verification_gate_results WHERE run_id = ?')
      .get(run.id) as { n: number };
    expect(orphans.n).toBe(0);
    // The cascade must be scoped to the deleted run, not the table.
    expect(getVerificationRun(db, survivor.id)!.gates).toHaveLength(1);
  });
});

describe('listVerificationRuns', () => {
  it('returns runs newest first by started_at, not by insertion id', () => {
    const newest = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const oldest = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'wait' });
    const middle = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'api' });
    // started_at deliberately disagrees with id order: the lowest id is the
    // newest run. Ordering by id alone would pass every other assertion here.
    setStartedAt(newest.id, 1_800_000_002_000);
    setStartedAt(oldest.id, 1_800_000_000_000);
    setStartedAt(middle.id, 1_800_000_001_000);

    const runs = listVerificationRuns(db, 'wt-1');

    expect(runs.map((r) => r.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(runs.map((r) => r.trigger)).toEqual(['manual', 'api', 'wait']);
  });

  it('breaks started_at ties by newest id, so the order is total', () => {
    const first = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const second = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    const third = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    for (const id of [first.id, second.id, third.id]) {
      setStartedAt(id, 1_800_000_000_000);
    }

    expect(listVerificationRuns(db, 'wt-1').map((r) => r.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
  });

  it('only returns runs for the requested worktree', () => {
    const mine = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
    createVerificationRun(db, { worktreeId: 'wt-2', trigger: 'manual' });

    const runs = listVerificationRuns(db, 'wt-1');

    expect(runs.map((r) => r.id)).toEqual([mine.id]);
  });

  it('returns an empty list for a worktree with no runs', () => {
    createVerificationRun(db, { worktreeId: 'wt-2', trigger: 'manual' });

    expect(listVerificationRuns(db, 'wt-1')).toEqual([]);
  });

  it('caps the result at 20 runs by default, keeping the newest', () => {
    const ids: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
      // Descending started_at: the earliest-inserted run is the newest, so a
      // cap that keeps the highest ids would drop exactly the wrong 5.
      setStartedAt(run.id, 1_800_000_025_000 - i * 1000);
      ids.push(run.id);
    }

    const runs = listVerificationRuns(db, 'wt-1');

    expect(runs).toHaveLength(20);
    expect(runs.map((r) => r.id)).toEqual(ids.slice(0, 20));
  });

  it('honours an explicit limit', () => {
    for (let i = 0; i < 5; i += 1) {
      const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'manual' });
      setStartedAt(run.id, 1_800_000_000_000 + i * 1000);
    }

    expect(listVerificationRuns(db, 'wt-1', 2)).toHaveLength(2);
  });

  it('carries the finished verdict, so a caller can read the feed without a join', () => {
    const run = createVerificationRun(db, {
      worktreeId: 'wt-1',
      trigger: 'wait',
      baseRef: 'origin/develop',
    });
    finishVerificationRun(db, run.id, 'not_started');

    const [listed] = listVerificationRuns(db, 'wt-1');

    expect(listed.status).toBe('not_started');
    expect(listed.trigger).toBe('wait');
    expect(listed.baseRef).toBe('origin/develop');
    expect(listed.finishedAt).toBeInstanceOf(Date);
  });
});
