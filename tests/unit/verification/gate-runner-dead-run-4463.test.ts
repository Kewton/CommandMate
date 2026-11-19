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
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  process.env.PATH = originalPath;
  (runner as { setRunGitTimeoutMsForTests?: (ms?: number) => void }).setRunGitTimeoutMsForTests?.();
  (scopeGate as { setScopeRunGitTimeoutMsForTests?: (ms?: number) => void }).setScopeRunGitTimeoutMsForTests?.();
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
    'closes as timeout a grace after the kill, and the run as failed (not passed)',
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
      expect(run?.status).toBe('failed');
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
    },
    TEST_TIMEOUT_MS
  );

  it('keeps a limit by default, the same as the runner’s', () => {
    expect((scopeGate as { SCOPE_RUN_GIT_TIMEOUT_MS?: number }).SCOPE_RUN_GIT_TIMEOUT_MS).toBe(runner.RUN_GIT_TIMEOUT_MS);
  });
});
