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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
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
import { removeTempDir } from '@tests/helpers/temp-dir';

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
 * Hold this thread for at least `ms`, without burning a core.
 *
 * better-sqlite3 is synchronous and so is the write this stands in for, so the
 * delay has to hold the thread rather than yield to the event loop. It must not
 * spin to do it: a busy-wait competes for the CPU with the very process whose
 * scheduling this file measures, so the old spin made the machine noisier in
 * exactly the way that then broke its own timing budget (#1849).
 */
function blockThread(ms: number): void {
  const lock = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const until = Date.now() + ms;
  // Nothing ever notifies `lock`, so every call returns by timing out. Looping
  // on the wall clock covers a wait that comes back a hair early.
  for (let remaining = ms; remaining > 0; remaining = until - Date.now()) {
    Atomics.wait(lock, 0, 0, remaining);
  }
}

/**
 * When a gate row's INSERT was entered and when it returned, read from the same
 * clock the runner stamps rows with.
 */
interface ObservedInsert {
  gateId: string;
  enteredAt: number;
  returnedAt: number;
}

/**
 * A database whose INSERT of `gateId`'s row costs `delayMs`, reported into
 * `observed`.
 *
 * The runner opens the row before spawning the gate, so on a real file-backed
 * SQLite the opening stamp lands measurably before the command starts. Against
 * an in-memory database that gap is under a millisecond, which would let a
 * runner that stamped the row's write times instead of the measured interval
 * pass by luck. The delay makes the difference between the two visible.
 *
 * `observed` is what makes it checkable without a stopwatch: the write occupies
 * a known interval on the wall clock, and the window the runner reports has to
 * begin after that interval ended. Only the row under test pays the delay —
 * every other gate's write stays free, so the run costs one delay, not one per
 * gate.
 */
function withSlowGateInserts(
  real: Database.Database,
  gateId: string,
  delayMs: number,
  observed: ObservedInsert[]
): Database.Database {
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
            // Bound, not just referenced: better-sqlite3's `run` is a native
            // method and needs its statement as the receiver.
            const run = (inner.run as (...a: unknown[]) => unknown).bind(inner);
            return (...args: unknown[]) => {
              // createGateResult binds (run_id, gate_id, command, started_at,
              // source), so the row's identity is the second parameter.
              if (args[1] !== gateId) return run(...args);
              const enteredAt = Date.now();
              blockThread(delayMs);
              const result = run(...args);
              observed.push({ gateId, enteredAt, returnedAt: Date.now() });
              return result;
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

/**
 * The write cost injected into the gate row's INSERT (#1849).
 *
 * Sized against the *upper* bound it buys, not against a realistic write. The
 * gate's own duration is a `sleep` plus however long the OS took to get around
 * to spawning, waking and reaping it, and that scheduling jitter is unbounded
 * on a loaded machine — measured here at up to 82ms with the box oversubscribed
 * (`sleep 0.4` reporting 482ms). An upper bound of `GATE_SLEEP_MS + this` both
 * tolerates jitter smaller than this value and still catches a leak of exactly
 * this value, so raising it widens the jitter budget without costing any
 * detection: a runner that folded the write into the window reports at least
 * `GATE_SLEEP_MS + this`, whatever this is. 400ms leaves ~5x headroom over the
 * worst jitter seen. It is not a spin (see {@link blockThread}), so the run pays
 * it in wall clock only.
 */
const INSERT_DELAY_MS = 400;

/**
 * How long the hanging gate is allowed to run before the runner kills it.
 * Interpolated into the config below so the two cannot drift apart.
 */
const GATE_TIMEOUT_MS = 1000;

// `sleep` takes seconds, so the command is derived rather than written out:
// a change to GATE_SLEEP_MS that left the command alone would silently move
// every bound in this file off the thing it is bounding.
const SLEEPING_CONFIG = `
version: 1
gates:
  - id: slow
    command: "sh -c 'sleep ${GATE_SLEEP_MS / 1000}'"
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
    if (dir) removeTempDir(dir);
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
    // The measurement that was already correct, kept as the reference. Both
    // bounds below are lower bounds on a sleep, which is the direction load
    // cannot break: jitter only ever makes the observed interval longer, so the
    // 50ms of slack is covering a `sleep` that returns fractionally early, not
    // a busy machine (#1849).
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

    const inserts: ObservedInsert[] = [];
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(withSlowGateInserts(db, 'slow', INSERT_DELAY_MS, inserts));

    const runId = await runToCompletion('wt-slow-write', repo);
    // Issue #1950: one wall-clock reading taken here, used as the ceiling
    // below. Everything that could possibly belong to this gate happened
    // before it.
    const doneAt = Date.now();

    const slow = gatesById(runId).get('slow')!;
    expect(slow.status).toBe('passed');

    // Everything below is relative to this write, so prove it happened and
    // cost what it was asked to. A mock that silently stopped matching would
    // otherwise leave the assertions passing against a free write.
    const insert = inserts.find((observed) => observed.gateId === 'slow');
    expect(insert, "the slow gate's row INSERT was never intercepted").toBeDefined();
    expect(insert!.returnedAt - insert!.enteredAt).toBeGreaterThanOrEqual(INSERT_DELAY_MS);

    // The row was opened well before the command started, and the stored window
    // is the interval the runner measured rather than either write time.
    expect(slow.finishedAt!.getTime() - slow.startedAt.getTime()).toBe(slow.durationMs);

    // The load-bearing check, and the only one here that needs no timing budget
    // at all: the write owns [enteredAt, returnedAt] on the wall clock, and the
    // reported window has to start strictly after it. A runner that stamped the
    // row's own write time — #1625's defect, in either the started_at or the
    // duration_ms half — starts inside that interval and fails, and it fails on
    // a 1ms leak, not only on one bigger than the machine's scheduling jitter.
    expect(slow.startedAt.getTime()).toBeGreaterThanOrEqual(insert!.returnedAt);

    // Kept as the second half of the same statement: the leak the check above
    // catches at the window's start, this one catches in its length, for a
    // runner that measured from before the write while stamping started_at
    // after it.
    //
    // Issue #1950 changed the ceiling from the constant
    // `GATE_SLEEP_MS + INSERT_DELAY_MS` (800ms) to an interval this run
    // actually observed. The constant compared a real `sleep`, measured on a
    // shared machine, against a fixed number, so a busy box failed it while the
    // runner was behaving perfectly: CI reported `expected 1104 to be less than
    // 800` on a PR that touched nothing under src/lib/verification.
    //
    // `doneAt - insert.returnedAt` cannot do that. It is the wall clock from
    // the moment the row write returned — which is when the command was free to
    // start — to after the whole run came back, so it STRICTLY CONTAINS the
    // interval a correct runner measures. Load inflates both sides together and
    // the assertion holds; there is no machine speed at which a correct runner
    // fails it.
    //
    // It still catches the leak it was written for, because a runner that
    // counted from before the write reports `duration + INSERT_DELAY_MS` (400ms
    // by construction) while the ceiling only grows by the run's post-command
    // bookkeeping, which is nowhere near that. Verified by injecting exactly
    // that defect into src/lib/verification/gate-runner.ts (#1950 mutation M5).
    // The 1ms-exact half of the detection is the `startedAt` assertion above;
    // this one is the magnitude half.
    expect(slow.durationMs).toBeLessThanOrEqual(doneAt - insert!.returnedAt);
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
    timeoutSec: ${GATE_TIMEOUT_MS / 1000}
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
    // A lower bound, so scheduling jitter can only make it hold harder: the
    // kill timer cannot fire early, and a loaded machine reaps the child later,
    // never sooner. The 100ms of slack is for timer resolution alone (#1849).
    expect(hangs.durationMs).toBeGreaterThanOrEqual(GATE_TIMEOUT_MS - 100);
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
