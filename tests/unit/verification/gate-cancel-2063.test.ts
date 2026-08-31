/**
 * The runner's cancel switch (Issue #2063).
 *
 * `tests/integration/verification-cancel-2063.test.ts` proves the property that
 * matters most — the child process group actually dies. What is pinned here is
 * everything around that: which verdict a cancelled run closes with, what the
 * gate rows say, that the retry a `retryOnFail` gate would otherwise get is not
 * granted to a command the operator just stopped, and that a run nobody
 * cancelled behaves exactly as it did before this Issue.
 *
 * Real processes and real repositories, as the rest of this directory does: a
 * mocked `spawn` would assert the shape of the mock rather than the behaviour
 * of a signal.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, getTask, getVerificationRun, upsertWorktree } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import {
  cancelVerification,
  startVerification,
  waitForVerification,
} from '@/lib/verification/gate-runner';
import {
  acquireMachineLock,
  MACHINE_LOCK_ROOT_ENV,
  type MachineLockHandle,
} from '@/lib/verification/machine-lock';
import {
  CANCELLED_SKIP_LOG,
  PRIMARY_CHECKOUT_SKIP_LOG,
  SKIP_LOG_MARKERS,
  WORK_EVIDENCE_SKIP_LOG,
  classifySkipReason,
} from '@/lib/verification/run-verdict-vocabulary';
import {
  SCOPE_SKIP_NO_CONTRACT,
  SCOPE_SKIP_NOT_REQUIRED,
  scopeSkipDetachedContract,
} from '@/lib/verification/scope-gate';
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
const WT_ID = 'wt-cancel-unit';
const tempDirs: string[] = [];

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(verifyYaml: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-cancel-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'cancel@example.test'], dir);
  git(['config', 'user.name', 'Cancel'], dir);
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

function register(path: string): void {
  upsertWorktree(db, {
    id: WT_ID,
    name: 'feature/cancel',
    path,
    repositoryPath: path,
    repositoryName: 'fixture',
  });
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/**
 * A gate that parks until it is signalled, announcing that it started.
 *
 * Composed from the worktree path, so the fixture is written after the
 * repository exists — {@link parkedRepo} does both in the right order.
 */
const PARKED_CONFIG = (dir: string) => `
version: 1
gates:
  - id: parked
    command: "sh -c 'touch ${dir}/started; sleep 120'"
    timeoutSec: 120
options:
  baseRef: main
`;

