/**
 * Issue #4288 (Codex 5-2b P2-2): the unknown a lock could not observe — the observation point, the
 * path and the errno — reaches what the product shows, not only the library's return value.
 *
 *   - gate-runner.ts: a gate skipped for `mutex-wait` writes it into its log tail (the saved log and
 *     the API's gate result).
 *   - precheck.mjs: a heavy step left unrun writes it into its "not run" line.
 *
 * The unknown is a REAL one (no injection): a lock root that can be written and searched but not
 * listed (0333) answers EACCES at list-root, and the lock is never taken. Each test also shows the
 * library's `heldBy` alone does not carry the errno — what the display used to show.
 *
 * Lock roots, repositories and the database are under os.tmpdir() / in memory.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import { MUTEX_LOG_PREFIX, MUTEX_WAIT_SKIP_REASON, startVerification, waitForVerification } from '@/lib/verification/gate-runner';
import { MACHINE_LOCK_ROOT_ENV } from '@/lib/verification/machine-lock';
import { WORKTREE_INDEX_ROOT_ENV } from '@/lib/verification/worktree-index';
import {
  EXIT_HELD,
  HEAVY_MUTEX,
  HEAVY_TEST_FILES,
  HELD,
  acquireMachineLockSync,
  main,
} from '../../../scripts/orchestrate/precheck.mjs';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { guardTmpDirCount } from './tmp-leak-guard-4288';

// Every temp directory this file makes is removed (counted before and after: pr1af-impl-9).
guardTmpDirCount(["lock-unknown-display-4288-"]);

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

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
};
let db: Database.Database;
let lockRoot: string;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  lockRoot = tempDir('lock-unknown-display-4288-');
  vi.stubEnv(MACHINE_LOCK_ROOT_ENV, lockRoot);
  vi.stubEnv(WORKTREE_INDEX_ROOT_ENV, tempDir('lock-unknown-display-index-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // gone
    }
    removeTempDir(dir);
  }
});

const UNKNOWN_LINE = (root: string) => `unknown point=list-root path=${root} errno=EACCES`;

describe('gate-runner.ts: a mutex-wait skip names the unknown', () => {
  function createRepo(): string {
    const dir = tempDir('lock-unknown-display-repo-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'lock-4288@example.test');
    git('config', 'user.name', 'Lock 4288');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'README.md'), 'base\n');
    mkdirSync(join(dir, '.commandmate'), { recursive: true });
    writeFileSync(
      join(dir, '.commandmate', 'verify.yaml'),
      `version: 1
gates:
  - id: blocked
    command: "true"
    timeoutSec: 60
    mutexWaitSec: 1
    mutex: unlistable
options:
  baseRef: main
`,
    );
    git('add', '-A');
    git('commit', '-m', 'base');
    git('checkout', '-b', 'work');
    writeFileSync(join(dir, 'work.txt'), 'agent output\n');
    return dir;
  }

  it.skipIf(isRoot)('the log tail (saved and returned by the API) carries point, path and errno', async () => {
    const repo = createRepo();
    upsertWorktree(db, { id: 'wt-4288', name: 'feature/wt-4288', path: repo, repositoryPath: repo, repositoryName: 'fixture' });
    chmodSync(lockRoot, 0o333);
    const { runId } = await startVerification({ worktreeId: 'wt-4288', worktreePath: repo, trigger: 'api' });
    await waitForVerification(runId);
    chmodSync(lockRoot, 0o755);

    const gate = (getVerificationRun(db, runId)?.gates ?? []).find((g) => g.gateId === 'blocked');
    expect(gate?.status).toBe('skipped');
    expect(gate?.logTail?.split('\n')[0]).toContain(MUTEX_WAIT_SKIP_REASON);
    expect(gate?.logTail).toContain(`${MUTEX_LOG_PREFIX} ${UNKNOWN_LINE(lockRoot)}`);
    // What the held-by line alone says (the display before #4288's fix): a pending restore, no errno.
    const heldLine = gate?.logTail?.split('\n').find((l) => l.startsWith(`${MUTEX_LOG_PREFIX} name=`)) ?? '';
    expect(heldLine).not.toContain('errno=');
  }, 30000);

  it('negative: a lock held by a live holder writes no unknown line', async () => {
    const repo = createRepo();
    upsertWorktree(db, { id: 'wt-4288b', name: 'feature/wt-4288b', path: repo, repositoryPath: repo, repositoryName: 'fixture' });
    mkdirSync(join(lockRoot, 'unlistable.lock'));
    writeFileSync(join(lockRoot, 'unlistable.lock', 'owner'), JSON.stringify({ pid: process.pid, host: 'another-host.invalid', token: 'x', acquiredAt: 0 }));
    const { runId } = await startVerification({ worktreeId: 'wt-4288b', worktreePath: repo, trigger: 'api' });
    await waitForVerification(runId);
    const gate = (getVerificationRun(db, runId)?.gates ?? []).find((g) => g.gateId === 'blocked');
    expect(gate?.status).toBe('skipped');
    expect(gate?.logTail).toContain('held by pid');
    expect(gate?.logTail).not.toContain('unknown point=');
  }, 30000);
});

describe('precheck.mjs: a heavy step left unrun names the unknown', () => {
  const HEAD = 'a'.repeat(40);
  function harness(acquireHeavyLock: (timeoutMs: number) => ReturnType<typeof acquireMachineLockSync>) {
    const events: string[] = [];
    const tmp = tempDir('lock-unknown-display-precheck-');
    const changed = ['scripts/orchestrate/precheck.mjs'];
    const deps = {
      run: (command: string, args: string[]) => {
        if (command === 'git') {
          const sub = args.slice(2);
          if (sub[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
          if (sub[0] === 'status') return { status: 0, stdout: '', stderr: '' };
          if (sub.includes('--diff-filter=ACMR')) return { status: 0, stdout: changed.join('\n'), stderr: '' };
          if (sub.includes('--diff-filter=D')) return { status: 0, stdout: '', stderr: '' };
          if (sub.includes('--unified=0')) return { status: 0, stdout: '', stderr: '' };
          if (sub[0] === 'log' && sub.includes('--first-parent')) return { status: 0, stdout: `${HEAD} ${'f'.repeat(40)}\n`, stderr: '' };
          if (sub[0] === 'diff-tree') return { status: 0, stdout: `${changed[0]}\n`, stderr: '' };
          throw new Error(`unexpected git ${sub.join(' ')}`);
        }
        events.push(`run ${command} ${args.slice(0, 2).join(' ')}`);
        return { status: 0, stdout: '', stderr: '' };
      },
      findTestsNaming: () => Array.from({ length: HEAVY_TEST_FILES }, (_, i) => `tests/unit/many/t${i}.test.ts`),
      estimateRelatedTests: () => 0,
      acquireHeavyLock,
      home: tmp,
      now: () => new Date(Date.UTC(2026, 10, 9, 2, 0)),
      log: (line: string) => events.push(`log ${line}`),
      error: (line: string) => events.push(`error ${line}`),
    };
    const argv = ['--run-dir', join(tmp, 'runs', '2026-11-09'), '--issues', '4288', '--issue', '4288', '--worktree', '/wt'];
    return { deps, events, argv };
  }

  it.skipIf(isRoot)('the library\'s unknown reaches the "not run" line', () => {
    let library: ReturnType<typeof acquireMachineLockSync> | null = null;
    const h = harness(() => {
      chmodSync(lockRoot, 0o333);
      try {
        // precheck's own wrapper over machine-lock-sync.mjs, with no budget: one poll.
        library = acquireMachineLockSync(HEAVY_MUTEX, { root: lockRoot, timeoutMs: 0 });
      } finally {
        chmodSync(lockRoot, 0o755);
      }
      return library;
    });
    expect(main(h.argv, h.deps)).toBe(EXIT_HELD);
    const lib = library as unknown as { acquired: boolean; heldBy: string | null; unknown?: { point: string; path: string; code: string } };
    expect(lib.acquired).toBe(false);
    expect(lib.unknown).toEqual({ point: 'list-root', path: lockRoot, code: 'EACCES' });
    expect(lib.heldBy ?? '').not.toContain('errno=');
    const line = h.events.find((e) => e.includes(`tests ${HELD} (not run:`)) ?? '';
    expect(line).toContain(UNKNOWN_LINE(lockRoot));
  });

  it('negative: a holder that is simply alive adds no unknown', () => {
    const h = harness(() => ({ acquired: false, waitedMs: 1000, heldBy: 'pid 1 on elsewhere', release: () => {}, setOwnerFields: () => false, path: '' }) as ReturnType<typeof acquireMachineLockSync>);
    expect(main(h.argv, h.deps)).toBe(EXIT_HELD);
    const line = h.events.find((e) => e.includes(`tests ${HELD} (not run:`)) ?? '';
    expect(line).toContain('held by pid 1 on elsewhere for 1.0s');
    expect(line).not.toContain('unknown point=');
  });
});
