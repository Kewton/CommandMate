/**
 * #4494 F3: the write that closes a run fails, and the row must still end.
 *
 * `startVerification`'s background work closes the row with its verdict, and on a throw closes it
 * `error` once more. When that second write threw too, the row stayed `running` for as long as the
 * server lived, and every later verify of the worktree was refused as `already in progress`.
 *
 * - I1: however many writes fail, the row ends (`error`, or the real verdict) in bounded time and
 *       the next verify of the worktree gets in without a restart.
 * - I2: a run whose verdict could not be written is never recorded as passed — not on the row,
 *       not on its task.
 * - I3: a run whose writes succeed is unchanged (the rest of tests/unit/verification pins it).
 * - I4: a row that is gone (worktree deleted mid-run) is left alone: the retry is bounded and
 *       nothing is thrown or rejected.
 *
 * Write failures are real SQLite errors, raised by a TEMP trigger on `verification_runs` that a
 * test-controlled function arms, so the code under test runs against an unmodified database API.
 *
 * Plus the positive control of the double fork (T4): a gate's child moves to its own session and
 * forks a grandchild that inherits the gate's stdout, then exits. The #4463 grace still ends it.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, getTask, getVerificationRun, upsertWorktree } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import * as runner from '@/lib/verification/gate-runner';
import { MACHINE_LOCK_ROOT_ENV } from '@/lib/verification/machine-lock';
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

vi.mock('@/lib/logger', () => {
  const g = globalThis as { __t4494Logs?: { event: string; data: Record<string, unknown> }[] };
  const LOGS = (g.__t4494Logs ??= []);
  const push = (event: string, data?: unknown) => LOGS.push({ event, data: (data ?? {}) as Record<string, unknown> });
  const logger = { warn: push, info: () => {}, error: push, debug: () => {}, withContext: () => logger };
  return { createLogger: () => logger };
});
const logs = (): { event: string; data: Record<string, unknown> }[] =>
  ((globalThis as { __t4494Logs?: { event: string; data: Record<string, unknown> }[] }).__t4494Logs ??= []);

/** The status every failure notification was raised with (r1 F-4: named, not inferred). */
vi.mock('@/lib/push/failure-push-notifier', () => {
  const g = globalThis as { __t4494Pushes?: { runId: number; status: string }[] };
  const PUSHES = (g.__t4494Pushes ??= []);
  return {
    notifyVerificationFailurePush: async (input: { runId: number; status: string }) => {
      PUSHES.push({ runId: input.runId, status: input.status });
    },
  };
});
const pushes = (): { runId: number; status: string }[] =>
  ((globalThis as { __t4494Pushes?: { runId: number; status: string }[] }).__t4494Pushes ??= []);

/** Test seams added by r1 (F-1). Called optionally so the red before the fix is about behaviour. */
type LateCloseSeams = {
  setRunLateCloseDelaysMsForTests?: (delays?: readonly number[]) => void;
  resetUnclosedRunsForTests?: () => void;
};
const seams = runner as unknown as LateCloseSeams;

