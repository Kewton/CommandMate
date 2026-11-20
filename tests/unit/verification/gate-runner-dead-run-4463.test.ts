/**
 * #4463 (the minimal part of #4494): a run whose execution died while the server lives on still
 * closes its row, so wait-verify's busy wait never has to fall back on its cap for these.
 *
 * F1 — a gate leaves a descendant in another process group holding its stdout. The timeout's kill
 *      reaches only the gate's group, so `close` never came and the run stayed `running`. Now the
 *      pipes are let go a grace after the kill and the gate closes as `timeout`.
 * F2 — `git` never returns. runGit had no time limit; now it gives up and the work-evidence gate
 *      closes as an error.
 *
 * The grace acts only after a kill: a live gate is never ended before its timeoutSec (I1), and a
 * gate ended this way is never a pass (I3). Real processes and real repositories, under
 * os.tmpdir(); every escaped process is killed afterwards.
 *
 * Review 2 (codex) / PM (pm-reply-4463-stop.md):
 * - a git that does not return is no verdict: the run closes `error` (exit 99) on both the
 *   work-evidence and the scope path, never `failed` (exit 20).
 * - a gate whose descendants outlived the kill cannot be confirmed gone: the run closes `error`,
 *   and the gate's mutex is held until the descendants are gone (bounded; past the bound it is
 *   recorded and released), so the next gate on that mutex never runs beside them.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, getVerificationRun, upsertWorktree } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import * as runner from '@/lib/verification/gate-runner';
import * as scopeGate from '@/lib/verification/scope-gate';
import { acquireMachineLock, MACHINE_LOCK_ROOT_ENV } from '@/lib/verification/machine-lock';
import { exitCodeForRunStatus } from '@/cli/utils/verify-runner';
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

/** What the runner wrote to its log (warn/error), so the release record can be checked. */
vi.mock('@/lib/logger', () => {
  const g = globalThis as { __t4463Logs?: { event: string; data: Record<string, unknown> }[] };
  const LOGS = (g.__t4463Logs ??= []);
  const push = (event: string, data?: unknown) => LOGS.push({ event, data: (data ?? {}) as Record<string, unknown> });
  const logger = { warn: push, info: () => {}, error: push, debug: () => {}, withContext: () => logger };
  return { createLogger: () => logger };
});
const logs = (): { event: string; data: Record<string, unknown> }[] =>
  ((globalThis as { __t4463Logs?: { event: string; data: Record<string, unknown> }[] }).__t4463Logs ??= []);

/** How long a test waits for the run to close before calling it stuck. */
const SETTLE_BOUND_MS = 40_000;
const TEST_TIMEOUT_MS = 90_000;

let db: Database.Database;
const tempDirs: string[] = [];
const pidFiles: string[] = [];
const originalPath = process.env.PATH;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(verifyYaml: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-runner-4463-')));
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
  return dir;
}

function register(id: string, path: string): void {
  upsertWorktree(db, { id, name: `feature/${id}`, path, repositoryPath: path, repositoryName: 'fixture' });
}

/** Start a run; resolve with its id once it closed, or with null after SETTLE_BOUND_MS. */
async function runWithin(
  id: string,
  path: string,
  extra: { taskId?: string; gateIds?: string[] } = {}
): Promise<{ runId: number; settled: boolean }> {
  const { runId } = await runner.startVerification({ worktreeId: id, worktreePath: path, trigger: 'api', ...extra });
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    runner.waitForVerification(runId).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), SETTLE_BOUND_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { runId, settled };
}

