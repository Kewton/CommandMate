/**
 * Unit tests for verification run startup reconciliation (Issue #1543).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createGateResult,
  createVerificationRun,
  finishGateResult,
  finishVerificationRun,
  getRunningVerificationRun,
  getVerificationRun,
} from '@/lib/db';
import { reconcileOrphanVerificationRuns } from '@/lib/verification/verification-reconciler';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('reconcileOrphanVerificationRuns', () => {
  it('closes an orphaned run and its open gate as error', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'api' });
    const gate = createGateResult(db, run.id, { gateId: 'unit', command: 'npm run test:unit', source: 'verify.yaml' });

    expect(reconcileOrphanVerificationRuns(db)).toEqual({ runs: 1, gates: 1 });

    const reconciled = getVerificationRun(db, run.id);
    // `error`, not `failed`: no gate reached a verdict about the work.
    expect(reconciled?.status).toBe('error');
    expect(reconciled?.finishedAt).not.toBeNull();
    expect(reconciled?.gates[0].id).toBe(gate.id);
    expect(reconciled?.gates[0].status).toBe('error');
    expect(reconciled?.gates[0].logTail).toContain('reconciled after server restart');
  });

  it('unblocks the worktree so a new run can start', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'api' });
    expect(getRunningVerificationRun(db, 'wt-1')?.id).toBe(run.id);

    reconcileOrphanVerificationRuns(db);

    // The reason this reconciler exists: an open row makes the conflict check
    // reject every future run for that worktree, so one crash would lock it out.
    expect(getRunningVerificationRun(db, 'wt-1')).toBeNull();
  });

  it('leaves runs that already reached a verdict untouched', () => {
    const passed = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'api' });
    const gate = createGateResult(db, passed.id, { gateId: 'lint', command: 'npm run lint', source: 'verify.yaml' });
    finishGateResult(db, gate.id, { status: 'passed', exitCode: 0, durationMs: 12, logTail: 'ok' });
    finishVerificationRun(db, passed.id, 'passed');

    expect(reconcileOrphanVerificationRuns(db)).toEqual({ runs: 0, gates: 0 });

    const after = getVerificationRun(db, passed.id);
    expect(after?.status).toBe('passed');
    expect(after?.gates[0].status).toBe('passed');
    expect(after?.gates[0].exitCode).toBe(0);
    expect(after?.gates[0].logTail).toBe('ok');
  });

  it('preserves finished gates inside an orphaned run', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'wait' });
    const done = createGateResult(db, run.id, { gateId: 'lint', command: 'npm run lint', source: 'verify.yaml' });
    finishGateResult(db, done.id, { status: 'failed', exitCode: 2, durationMs: 900, logTail: '2 errors' });
    createGateResult(db, run.id, { gateId: 'unit', command: 'npm run test:unit', source: 'verify.yaml' });

    expect(reconcileOrphanVerificationRuns(db)).toEqual({ runs: 1, gates: 1 });

    const gates = getVerificationRun(db, run.id)?.gates ?? [];
    // The lint verdict was really reached before the crash; rewriting it would
    // destroy the only evidence the run produced.
    expect(gates.find((g) => g.gateId === 'lint')?.status).toBe('failed');
    expect(gates.find((g) => g.gateId === 'lint')?.exitCode).toBe(2);
    expect(gates.find((g) => g.gateId === 'unit')?.status).toBe('error');
  });

  it('reconciles orphans across every worktree', () => {
    createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'api' });
    createVerificationRun(db, { worktreeId: 'wt-2', trigger: 'manual' });
    createVerificationRun(db, { worktreeId: 'wt-3', trigger: 'wait' });

    expect(reconcileOrphanVerificationRuns(db)).toEqual({ runs: 3, gates: 0 });
    expect(getRunningVerificationRun(db, 'wt-2')).toBeNull();
    expect(getRunningVerificationRun(db, 'wt-3')).toBeNull();
  });

  it('is a no-op on an empty table', () => {
    expect(reconcileOrphanVerificationRuns(db)).toEqual({ runs: 0, gates: 0 });
  });

  it('keeps the open gate\'s real start and does not claim a measured window', () => {
    const run = createVerificationRun(db, { worktreeId: 'wt-1', trigger: 'api' });
    const gate = createGateResult(db, run.id, { gateId: 'build', command: 'npm run build', source: 'verify.yaml' });
    const openedAt = gate.startedAt.getTime();

    reconcileOrphanVerificationRuns(db);

    const closed = getVerificationRun(db, run.id)!.gates[0];
    // The gate really did start when the row was opened (#1625), so that stamp
    // stands. Its end is unknown — the process that would have written it is
    // gone — so `finished_at` is when recovery noticed, and the row says so
    // instead of implying an interval nothing measured.
    expect(closed.startedAt.getTime()).toBe(openedAt);
    expect(closed.durationMs).toBeNull();
    expect(closed.timingsMeasured).toBe(false);
  });
});

describe('server startup wiring', () => {
  const serverSource = readFileSync(join(process.cwd(), 'server.ts'), 'utf8');

  it('is invoked from server startup', () => {
    // A reconciler nothing calls is worse than none: the code reads as if crash
    // recovery exists. This repository has shipped that exact gap before.
    expect(serverSource).toContain('reconcileOrphanVerificationRuns(db)');
  });

  it('is loaded with a dynamic import, not a top-level one', () => {
    // A static import here pulls the module graph into server.ts's eval-time
    // graph and perturbs Next's AsyncLocalStorage bootstrap under `tsx
    // server.ts`, crashing the first request that compiles middleware.
    expect(serverSource).toContain("await import(\n          './src/lib/verification/verification-reconciler'\n        )");
    expect(serverSource).not.toMatch(/^import .*verification-reconciler/m);
  });
});