/** A registered worktree whose only gate parks. */
function parkedRepo(): string {
  // Created with a placeholder body, then rewritten: the gate command has to
  // name the directory, and the directory does not exist until git init has run.
  const dir = createRepo('version: 1\ngates: []\n');
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), PARKED_CONFIG(dir));
  register(dir);
  return dir;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('cancelVerification (Issue #2063)', () => {
  it('closes the run as cancelled and reports what it closed as', async () => {
    const repo = parkedRepo();

    const { runId } = await startVerification({
      worktreeId: WT_ID,
      worktreePath: repo,
      trigger: 'api',
    });
    expect(await until(() => existsSync(join(repo, 'started')))).toBe(true);

    await expect(cancelVerification(runId)).resolves.toEqual({
      kind: 'cancelled',
      status: 'cancelled',
    });
    expect(getVerificationRun(db, runId)?.status).toBe('cancelled');
  });

  it('records the interrupted gate as skipped, classified as a cancel', async () => {
    const repo = parkedRepo();

    const { runId } = await startVerification({
      worktreeId: WT_ID,
      worktreePath: repo,
      trigger: 'api',
    });
    expect(await until(() => existsSync(join(repo, 'started')))).toBe(true);
    await cancelVerification(runId);

    const gate = getVerificationRun(db, runId)?.gates.find((g) => g.gateId === 'parked');
    // `skipped`, not `failed`: the command reached no verdict about the work,
    // and a red gate here would read as "the diff is bad" to anyone scanning.
    expect(gate?.status).toBe('skipped');
    expect(gate?.exitCode).toBeNull();
    // The pane reads the reason out of the log; this is the seam that carries it.
    expect(gate?.logTail).toContain(CANCELLED_SKIP_LOG);
    expect(classifySkipReason(gate?.logTail ?? null)).toBe('cancelled');
  });

  it('does not grant a retryOnFail gate a second run after a cancel', async () => {
    const repo = createRepo('version: 1\ngates: []\n');
    writeFileSync(
      join(repo, '.commandmate', 'verify.yaml'),
      `
version: 1
gates:
  - id: flaky-parked
    command: "sh -c 'echo attempt >> ${repo}/attempts; sleep 120'"
    timeoutSec: 120
    retryOnFail: 1
options:
  baseRef: main
`
    );
    register(repo);

    const { runId } = await startVerification({
      worktreeId: WT_ID,
      worktreePath: repo,
      trigger: 'api',
    });
    expect(await until(() => existsSync(join(repo, 'attempts')))).toBe(true);
    await cancelVerification(runId);

    // One attempt, not two. A cancelled attempt reports `skipped`, and only a
    // `failed` one is retried — so the operator's Stop cannot buy a second run
    // of the very command they stopped.
    const attempts = readFileSync(join(repo, 'attempts'), 'utf-8');
    expect(attempts.trim().split('\n')).toHaveLength(1);
    expect(getVerificationRun(db, runId)?.status).toBe('cancelled');
  });

  it('moves an attached contract task to cancelled', async () => {
    const repo = parkedRepo();
    const task = createTask(db, {
      worktreeId: WT_ID,
      cliToolId: 'claude',
      contractPath: '.commandmate/tasks/t.yaml',
      contract: parseTaskContract(
        'version: 1\ntitle: t\ngoal: g\nscope:\n  allow: ["**"]\n',
        'task.yaml'
      ),
      status: 'running',
    });

    const { runId } = await startVerification({
      worktreeId: WT_ID,
      worktreePath: repo,
      trigger: 'api',
    });
    expect(await until(() => existsSync(join(repo, 'started')))).toBe(true);
    await cancelVerification(runId);

    // `verifying -> cancel -> cancelled` is a transition the state machine
    // already had and nothing could reach. Leaving the task in `verifying`
    // would strand it: only a run's verdict moves it out, and this run has none.
    expect(getTask(db, task.id)?.status).toBe('cancelled');
  });

  it('answers not-running for a run this process is not executing', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: quick
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
`);
    register(repo);
    const { runId } = await startVerification({
      worktreeId: WT_ID,
      worktreePath: repo,
      trigger: 'api',
    });
    await waitForVerification(runId);

    // Already finished, so its switch is gone. Reporting `not-running` is what
    // lets the route answer 409 instead of claiming to have stopped something.
    await expect(cancelVerification(runId)).resolves.toEqual({ kind: 'not-running' });
    await expect(cancelVerification(999_999)).resolves.toEqual({ kind: 'not-running' });
    // And the recorded verdict is untouched.
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
  });

  it('leaves an uncancelled run exactly as it was before this Issue', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: first
    command: "sh -c 'exit 0'"
    timeoutSec: 30
  - id: second
    command: "sh -c 'exit 1'"
    timeoutSec: 30
options:
  baseRef: main
`);
    register(repo);

    const { runId } = await startVerification({
      worktreeId: WT_ID,
      worktreePath: repo,
      trigger: 'api',
    });
    await waitForVerification(runId);

    const run = getVerificationRun(db, runId);
    expect(run?.status).toBe('failed');
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'first',
      'second',
    ]);
    expect(run?.gates.find((gate) => gate.gateId === 'second')?.exitCode).toBe(1);
    // No cancel marker anywhere: the switch is inert until it is thrown.
    expect(run?.gates.some((gate) => (gate.logTail ?? '').includes(CANCELLED_SKIP_LOG))).toBe(
      false
    );
  });
});

