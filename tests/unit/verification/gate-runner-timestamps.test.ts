/**
 * Gate timestamps describe the execution, not the write (Issue #1625).
 *
 * `verification_gate_results.started_at` / `finished_at` used to be stamped by
 * `createGateResult` / `finishGateResult` back to back *after* the gate had
 * already finished, so both landed in the same millisecond and their difference
 * had nothing to do with `duration_ms`. A reader of the history API could not
 * recover when a gate ran or how long it took from the timestamps at all.
 *
 * These tests spawn real processes for the same reason the rest of the runner's
 * suite does: the property under test is "the stamps bracket a real execution",
 * and a mocked clock would only assert that the mock was called in the order
 * the test author imagined.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import type { VerificationGateResult } from '@/lib/db';
import {
  CONFIG_GATE_ID,
  SCOPE_GATE_ID,
  startVerification,
  waitForVerification,
  WORK_EVIDENCE_GATE_ID,
} from '@/lib/verification/gate-runner';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

let db: Database.Database;
const tempDirs: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(verifyYaml?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-timestamps-')));
  tempDirs.push(dir);

  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate-runner@example.test'], dir);
  git(['config', 'user.name', 'Gate Runner'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);

  writeFileSync(join(dir, 'README.md'), 'base\n');
  if (verifyYaml !== undefined) {
    mkdirSync(join(dir, '.commandmate'), { recursive: true });
    writeFileSync(join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
  }
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);

  return dir;
}

/** Give the worktree something to verify, so work-evidence passes. */
function addUncommittedWork(dir: string): void {
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
}

function registerWorktree(id: string, path: string): void {
  upsertWorktree(db, {
    id,
    name: `feature/${id}`,
    path,
    repositoryPath: path,
    repositoryName: 'fixture',
  });
}

function gatesById(runId: number): Map<string, VerificationGateResult> {
  const run = getVerificationRun(db, runId);
  return new Map((run?.gates ?? []).map((gate) => [gate.gateId, gate]));
}

async function runToCompletion(worktreeId: string, worktreePath: string): Promise<number> {
  const { runId } = await startVerification({ worktreeId, worktreePath, trigger: 'api' });
  await waitForVerification(runId);
  return runId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A database whose gate-row INSERT takes `delayMs`.
 *
 * The runner opens the row before spawning the gate, so on a real file-backed
 * SQLite the opening stamp lands measurably before the command starts. Against
 * an in-memory database that gap is under a millisecond, which would let a
 * runner that stamped the row's write times instead of the measured interval
 * pass by luck. The delay makes the difference between the two visible.
 */
function withSlowGateInserts(real: Database.Database, delayMs: number): Database.Database {
  const bind = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  };

  return new Proxy(real, {
    get(target, prop) {
      if (prop !== 'prepare') return bind(target, prop);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/INSERT INTO verification_gate_results/i.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, innerProp) {
            if (innerProp !== 'run') return bind(inner, innerProp);
            return (...args: unknown[]) => {
              // Busy-wait: better-sqlite3 is synchronous, and so is the write
              // this stands in for.
              const until = Date.now() + delayMs;
              while (Date.now() < until) {
                /* spin */
              }
              return (inner.run as (...a: unknown[]) => unknown)(...args);
            };
          },
        });
      };
    },
  }) as Database.Database;
}

/** How long the observable gate sleeps for. Long enough that a record-time
 *  stamp pair (both written after the run) cannot be mistaken for it. */
const GATE_SLEEP_MS = 400;