beforeEach(async () => {
  const lockRoot = realpathSync(mkdtempSync(join(tmpdir(), 'locks-4463-')));
  tempDirs.push(lockRoot);
  vi.stubEnv(MACHINE_LOCK_ROOT_ENV, lockRoot);
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  process.env.PATH = originalPath;
  (runner as { setRunGitTimeoutMsForTests?: (ms?: number) => void }).setRunGitTimeoutMsForTests?.();
  (scopeGate as { setScopeRunGitTimeoutMsForTests?: (ms?: number) => void }).setScopeRunGitTimeoutMsForTests?.();
  (runner as { setOrphanMutexHoldMsForTests?: (ms?: number) => void }).setOrphanMutexHoldMsForTests?.();
  vi.unstubAllEnvs();
  for (const file of pidFiles.splice(0)) {
    try {
      process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('#4463 F1: a gate whose descendant keeps the pipes open after the kill', () => {
  it(
    'closes as timeout a grace after the kill, and the run as error (exit 99, not passed)',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: escapes
    command: "node escape.js escaped.pid; sleep 120"
    timeoutSec: 1
options:
  baseRef: main
`);
      // A descendant in its own process group (detached = setsid) that inherits the gate's stdout.
      writeFileSync(
        join(repo, 'escape.js'),
        [
          "const { spawn } = require('child_process');",
          "const c = spawn('sleep', ['120'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
          "require('fs').writeFileSync(process.argv[2], String(c.pid));",
          'c.unref();',
        ].join('\n')
      );
      pidFiles.push(join(repo, 'escaped.pid'));
      register('wt-escape', repo);

      const { runId, settled } = await runWithin('wt-escape', repo);

      expect(existsSync(join(repo, 'escaped.pid'))).toBe(true);
      expect(settled).toBe(true);
      const run = getVerificationRun(db, runId);
      const gate = run?.gates.find((g) => g.gateId === 'escapes');
      expect(gate?.status).toBe('timeout');
      expect(gate?.exitCode).toBeNull();
      expect(gate?.logTail ?? '').toMatch(/pipes still held/);
      // Review 2 P2 / PM: the descendants could not be confirmed gone, so no verdict (exit 99).
      expect(run?.status).toBe('error');
      expect(exitCodeForRunStatus(run!.status)).toBe(99);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'negative control (I1): a live gate is not ended before its timeoutSec',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: slow-but-alive
    command: "sleep 4; exit 0"
    timeoutSec: 60
options:
  baseRef: main
`);
      register('wt-alive', repo);

      const { runId, settled } = await runWithin('wt-alive', repo);

      expect(settled).toBe(true);
      const run = getVerificationRun(db, runId);
      const gate = run?.gates.find((g) => g.gateId === 'slow-but-alive');
      expect(gate?.status).toBe('passed');
      expect(gate?.durationMs ?? 0).toBeGreaterThanOrEqual(4000);
      expect(run?.status).toBe('passed');
    },
    TEST_TIMEOUT_MS
  );
});

describe('#4463 F2: git never returns', () => {
  it(
    'runGit gives up at its limit and the run closes (not passed)',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: never-reached
    command: "touch reached"
    timeoutSec: 30
options:
  baseRef: main
`);
      register('wt-git-hangs', repo);
      const bin = realpathSync(mkdtempSync(join(tmpdir(), 'fake-git-4463-')));
      tempDirs.push(bin);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 120\n');
      chmodSync(join(bin, 'git'), 0o755);
      process.env.PATH = `${bin}:${originalPath}`;
      (runner as { setRunGitTimeoutMsForTests?: (ms?: number) => void }).setRunGitTimeoutMsForTests?.(1000);

      const { runId, settled } = await runWithin('wt-git-hangs', repo);

      expect(settled).toBe(true);
      const run = getVerificationRun(db, runId);
      expect(run?.status).not.toBe('running');
      expect(run?.status).not.toBe('passed');
      const evidence = run?.gates.find((g) => g.gateId === runner.WORK_EVIDENCE_GATE_ID);
      expect(evidence?.status).toBe('error');
      expect(run?.status).toBe('error');
      expect(exitCodeForRunStatus(run!.status)).toBe(99);
    },
    TEST_TIMEOUT_MS
  );

  it('keeps a limit by default, well above any real git call', () => {
    expect(runner.RUN_GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

/** The real git, found before a test puts a fake one first on PATH. */
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/**
 * A fake `git` first on PATH: the listed subcommands go to the real git, every other one never
 * returns. Both runners' limits are shortened to 1 s.
 */
function gitThatHangsExcept(passing: string[]): void {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'fake-git-4463-')));
  tempDirs.push(bin);
  const cases = passing.map((sub) => `  ${sub}) exec "${REAL_GIT}" "$@" ;;`).join('\n');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in\n${cases}\n  *) exec sleep 120 ;;\nesac\n`);
  chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  (runner as { setRunGitTimeoutMsForTests?: (ms?: number) => void }).setRunGitTimeoutMsForTests?.(1000);
  (scopeGate as { setScopeRunGitTimeoutMsForTests?: (ms?: number) => void }).setScopeRunGitTimeoutMsForTests?.(1000);
}

describe('#4463 F2 (review 1 P1-1): scope-gate.ts runGit has the same limit', () => {
  it(
    'work-evidence: merge-base and rev-list return, the later `git log` (scope-gate) does not → the run closes, not passed',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: never-reached
    command: "touch reached"
    timeoutSec: 30
options:
  baseRef: main
`);
      register('wt-log-hangs', repo);
      gitThatHangsExcept(['merge-base', 'rev-list']);

      const { runId, settled } = await runWithin('wt-log-hangs', repo);

      expect(settled).toBe(true);
      const run = getVerificationRun(db, runId);
      expect(run?.status).not.toBe('running');
      expect(run?.status).not.toBe('passed');
      const evidence = run?.gates.find((g) => g.gateId === runner.WORK_EVIDENCE_GATE_ID);
      expect(evidence?.status).toBe('error');
      expect(run?.status).toBe('error');
      expect(exitCodeForRunStatus(run!.status)).toBe(99);
      expect(existsSync(join(repo, 'reached'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'a scope-only run: its first git (scope-gate merge-base) does not return → the scope gate errors and the run closes',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: never-reached
    command: "touch reached"
    timeoutSec: 30
options:
  baseRef: main
`);
      register('wt-scope-hangs', repo);
      const task = createTask(db, {
        worktreeId: 'wt-scope-hangs',
        cliToolId: 'claude',
        contractPath: '.commandmate/tasks/t.yaml',
        contract: parseTaskContract(
          // work-evidence off: the scope gate's merge-base is the run's first git call.
          'version: 1\ntitle: scope run\ngoal: do the work\nscope:\n  allow: ["**"]\nsuccess:\n  requireWorkEvidence: false\n',
          'task.yaml'
        ),
        status: 'running',
      });
      gitThatHangsExcept([]);

      const { runId, settled } = await runWithin('wt-scope-hangs', repo, { taskId: task.id, gateIds: [runner.SCOPE_GATE_ID] });

      expect(settled).toBe(true);
      const run = getVerificationRun(db, runId);
      expect(run?.status).not.toBe('running');
      expect(run?.status).not.toBe('passed');
      expect(run?.gates.find((g) => g.gateId === runner.WORK_EVIDENCE_GATE_ID)?.status).not.toBe('error');
      const scope = run?.gates.find((g) => g.gateId === runner.SCOPE_GATE_ID);
      expect(scope?.status).toBe('error');
      // Review 2 P1-3: a git timeout is no verdict on the scope path too — error / exit 99, not failed / 20.
      expect(run?.status).toBe('error');
      expect(exitCodeForRunStatus(run!.status)).toBe(99);
      // The gates after it were not run beside an unanswered git.
      expect(existsSync(join(repo, 'reached'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );

  it('keeps a limit by default, the same as the runner’s', () => {
    expect((scopeGate as { SCOPE_RUN_GIT_TIMEOUT_MS?: number }).SCOPE_RUN_GIT_TIMEOUT_MS).toBe(runner.RUN_GIT_TIMEOUT_MS);
  });
});

/** Whether `name` can be taken now (taken and released at once), within `ms`. */
async function lockFree(name: string, ms = 500): Promise<boolean> {
  const lock = await acquireMachineLock(name, { timeoutMs: ms });
  if (lock.acquired) lock.handle.release();
  return lock.acquired;
}

/** A gate on mutex `name` whose descendant (pid in `pidFile`) escapes the kill holding its stdout for `sec`. */
function escapingMutexRepo(name: string, sec: number): { repo: string; pidFile: string } {
  const repo = createRepo(`
version: 1
gates:
  - id: escapes
    command: "node escape.js escaped.pid; sleep 120"
    timeoutSec: 1
    mutex: ${name}
options:
  baseRef: main
`);
  writeFileSync(
    join(repo, 'escape.js'),
    [
      "const { spawn } = require('child_process');",
      `const c = spawn('sleep', ['${sec}'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
      "require('fs').writeFileSync(process.argv[2], String(c.pid));",
      'c.unref();',
    ].join('\n')
  );
  const pidFile = join(repo, 'escaped.pid');
  pidFiles.push(pidFile);
  return { repo, pidFile };
}

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('#4463 review 2 P2: the mutex is not handed on while a released gate\'s descendants live', () => {
  it(
    'holds the mutex while the escaped descendant lives, and hands it on once it is gone',
    async () => {
      const name = `t4463-hold-${process.pid}`;
      const { repo, pidFile } = escapingMutexRepo(name, 120);
      register('wt-mutex-hold', repo);

      const { runId, settled } = await runWithin('wt-mutex-hold', repo);

      expect(settled).toBe(true);
      expect(getVerificationRun(db, runId)?.status).toBe('error');
      // The run is closed, but its descendant still runs: the next gate on the mutex must wait.
      expect(await lockFree(name)).toBe(false);
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      expect(await until(() => lockFree(name), 15_000)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'past the hold limit, the mutex is recorded and handed on even with the descendant alive',
    async () => {
      const name = `t4463-bound-${process.pid}`;
      const { repo } = escapingMutexRepo(name, 120);
      register('wt-mutex-bound', repo);
      (runner as { setOrphanMutexHoldMsForTests?: (ms?: number) => void }).setOrphanMutexHoldMsForTests?.(3000);

      logs().length = 0;
      const { runId, settled } = await runWithin('wt-mutex-bound', repo);

      expect(settled).toBe(true);
      expect(await until(() => lockFree(name), 15_000)).toBe(true);
      // impl-2/impl-3 P3-2: the release past the limit is recorded, naming the run it came from.
      const record = logs().find((l) => l.event === 'verification-mutex-released-with-orphan');
      expect(record?.data).toMatchObject({ runId, worktreeId: 'wt-mutex-bound', gateId: 'escapes', mutex: name });
    },
    TEST_TIMEOUT_MS
  );

  it(
    'negative control: a gate killed with nothing escaping hands the mutex on at once, and the run is failed (a verdict)',
    async () => {
      const name = `t4463-plain-${process.pid}`;
      const repo = createRepo(`
version: 1
gates:
  - id: slow
    command: "sleep 30"
    timeoutSec: 1
    mutex: ${name}
options:
  baseRef: main
`);
      register('wt-mutex-plain', repo);

      const { runId, settled } = await runWithin('wt-mutex-plain', repo);

      expect(settled).toBe(true);
      expect(getVerificationRun(db, runId)?.status).toBe('failed');
      expect(await lockFree(name)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  it('keeps a hold limit by default', () => {
    expect((runner as { ORPHAN_MUTEX_HOLD_MS?: number }).ORPHAN_MUTEX_HOLD_MS).toBe(1_800_000);
  });
});

describe('#4463 impl-3 P3-1: a retry whose descendants outlive the kill leaves no verdict', () => {
  it(
    'first attempt fails, the retry leaves a descendant holding the pipes → run error (exit 99), the next gate not run',
    async () => {
      const repo = createRepo(`
version: 1
gates:
  - id: flaky
    command: "if [ -f attempt1 ]; then node escape.js escaped.pid; sleep 120; else touch attempt1; exit 1; fi"
    timeoutSec: 2
    retryOnFail: 1
  - id: after
    command: "touch reached"
    timeoutSec: 30
options:
  baseRef: main
`);
      writeFileSync(
        join(repo, 'escape.js'),
        [
          "const { spawn } = require('child_process');",
          "const c = spawn('sleep', ['120'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
          "require('fs').writeFileSync(process.argv[2], String(c.pid));",
          'c.unref();',
        ].join('\n')
      );
      pidFiles.push(join(repo, 'escaped.pid'));
      register('wt-retry-orphan', repo);

      const { runId, settled } = await runWithin('wt-retry-orphan', repo);

      expect(settled).toBe(true);
      expect(existsSync(join(repo, 'escaped.pid'))).toBe(true);
      const run = getVerificationRun(db, runId);
      expect(run?.status).toBe('error');
      expect(exitCodeForRunStatus(run!.status)).toBe(99);
      expect(existsSync(join(repo, 'reached'))).toBe(false);
    },
    TEST_TIMEOUT_MS
  );
});