describe('cancelling a run queued behind a mutex (Issue #2063)', () => {
  let heldLock: MachineLockHandle | null = null;

  afterEach(() => {
    heldLock?.release();
    heldLock = null;
  });

  it('releases the worktree instead of waiting out the gate timeout', async () => {
    // The lock root is redirected: `~/.commandmate/locks` is shared by every
    // checkout on the machine, so a suite using it would serialize against —
    // and be failed by — unrelated live runs.
    const lockRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gate-cancel-locks-')));
    tempDirs.push(lockRoot);
    vi.stubEnv(MACHINE_LOCK_ROOT_ENV, lockRoot);

    const held = await acquireMachineLock('cancel-2063-heavy', {
      timeoutMs: 0,
      root: lockRoot,
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    heldLock = held.handle;

    const repo = createRepo('version: 1\ngates: []\n');
    writeFileSync(
      join(repo, '.commandmate', 'verify.yaml'),
      `
version: 1
gates:
  - id: heavy
    command: "sh -c 'touch ${repo}/started; exit 0'"
    timeoutSec: 1800
    mutex: cancel-2063-heavy
options:
  baseRef: main
`
    );
    register(repo);

    const { runId } = await startVerification({
      worktreeId: WT_ID,
      worktreePath: repo,
      trigger: 'api',
    });

    // The gate's ROW is created before its evaluator is entered, so its
    // appearance is the signal that the run has reached the lock wait. Nothing
    // has been spawned — which is precisely why a kill-only cancel could not
    // reach this state.
    expect(
      await until(() => (getVerificationRun(db, runId)?.gates ?? []).some((g) => g.gateId === 'heavy'))
    ).toBe(true);
    expect(existsSync(join(repo, 'started'))).toBe(false);

    const startedAt = Date.now();
    const outcome = await cancelVerification(runId);
    const elapsedMs = Date.now() - startedAt;

    // `cancelled`, not `requested`: the run closed while the caller waited. The
    // gate declares 1800s, so anything that merely waited the lock out would
    // blow this budget by three orders of magnitude.
    expect(outcome).toEqual({ kind: 'cancelled', status: 'cancelled' });
    expect(elapsedMs).toBeLessThan(5000);

    const run = getVerificationRun(db, runId);
    // The row is closed, so `getRunningVerificationRun` stops refusing new runs
    // for this worktree — the state the endpoint exists to escape.
    expect(run?.status).toBe('cancelled');
    expect(run?.finishedAt).not.toBeNull();

    const gate = run?.gates.find((g) => g.gateId === 'heavy');
    expect(gate?.status).toBe('skipped');
    // An abandoned wait is not a resource conflict: naming the holder would
    // send the reader after a lock that had nothing to do with the outcome.
    expect(gate?.logTail).toContain(CANCELLED_SKIP_LOG);
    expect(gate?.logTail).not.toContain(SKIP_LOG_MARKERS.mutex);
    // The command never started: the lock was never taken, so nothing ran.
    expect(existsSync(join(repo, 'started'))).toBe(false);
    // Longer than `CANCEL_SETTLE_TIMEOUT_MS` (8s) on purpose. A runner that
    // cannot abandon the wait answers `requested` when that budget runs out,
    // and this test has to survive long enough to ASSERT that rather than die
    // on vitest's 5s default and report a timeout instead of the defect.
  }, 20_000);
});

describe('CANCELLED_SKIP_LOG is specific enough to classify by (Issue #2063)', () => {
  it('is the literal the runner writes', () => {
    // Pinned by value, like WORK_EVIDENCE_SKIP_LOG in
    // run-verdict-vocabulary-2062.test.ts. `classifySkipReason` matches on
    // `includes`, so a marker shortened to something generic would keep every
    // #2063 test green while silently swallowing its siblings — see below.
    expect(CANCELLED_SKIP_LOG).toBe('skipped: the verification run was cancelled.');
  });

  it('appears in no other skip log the product can produce', () => {
    // THE assertion. `PRIMARY_CHECKOUT_SKIP_LOG` and `WORK_EVIDENCE_SKIP_LOG`
    // both start with `skipped: `, so a marker weakened to that prefix makes
    // this list red — which is the failure a value-only pin cannot express.
    const otherProducers = [
      PRIMARY_CHECKOUT_SKIP_LOG,
      WORK_EVIDENCE_SKIP_LOG,
      SCOPE_SKIP_NO_CONTRACT,
      SCOPE_SKIP_NOT_REQUIRED,
      scopeSkipDetachedContract('task-1', 'succeeded'),
      `${SKIP_LOG_MARKERS.mutex} waited=3s`,
    ];
    for (const log of otherProducers) {
      expect(log).not.toContain(CANCELLED_SKIP_LOG);
      expect(classifySkipReason(log)).not.toBe('cancelled');
    }
  });
});