const SLEEPING_CONFIG = `
version: 1
gates:
  - id: slow
    command: "sh -c 'sleep 0.4'"
    timeoutSec: 30
options:
  baseRef: main
`;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('gate timestamps — executed gates', () => {
  it('stamps started_at and finished_at around the execution, not around the write', async () => {
    const repo = createRepo(SLEEPING_CONFIG);
    addUncommittedWork(repo);
    registerWorktree('wt-window', repo);

    const runId = await runToCompletion('wt-window', repo);

    const slow = gatesById(runId).get('slow');
    expect(slow?.status).toBe('passed');
    // The measurement that was already correct, kept as the reference.
    expect(slow!.durationMs).toBeGreaterThanOrEqual(GATE_SLEEP_MS - 50);

    // The defect: both stamps were written after the gate finished, so the
    // window collapsed to ~0ms while duration_ms said 400ms.
    const window = slow!.finishedAt!.getTime() - slow!.startedAt.getTime();
    expect(window).toBeGreaterThanOrEqual(GATE_SLEEP_MS - 50);
    // Exact, not approximate: the stamps are the endpoints of the interval
    // duration_ms counted, so a tolerance here would hide a stamp taken from a
    // different clock reading than the measurement.
    expect(window).toBe(slow!.durationMs);
    expect(slow!.timingsMeasured).toBe(true);
  });

  it('does not let the cost of writing the row leak into the window', async () => {
    const repo = createRepo(SLEEPING_CONFIG);
    addUncommittedWork(repo);
    registerWorktree('wt-slow-write', repo);

    const insertDelayMs = 60;
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(withSlowGateInserts(db, insertDelayMs));

    const runId = await runToCompletion('wt-slow-write', repo);

    const slow = gatesById(runId).get('slow')!;
    expect(slow.status).toBe('passed');
    // The row was opened well before the command started. A window taken from
    // the two write times would be at least `insertDelayMs` too wide; the one
    // stored is the interval the runner measured, so it is neither.
    expect(slow.finishedAt!.getTime() - slow.startedAt.getTime()).toBe(slow.durationMs);
    expect(slow.durationMs).toBeLessThan(GATE_SLEEP_MS + insertDelayMs);
    expect(slow.timingsMeasured).toBe(true);
  });

  it('keeps every gate window inside the run window', async () => {
    const repo = createRepo(SLEEPING_CONFIG);
    addUncommittedWork(repo);
    registerWorktree('wt-nested', repo);

    const runId = await runToCompletion('wt-nested', repo);
    const run = getVerificationRun(db, runId)!;

    // The run-level stamps were never broken (createVerificationRun runs before
    // the gates and finishVerificationRun after), and this pins that: if the
    // gate stamps ever drift back to write time they stay inside the run, but a
    // gate window that escapes the run means one of the two is fabricated.
    expect(run.gates.length).toBeGreaterThan(0);
    for (const gate of run.gates) {
      expect(gate.startedAt.getTime()).toBeGreaterThanOrEqual(run.startedAt.getTime());
      expect(gate.finishedAt!.getTime()).toBeLessThanOrEqual(run.finishedAt!.getTime());
    }
  });

  it('orders the gates by when they actually ran', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: first
    command: "sh -c 'sleep 0.2'"
    timeoutSec: 30
  - id: second
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-order', repo);

    const runId = await runToCompletion('wt-order', repo);
    const gates = gatesById(runId);

    // Sequential execution, so the later gate cannot start before the earlier
    // one ends. Under record-time stamping every gate reported the same instant
    // and this said nothing.
    expect(gates.get('second')!.startedAt.getTime()).toBeGreaterThanOrEqual(
      gates.get('first')!.finishedAt!.getTime()
    );
  });

  it('stamps a timed-out gate around the execution it was killed during', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: hangs
    command: "sh -c 'sleep 30'"
    timeoutSec: 1
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-timeout', repo);

    const runId = await runToCompletion('wt-timeout', repo);

    const hangs = gatesById(runId).get('hangs')!;
    expect(hangs.status).toBe('timeout');
    // A timeout is the case where "how long did it take" matters most, and it
    // is the one a zero-length window destroyed most completely.
    expect(hangs.finishedAt!.getTime() - hangs.startedAt.getTime()).toBe(hangs.durationMs);
    expect(hangs.durationMs).toBeGreaterThanOrEqual(900);
  });
});

