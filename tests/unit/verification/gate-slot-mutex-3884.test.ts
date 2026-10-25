/**
 * A mutex wait does not hold a verification slot, and a gate's waits are
 * recorded apart from its execution (Issue #3884 H-11 / G6-5).
 *
 * Real processes, a real lock directory and the real slot queue, as
 * `gate-mutex.test.ts` does it: the properties under test — *this light gate
 * ran while two runs were queued for the heavy lock*, *no more than two gates
 * executed at once* — are orderings of process execution, and a mocked spawn
 * would only assert the order the test author imagined.
 *
 * The lock root and the index registry are redirected into `mkdtemp` for every
 * test, so nothing here serializes against a live run in another worktree.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import { listVerificationRunsForPeriod } from '@/lib/db/verification-db';
import type { VerificationGateResult } from '@/lib/db';
import {
  cancelVerification,
  MAX_CONCURRENT_VERIFICATIONS,
  MUTEX_LOG_PREFIX,
  startVerification,
  TIMING_LOG_PREFIX,
  waitForVerification,
} from '@/lib/verification/gate-runner';
import {
  acquireMachineLock,
  MACHINE_LOCK_ROOT_ENV,
  type MachineLockHandle,
} from '@/lib/verification/machine-lock';
import { WORKTREE_INDEX_ROOT_ENV } from '@/lib/verification/worktree-index';
import { classifySkipReason } from '@/lib/verification/run-verdict-vocabulary';
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

const HEAVY = 'heavy-3884';

let db: Database.Database;
let lockRoot: string;
let heldLock: MachineLockHandle | null = null;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repository whose `work` branch has uncommitted work, plus a verify.yaml. */
function createRepo(verifyYaml: string): string {
  const dir = tempDir('gate-slot-3884-');
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate-slot@example.test'], dir);
  git(['config', 'user.name', 'Gate Slot'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
  return dir;
}

/** One gate that writes `<label>-start` / `<label>-end` around a sleep into a shared log. */
function gateConfig(
  id: string,
  label: string,
  sharedLog: string,
  sleepSec: string,
  mutex?: string
): string {
  return `
version: 1
gates:
  - id: ${id}
    command: "sh -c 'echo ${label}-start >> ${sharedLog}; sleep ${sleepSec}; echo ${label}-end >> ${sharedLog}'"
    timeoutSec: 30
${mutex ? `    mutex: ${mutex}\n` : ''}options:
  baseRef: main
`;
}

async function startRun(worktreeId: string, verifyYaml: string): Promise<number> {
  const repo = createRepo(verifyYaml);
  upsertWorktree(db, {
    id: worktreeId,
    name: `feature/${worktreeId}`,
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
  const { runId } = await startVerification({ worktreeId, worktreePath: repo, trigger: 'api' });
  return runId;
}

function gateOf(runId: number, gateId: string): VerificationGateResult | undefined {
  return getVerificationRun(db, runId)?.gates.find((gate) => gate.gateId === gateId);
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function logLines(sharedLog: string): string[] {
  try {
    return readFileSync(sharedLog, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The `[timing]` numbers of a gate, in seconds. */
function timingOf(logTail: string | null | undefined): { queue: number; mutex: number; run: number } | null {
  const match = /^\[timing\] queue=([0-9.]+)s mutex=([0-9.]+)s run=([0-9.]+)s$/m.exec(logTail ?? '');
  return match ? { queue: Number(match[1]), mutex: Number(match[2]), run: Number(match[3]) } : null;
}

async function holdHeavyLock(): Promise<void> {
  const held = await acquireMachineLock(HEAVY, { root: lockRoot, timeoutMs: 0 });
  expect(held.acquired).toBe(true);
  if (held.acquired) heldLock = held.handle;
}

function releaseHeavyLock(): void {
  heldLock?.release();
  heldLock = null;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  lockRoot = tempDir('gate-slot-3884-locks-');
  vi.stubEnv(MACHINE_LOCK_ROOT_ENV, lockRoot);
  vi.stubEnv(WORKTREE_INDEX_ROOT_ENV, tempDir('gate-slot-3884-index-'));
});

afterEach(() => {
  releaseHeavyLock();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('a mutex wait does not hold a verification slot (Issue #3884 H-11)', () => {
  it('starts a third run’s light gate while two runs are queued for the heavy lock', async () => {
    // The precondition the fix is about: the two waiting runs alone fill every slot.
    expect(MAX_CONCURRENT_VERIFICATIONS).toBe(2);
    const sharedLog = join(tempDir('gate-slot-3884-log-'), 'order.log');
    // Another worktree's `unit` holds cpu.heavy for as long as this test needs.
    await holdHeavyLock();

    const runA = await startRun('wt-h11-a', gateConfig('unit', 'a', sharedLog, '0', HEAVY));
    const runB = await startRun('wt-h11-b', gateConfig('unit', 'b', sharedLog, '0', HEAVY));
    // Each gate row exists before its evaluator is entered: both runs are now
    // inside the lock wait (nothing of theirs has been spawned).
    expect(await until(() => gateOf(runA, 'unit') !== undefined && gateOf(runB, 'unit') !== undefined)).toBe(true);
    expect(logLines(sharedLog)).toEqual([]);

    const runC = await startRun('wt-h11-c', gateConfig('lint', 'c', sharedLog, '0'));
    // Before #3884 C sat behind MAX_CONCURRENT_VERIFICATIONS until A or B ran
    // out of the gate's whole timeoutSec: its 0-second lint could not start.
    expect(await until(() => getVerificationRun(db, runC)?.status === 'passed', 8_000)).toBe(true);
    expect(gateOf(runC, 'lint')?.status).toBe('passed');
    // Still nothing heavy ran: the lock was held the whole time C ran.
    expect(logLines(sharedLog)).toEqual(['c-start', 'c-end']);
    expect(gateOf(runA, 'unit')?.finishedAt).toBeNull();

    releaseHeavyLock();
    await Promise.all([waitForVerification(runA), waitForVerification(runB)]);
    expect(gateOf(runA, 'unit')?.status).toBe('passed');
    expect(gateOf(runB, 'unit')?.status).toBe('passed');
    // The heavy gates are still one at a time: the mutex was not weakened.
    const heavy = logLines(sharedLog).slice(2);
    expect(heavy).toHaveLength(4);
    expect(heavy[1]).toBe(heavy[0].replace('-start', '-end'));
    expect(heavy[3]).toBe(heavy[2].replace('-start', '-end'));
  }, 30_000);

  it('still executes at most MAX_CONCURRENT_VERIFICATIONS gates at once', async () => {
    // Negative control: handing the slot back during a mutex wait must not turn
    // into "every run executes at once" — the load a gate is judged under is
    // what keeps the verdict from flipping.
    const sharedLog = join(tempDir('gate-slot-3884-log-'), 'order.log');
    const runs = await Promise.all(
      ['p', 'q', 'r'].map((label) =>
        startRun(`wt-bound-${label}`, gateConfig('lint', label, sharedLog, '0.4'))
      )
    );
    await Promise.all(runs.map((runId) => waitForVerification(runId)));

    let running = 0;
    let peak = 0;
    for (const line of logLines(sharedLog)) {
      running += line.endsWith('-start') ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(MAX_CONCURRENT_VERIFICATIONS);

    // The run that queued says so, apart from its own execution.
    const timings = runs.map((runId) => timingOf(gateOf(runId, 'lint')?.logTail));
    const queued = timings.filter((timing) => timing !== null);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.queue as number).toBeGreaterThan(0.2);
    expect(queued[0]?.mutex).toBe(0);
    // `run` is the stored duration, and the duration never includes the queue (#1771).
    const queuedRun = runs[timings.findIndex((timing) => timing !== null)];
    const gate = gateOf(queuedRun, 'lint');
    expect(queued[0]?.run).toBe(Number(((gate?.durationMs as number) / 1000).toFixed(1)));
    expect(gate?.durationMs as number).toBeLessThan((queued[0]?.queue as number) * 1000 + 1000);
  }, 30_000);

  it('gives a run that already holds the lock the next slot ahead of a run waiting to start', async () => {
    // Order fixed by this test: once A holds cpu.heavy, every second it waits
    // for a slot is a second the machine's heavy slot runs nothing.
    const sharedLog = join(tempDir('gate-slot-3884-log-'), 'order.log');
    await holdHeavyLock();
    const runA = await startRun('wt-prio-a', gateConfig('unit', 'a', sharedLog, '0', HEAVY));
    expect(await until(() => gateOf(runA, 'unit') !== undefined)).toBe(true);

    // B and C take both slots with a gate that runs for a while.
    const runB = await startRun('wt-prio-b', gateConfig('lint', 'b', sharedLog, '1.2'));
    const runC = await startRun('wt-prio-c', gateConfig('lint', 'c', sharedLog, '1.2'));
    expect(
      await until(() => logLines(sharedLog).filter((line) => line.endsWith('-start')).length === 2)
    ).toBe(true);
    // D queues for a slot first; then the lock comes free and A takes it.
    const runD = await startRun('wt-prio-d', gateConfig('lint', 'd', sharedLog, '0'));
    releaseHeavyLock();

    await Promise.all([runA, runB, runC, runD].map((runId) => waitForVerification(runId)));
    const lines = logLines(sharedLog);
    expect(lines.indexOf('a-start')).toBeGreaterThan(-1);
    expect(lines.indexOf('a-start')).toBeLessThan(lines.indexOf('d-start'));
    const timing = timingOf(gateOf(runA, 'unit')?.logTail);
    expect(timing?.mutex as number).toBeGreaterThan(0);
    expect(timing?.queue as number).toBeGreaterThan(0);
  }, 30_000);
});

describe('cancelling a run that gave its slot back for a mutex (Issue #3884 N3)', () => {
  it('closes a run cancelled in its mutex wait without waiting for the two slots to come free', async () => {
    const sharedLog = join(tempDir('gate-slot-3884-log-'), 'order.log');
    await holdHeavyLock();
    const runA = await startRun('wt-n3-a', gateConfig('unit', 'a', sharedLog, '0', HEAVY));
    expect(await until(() => gateOf(runA, 'unit') !== undefined)).toBe(true);
    // B and C take both slots for longer than the cancel endpoint waits (8s).
    const runB = await startRun('wt-n3-b', gateConfig('lint', 'b', sharedLog, '10'));
    const runC = await startRun('wt-n3-c', gateConfig('lint', 'c', sharedLog, '10'));
    expect(
      await until(() => logLines(sharedLog).filter((line) => line.endsWith('-start')).length === 2)
    ).toBe(true);

    const startedAt = Date.now();
    const outcome = await cancelVerification(runA);
    // Before N3 the cancelled wait went on to queue for a slot behind B and C,
    // and the endpoint answered `requested` with A still `running`.
    expect(outcome).toEqual({ kind: 'cancelled', status: 'cancelled' });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(getVerificationRun(db, runA)?.status).toBe('cancelled');
    // B and C are untouched: still running, and A never started.
    expect(logLines(sharedLog)).toEqual(expect.arrayContaining(['b-start', 'c-start']));
    expect(logLines(sharedLog)).not.toContain('a-start');
    expect(logLines(sharedLog).some((line) => line.endsWith('-end'))).toBe(false);

    await Promise.all([cancelVerification(runB), cancelVerification(runC)]);
  }, 40_000);

  it('releases the lock of a run cancelled while it waits for a slot after taking the lock', async () => {
    const sharedLog = join(tempDir('gate-slot-3884-log-'), 'order.log');
    await holdHeavyLock();
    const runA = await startRun('wt-n3l-a', gateConfig('unit', 'a', sharedLog, '0', HEAVY));
    expect(await until(() => gateOf(runA, 'unit') !== undefined)).toBe(true);
    const runB = await startRun('wt-n3l-b', gateConfig('lint', 'b', sharedLog, '10'));
    const runC = await startRun('wt-n3l-c', gateConfig('lint', 'c', sharedLog, '10'));
    expect(
      await until(() => logLines(sharedLog).filter((line) => line.endsWith('-start')).length === 2)
    ).toBe(true);
    // The lock comes free and A takes it; A then waits for a slot B and C hold.
    releaseHeavyLock();
    const lockDir = join(lockRoot, `${HEAVY}.lock`);
    expect(await until(() => existsSync(lockDir))).toBe(true);

    const startedAt = Date.now();
    const outcome = await cancelVerification(runA);
    expect(outcome).toEqual({ kind: 'cancelled', status: 'cancelled' });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(gateOf(runA, 'unit')?.status).toBe('skipped');
    expect(logLines(sharedLog)).not.toContain('a-start');
    // The lock is not left held for a run that will never use it.
    expect(existsSync(lockDir)).toBe(false);

    await Promise.all([cancelVerification(runB), cancelVerification(runC)]);
  }, 40_000);
});

describe('[timing]: waits and execution recorded apart (Issue #3884)', () => {
  it('records queue, mutex and run for a mutexed gate, next to the [mutex] waited=', async () => {
    const sharedLog = join(tempDir('gate-slot-3884-log-'), 'order.log');
    await holdHeavyLock();
    const runId = await startRun('wt-timing', gateConfig('unit', 't', sharedLog, '0', HEAVY));
    expect(await until(() => gateOf(runId, 'unit') !== undefined)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    releaseHeavyLock();
    await waitForVerification(runId);

    const gate = gateOf(runId, 'unit');
    expect(gate?.status).toBe('passed');
    const timing = timingOf(gate?.logTail);
    expect(timing).not.toBeNull();
    // The same wait `[mutex] waited=` has always reported, now beside the queue.
    const waited = /^\[mutex\] [^\n]*?\bwaited=([0-9.]+)s/m.exec(gate?.logTail ?? '');
    expect(Number(waited?.[1])).toBe(timing?.mutex);
    expect(timing?.mutex as number).toBeGreaterThan(0.2);
    expect(timing?.queue).toBe(0);
    expect(timing?.run).toBe(Number(((gate?.durationMs as number) / 1000).toFixed(1)));
    // The first line is still the [mutex] marker the CLI and the reader take first.
    expect(gate?.logTail?.split('\n')[0]).toMatch(new RegExp(`^\\${MUTEX_LOG_PREFIX} `));
    expect(gate?.logTail?.trimEnd().split('\n').at(-1)).toMatch(new RegExp(`^\\${TIMING_LOG_PREFIX} `));
  }, 20_000);

  it('reaches the history listing as numbers, the way verify history --json reads it (N4)', async () => {
    const sharedLog = join(tempDir('gate-slot-3884-log-'), 'order.log');
    await holdHeavyLock();
    const runId = await startRun('wt-timing-history', gateConfig('unit', 'h', sharedLog, '0', HEAVY));
    expect(await until(() => gateOf(runId, 'unit') !== undefined)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseHeavyLock();
    await waitForVerification(runId);

    const stored = timingOf(gateOf(runId, 'unit')?.logTail);
    const listed = listVerificationRunsForPeriod(db).find((run) => run.id === runId);
    const unit = listed?.gates.find((gate) => gate.gateId === 'unit');
    expect(stored).not.toBeNull();
    expect(unit?.timing).toEqual({ queueSec: stored?.queue, mutexSec: stored?.mutex, runSec: stored?.run });
    // The built-in gates waited for nothing: no timing for them.
    expect(listed?.gates.find((gate) => gate.gateId === 'work-evidence')).not.toHaveProperty('timing');
  }, 20_000);

  it('keeps a mutex-wait skip reading as mutex-wait, with the wait on the timing line', async () => {
    const sharedLog = join(tempDir('gate-slot-3884-log-'), 'order.log');
    await holdHeavyLock();
    const runId = await startRun(
      'wt-timing-skip',
      gateConfig('unit', 's', sharedLog, '0', HEAVY).replace('timeoutSec: 30', 'timeoutSec: 1')
    );
    await waitForVerification(runId);

    const gate = gateOf(runId, 'unit');
    expect(gate?.status).toBe('skipped');
    // The first line is still the skip reason, and the classifier still reads it.
    expect(gate?.logTail?.split('\n')[0]).toMatch(/^reason=mutex-wait waited=/);
    expect(classifySkipReason(gate?.logTail ?? '')).toBe('mutex');
    expect(timingOf(gate?.logTail)?.mutex as number).toBeGreaterThanOrEqual(1);
    expect(timingOf(gate?.logTail)?.run).toBe(0);
    expect(logLines(sharedLog)).toEqual([]);
  }, 20_000);
});

describe('acquireMachineLock onWait (Issue #3884)', () => {
  it('is not called for a lock that is free', async () => {
    let calls = 0;
    const result = await acquireMachineLock('free-3884', {
      root: lockRoot,
      timeoutMs: 1000,
      onWait: () => {
        calls += 1;
      },
    });
    expect(result.acquired).toBe(true);
    expect(calls).toBe(0);
    if (result.acquired) result.handle.release();
  });

  it('is called once for a lock that stays busy, however many polls the wait takes', async () => {
    await holdHeavyLock();
    let calls = 0;
    const result = await acquireMachineLock(HEAVY, {
      root: lockRoot,
      timeoutMs: 300,
      pollIntervalMs: 50,
      onWait: () => {
        calls += 1;
      },
    });
    expect(result.acquired).toBe(false);
    expect(calls).toBe(1);
  });
});