function taskEvents(taskId: string): string[] {
  return (
    db.prepare('SELECT event FROM task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as { event: string }[]
  ).map((row) => row.event);
}

/** Poll the run row until `predicate` holds or `ms` passes; the last status seen. */
async function pollRunStatus(runId: number, predicate: (status: string | undefined) => boolean, ms: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  let status = getVerificationRun(db, runId)?.status;
  while (!predicate(status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    status = getVerificationRun(db, runId)?.status;
  }
  return status;
}

function contractTask(worktreeId: string): string {
  return createTask(db, {
    worktreeId,
    cliToolId: 'claude',
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1\ntitle: ${worktreeId}\ngoal: do the work\nscope:\n  allow: ["**"]\nsuccess:\n  requireWorkEvidence: false\n  requireScopeClean: false\n`,
      'task.yaml'
    ),
    status: 'running',
  }).id;
}

/** How long a test waits for the run to close before calling it stuck. */
const SETTLE_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

let db: Database.Database;
const tempDirs: string[] = [];
const pidFiles: string[] = [];

/** Every status a write of the run row tried to set, in order (failed attempts included). */
let attempts: string[] = [];
/** Decides, per attempt, whether the write fails. */
let failWrite: (status: string, attempt: number) => boolean = () => false;

function armWriteFailures(): void {
  db.function('t4494_fail', (status: unknown) => {
    attempts.push(String(status));
    return failWrite(String(status), attempts.length) ? 1 : 0;
  });
  db.exec(`
    CREATE TEMP TRIGGER t4494_fail_run_close
    BEFORE UPDATE OF status ON verification_runs
    WHEN t4494_fail(NEW.status) = 1
    BEGIN
      SELECT RAISE(ABORT, 't4494: injected write failure');
    END;
  `);
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(verifyYaml: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-runner-4494-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate-runner@example.test'], dir);
  git(['config', 'user.name', 'Gate Runner'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'work'], dir);
  return dir;
}

const PASSING_YAML = `
version: 1
gates:
  - id: ok
    command: "true"
options:
  baseRef: main
`;

const FAILING_YAML = `
version: 1
gates:
  - id: red
    command: "false"
options:
  baseRef: main
`;

function register(id: string, path: string): void {
  upsertWorktree(db, { id, name: `feature/${id}`, path, repositoryPath: path, repositoryName: 'fixture' });
}

async function settleWithin<T>(promise: Promise<T>, ms = SETTLE_BOUND_MS): Promise<{ value: T | undefined; settled: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    promise.then((value) => ({ value, settled: true })),
    new Promise<{ value: undefined; settled: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ value: undefined, settled: false }), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

async function runWithin(
  id: string,
  path: string,
  extra: { taskId?: string; gateIds?: string[] } = {}
): Promise<{ runId: number; settled: boolean; status: string | null | undefined }> {
  const { runId } = await runner.startVerification({ worktreeId: id, worktreePath: path, trigger: 'api', ...extra });
  const { value, settled } = await settleWithin(runner.waitForVerification(runId));
  return { runId, settled, status: value };
}

beforeEach(async () => {
  const lockRoot = realpathSync(mkdtempSync(join(tmpdir(), 'locks-4494-')));
  tempDirs.push(lockRoot);
  vi.stubEnv(MACHINE_LOCK_ROOT_ENV, lockRoot);
  db = new Database(':memory:');
  runMigrations(db);
  attempts = [];
  failWrite = () => false;
  logs().splice(0);
  pushes().splice(0);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  seams.resetUnclosedRunsForTests?.();
  seams.setRunLateCloseDelaysMsForTests?.();
  vi.unstubAllEnvs();
  for (const file of pidFiles.splice(0)) {
    try {
      process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
    } catch {
      // Already gone, or never written.
    }
  }
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('#4494 F3: the close write fails', () => {
  it('pins the retry bound as constants (I4)', () => {
    expect(runner.RUN_CLOSE_MAX_ATTEMPTS).toBe(5);
    expect(runner.RUN_CLOSE_RETRY_DELAY_MS).toBe(200);
  });

  it(
    'T1: both writes the old code made throw — the row still ends error and the next verify gets in (I1)',
    async () => {
      const repo = createRepo(PASSING_YAML);
      register('wt-t1', repo);
      armWriteFailures();
      // The verdict write and the `error` write after it both fail; the database recovers after.
      failWrite = (_status, n) => n <= 2;

      const first = await runWithin('wt-t1', repo);

      expect(first.settled).toBe(true);
      expect(first.status).toBe('error');
      expect(attempts[0]).toBe('passed');
      expect(getVerificationRun(db, first.runId)?.status).toBe('error');

      failWrite = () => false;
      const second = await runWithin('wt-t1', repo);
      expect(second.settled).toBe(true);
      expect(second.status).toBe('passed');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'T1b: every bounded attempt fails — the row is closed by the next verify of the worktree, without a restart (I1)',
    async () => {
      const repo = createRepo(PASSING_YAML);
      register('wt-t1b', repo);
      armWriteFailures();
      failWrite = () => true;

      const startedAt = Date.now();
      const first = await runWithin('wt-t1b', repo);

      expect(first.settled).toBe(true);
      expect(first.status).toBe('error');
      // Bounded: the verdict write plus the retries, never more.
      expect(attempts.length).toBe(runner.RUN_CLOSE_MAX_ATTEMPTS);
      expect(attempts.slice(1).every((s) => s === 'error')).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(SETTLE_BOUND_MS);
      expect(getVerificationRun(db, first.runId)?.status).toBe('running');

      // The database recovers; the next verify closes the stranded row before it looks for one.
      failWrite = () => false;
      const second = await runWithin('wt-t1b', repo);
      expect(second.runId).not.toBe(first.runId);
      expect(second.status).toBe('passed');
      expect(getVerificationRun(db, first.runId)?.status).toBe('error');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'T2: a failed run whose first write throws is recorded error, not passed (I2)',
    async () => {
      const repo = createRepo(FAILING_YAML);
      register('wt-t2', repo);
      armWriteFailures();
      failWrite = (_status, n) => n === 1;

      const run = await runWithin('wt-t2', repo);

      expect(run.settled).toBe(true);
      expect(attempts[0]).toBe('failed');
      expect(getVerificationRun(db, run.runId)?.status).toBe('error');
      expect(run.status).toBe('error');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'T2b: a passed run whose verdict write throws does not move its task to succeeded (I2)',
    async () => {
      const repo = createRepo(PASSING_YAML);
      register('wt-t2b', repo);
      const task = { id: contractTask('wt-t2b') };
      armWriteFailures();
      failWrite = (_status, n) => n === 1;

      const run = await runWithin('wt-t2b', repo, { taskId: task.id, gateIds: ['ok'] });

      expect(run.settled).toBe(true);
      expect(attempts[0]).toBe('passed');
      expect(getVerificationRun(db, run.runId)?.status).toBe('error');
      expect(getTask(db, task.id)?.status).not.toBe('succeeded');
      // r1 F-4: the task and the notification hear `error`, as the row says — named, not inferred.
      expect(taskEvents(task.id)).toEqual(['verify_started', 'verify_failed']);
      expect(getTask(db, task.id)?.status).toBe('failed');
      expect(pushes()).toEqual([{ runId: run.runId, status: 'error' }]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'T3: a row deleted mid-run is left alone — no retry loop, no throw, no stranded entry (I4)',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: slow
    command: "sleep 1"
options:
  baseRef: main
`);
      register('wt-t3', repo);
      armWriteFailures();

      const { runId } = await runner.startVerification({ worktreeId: 'wt-t3', worktreePath: repo, trigger: 'api' });
      db.prepare('DELETE FROM verification_runs WHERE id = ?').run(runId);
      const startedAt = Date.now();
      const { value, settled } = await settleWithin(runner.waitForVerification(runId));

      expect(settled).toBe(true);
      expect(value).toBe('error');
      // A missing row is not retried: no write ever matched a row, so the trigger never fired.
      expect(attempts).toEqual([]);
      expect(Date.now() - startedAt).toBeLessThan(
        5_000 + runner.RUN_CLOSE_MAX_ATTEMPTS * runner.RUN_CLOSE_RETRY_DELAY_MS
      );
      expect(getVerificationRun(db, runId)).toBeNull();
      expect(runner.getUnclosedRunIdsForTests()).not.toContain(runId);

      // The next verify is not held up by anything left behind.
      const next = await runWithin('wt-t3', repo);
      expect(next.status).toBe('passed');
    },
    TEST_TIMEOUT_MS
  );

  it('pins the late-close backoff as constants (r1 F-1)', () => {
    const delays = (runner as unknown as { RUN_LATE_CLOSE_DELAYS_MS?: readonly number[] }).RUN_LATE_CLOSE_DELAYS_MS;
    expect(delays).toEqual([5_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it(
    'T1c (r1 F-1): a row left open past the bound is closed by a timer, without another verify (I1)',
    async () => {
      seams.setRunLateCloseDelaysMsForTests?.([50, 50, 50]);
      const repo = createRepo(PASSING_YAML);
      register('wt-t1c', repo);
      armWriteFailures();
      failWrite = () => true;

      const first = await runWithin('wt-t1c', repo);
      expect(first.status).toBe('error');
      expect(getVerificationRun(db, first.runId)?.status).toBe('running');

      // The database recovers. No startVerification follows: only the timer can close the row.
      failWrite = () => false;
      const status = await pollRunStatus(first.runId, (s) => s !== 'running', 3_000);

      expect(status).toBe('error');
      expect(attempts.slice(runner.RUN_CLOSE_MAX_ATTEMPTS)).toEqual(['error']);
      expect(seams.resetUnclosedRunsForTests).toBeTypeOf('function');
      expect(runner.getUnclosedRunIdsForTests()).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'T1d (r1 F-1): the late close is bounded — one write per delay, then it stops; the next verify still closes the row',
    async () => {
      seams.setRunLateCloseDelaysMsForTests?.([20, 20, 20]);
      const repo = createRepo(PASSING_YAML);
      register('wt-t1d', repo);
      armWriteFailures();
      failWrite = () => true;

      const first = await runWithin('wt-t1d', repo);
      expect(first.status).toBe('error');
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(attempts.length).toBe(runner.RUN_CLOSE_MAX_ATTEMPTS + 3);
      expect(attempts.every((s, i) => i === 0 || s === 'error')).toBe(true);
      expect(getVerificationRun(db, first.runId)?.status).toBe('running');
      expect(runner.getUnclosedRunIdsForTests()).toEqual([first.runId]);

      failWrite = () => false;
      const second = await runWithin('wt-t1d', repo);
      expect(second.status).toBe('passed');
      expect(getVerificationRun(db, first.runId)?.status).toBe('error');
    },
    TEST_TIMEOUT_MS
  );

  it(
    'T1e (r1 F-1): a remembered row that is gone stops the late close (I4)',
    async () => {
      seams.setRunLateCloseDelaysMsForTests?.([50, 50, 50]);
      const repo = createRepo(PASSING_YAML);
      register('wt-t1e', repo);
      armWriteFailures();
      failWrite = () => true;

      const first = await runWithin('wt-t1e', repo);
      db.prepare('DELETE FROM verification_runs WHERE id = ?').run(first.runId);
      const before = attempts.length;
      await new Promise((resolve) => setTimeout(resolve, 400));

      // A missing row matches no UPDATE, so the trigger never fires: nothing was written.
      expect(attempts.length).toBe(before);
      expect(runner.getUnclosedRunIdsForTests()).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'cancel path (r1 F-4): the `cancelled` write throws — the row ends error, the task is not cancelled or passed',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: slow
    command: "sleep 30"
options:
  baseRef: main
`);
      register('wt-cancel', repo);
      const taskId = contractTask('wt-cancel');
      armWriteFailures();
      failWrite = (status) => status === 'cancelled';

      const { runId } = await runner.startVerification({
        worktreeId: 'wt-cancel',
        worktreePath: repo,
        trigger: 'api',
        taskId,
        gateIds: ['slow'],
      });
      const deadline = Date.now() + 10_000;
      while (!getVerificationRun(db, runId)?.gates.some((g) => g.gateId === 'slow') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const completion = runner.waitForVerification(runId);
      await runner.cancelVerification(runId);
      const { value, settled } = await settleWithin(completion);

      expect(settled).toBe(true);
      expect(attempts[0]).toBe('cancelled');
      expect(value).toBe('error');
      expect(getVerificationRun(db, runId)?.status).toBe('error');
      expect(taskEvents(taskId)).toEqual(['verify_started', 'verify_failed']);
      expect(getTask(db, taskId)?.status).toBe('failed');
      expect(pushes()).toEqual([{ runId, status: 'error' }]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'config path (r1 F-4): an unusable config whose close write throws — startVerification resolves and the row ends error',
    async () => {
      const repo = createRepo(PASSING_YAML);
      execFileSync('git', ['rm', '-q', '.commandmate/verify.yaml'], { cwd: repo });
      register('wt-config', repo);
      const taskId = contractTask('wt-config');
      armWriteFailures();
      failWrite = (_status, n) => n === 1;

      const { runId } = await runner.startVerification({ worktreeId: 'wt-config', worktreePath: repo, trigger: 'api', taskId });
      const status = await pollRunStatus(runId, (s) => s !== 'running', 5_000);

      expect(status).toBe('error');
      expect(attempts).toEqual(['error', 'error']);
      expect(taskEvents(taskId)).toEqual(['verify_started', 'verify_failed']);
      expect(pushes()).toEqual([{ runId, status: 'error' }]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'negative control (I3): writes that succeed record the verdict as before, with one write each',
    async () => {
      const passRepo = createRepo(PASSING_YAML);
      const failRepo = createRepo(FAILING_YAML);
      register('wt-ok', passRepo);
      register('wt-red', failRepo);
      armWriteFailures();

      const pass = await runWithin('wt-ok', passRepo);
      const fail = await runWithin('wt-red', failRepo);

      expect(pass.status).toBe('passed');
      expect(getVerificationRun(db, pass.runId)?.status).toBe('passed');
      expect(fail.status).toBe('failed');
      expect(getVerificationRun(db, fail.runId)?.status).toBe('failed');
      expect(attempts).toEqual(['passed', 'failed']);
      expect(logs().some((l) => l.event === 'verification-run-close-failed')).toBe(false);
    },
    TEST_TIMEOUT_MS
  );
});

describe('#4494 T4 (positive control): a double-forked grandchild holds the gate stdout', () => {
  it(
    'closes as timeout a grace after the kill, and the run ends (not running, not passed)',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: doublefork
    command: "node fork1.js grandchild.pid; sleep 120"
    timeoutSec: 2
options:
  baseRef: main
`);
      // The gate's child moves to a session of its own (detached = setsid), forks the grandchild
      // with the gate's stdout, and exits at once. The grandchild is in another session and
      // another process group from the gate.
      writeFileSync(
        join(repo, 'fork1.js'),
        [
          "const { spawn } = require('child_process');",
          "const c = spawn(process.execPath, ['fork2.js', process.argv[2]], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
          'c.unref();',
        ].join('\n')
      );
      writeFileSync(
        join(repo, 'fork2.js'),
        [
          "const { spawn } = require('child_process');",
          "const g = spawn('sleep', ['120'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
          "require('fs').writeFileSync(process.argv[2], String(g.pid));",
          'g.unref();',
          'process.exit(0);',
        ].join('\n')
      );
      pidFiles.push(join(repo, 'grandchild.pid'));
      register('wt-doublefork', repo);

      const { runId } = await runner.startVerification({ worktreeId: 'wt-doublefork', worktreePath: repo, trigger: 'api' });
      // r1 F-4: the pipe holder really exists, and is alive before the timeout is waited for.
      const pidFile = join(repo, 'grandchild.pid');
      const deadline = Date.now() + 10_000;
      const pidWritten = (): boolean => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0;
      while (!pidWritten() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pidWritten()).toBe(true);
      expect(getVerificationRun(db, runId)?.status).toBe('running');
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(grandchild, 0)).not.toThrow();

      const { settled } = await settleWithin(runner.waitForVerification(runId));

      expect(settled).toBe(true);
      // It outlived the timeout's kill (only afterEach kills it).
      expect(() => process.kill(grandchild, 0)).not.toThrow();
      const run = getVerificationRun(db, runId);
      const gate = run?.gates.find((g) => g.gateId === 'doublefork');
      expect(gate?.status).toBe('timeout');
      expect(gate?.logTail ?? '').toMatch(/pipes still held/);
      expect(run?.status).toBe('error');
    },
    TEST_TIMEOUT_MS
  );
});