describe('gate timestamps — the running window', () => {
  it('opens the gate row before the command runs, so a crash leaves it running', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: blocking
    command: "sh -c 'while [ ! -f release ]; do sleep 0.05; done'"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-running', repo);

    const { runId } = await startVerification({
      worktreeId: 'wt-running',
      worktreePath: repo,
      trigger: 'api',
    });

    // The row must exist *while* the gate is executing. Without it a process
    // that dies mid-gate leaves no record that the gate was ever entered, and
    // the reconciler (#1543) has nothing to close — the loop it runs over open
    // gate rows was unreachable for gate-runner-written rows.
    let observed: VerificationGateResult | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !observed) {
      await sleep(20);
      observed = gatesById(runId).get('blocking');
      if (observed && observed.status !== 'running') break;
    }

    expect(observed?.status).toBe('running');
    expect(observed?.finishedAt).toBeNull();
    expect(observed?.durationMs).toBeNull();
    // An open row has no measured window yet, and must not claim one.
    expect(observed?.timingsMeasured).toBe(false);

    writeFileSync(join(repo, 'release'), '');
    await waitForVerification(runId);

    const closed = gatesById(runId).get('blocking')!;
    expect(closed.status).toBe('passed');
    expect(closed.timingsMeasured).toBe(true);
    expect(closed.finishedAt!.getTime() - closed.startedAt.getTime()).toBe(closed.durationMs);
  });
});

describe('gate timestamps — gates that never ran', () => {
  it('gives a skipped gate a zero-length window at the moment it was skipped', async () => {
    const repo = createRepo(SLEEPING_CONFIG);
    // No work at all: work-evidence fails and every gate below it is skipped.
    registerWorktree('wt-skipped', repo);

    const before = Date.now();
    const runId = await runToCompletion('wt-skipped', repo);
    const after = Date.now();

    const gates = gatesById(runId);
    expect(gates.get('slow')?.status).toBe('skipped');

    for (const gateId of [SCOPE_GATE_ID, 'slow']) {
      const gate = gates.get(gateId)!;
      // Nothing executed, so there is no interval to report. `started_at` is
      // NOT NULL in the schema and a null `finished_at` already means "still
      // open", so a skip is recorded as a zero-length window instead: the
      // instant the decision was made, with duration 0. That keeps
      // finished_at - started_at === duration_ms true for every row.
      expect(gate.durationMs).toBe(0);
      expect(gate.finishedAt!.getTime()).toBe(gate.startedAt.getTime());
      expect(gate.startedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(gate.finishedAt!.getTime()).toBeLessThanOrEqual(after);
      expect(gate.timingsMeasured).toBe(true);
    }
  });

  it('gives the config pseudo-gate the same zero-length window', async () => {
    const repo = createRepo();
    addUncommittedWork(repo);
    registerWorktree('wt-noconfig', repo);

    const runId = await runToCompletion('wt-noconfig', repo);

    const config = gatesById(runId).get(CONFIG_GATE_ID)!;
    expect(config.status).toBe('error');
    // The config gate carries a message, not an execution (#1543); it is the
    // one row that never had a command to time.
    expect(config.durationMs).toBe(0);
    expect(config.finishedAt!.getTime()).toBe(config.startedAt.getTime());
    expect(config.timingsMeasured).toBe(true);
  });

  it('stamps the work-evidence gate around its own git commands', async () => {
    const repo = createRepo(SLEEPING_CONFIG);
    addUncommittedWork(repo);
    registerWorktree('wt-builtin', repo);

    const runId = await runToCompletion('wt-builtin', repo);

    const evidence = gatesById(runId).get(WORK_EVIDENCE_GATE_ID)!;
    expect(evidence.status).toBe('passed');
    // The built-in gates spawn git rather than a shell command, and they were
    // stamped by the same broken record() path.
    expect(evidence.finishedAt!.getTime() - evidence.startedAt.getTime()).toBe(
      evidence.durationMs
    );
    expect(evidence.timingsMeasured).toBe(true);
  });
});
