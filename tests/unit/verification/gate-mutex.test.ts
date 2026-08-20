/**
 * Per-worktree gate environment and gate-level mutexes (Issue #1771).
 *
 * Real processes and a real lock directory, for the same reason
 * `gate-runner.test.ts` does it: both properties under test — *the gate saw
 * these variables* and *these two gates did not overlap* — are properties of
 * process execution, and a mocked `spawn` would only assert that the mock was
 * called the way the test author imagined.
 *
 * The lock root and the index registry are redirected into `mkdtemp` for every
 * test. `~/.commandmate/locks` is shared by every checkout on the machine, so a
 * suite that used the real one would serialize against live verification runs
 * in other worktrees and fail for reasons unrelated to this code.
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
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import type { VerificationGateResult } from '@/lib/db';
import {
  MUTEX_LOG_PREFIX,
  MUTEX_WAIT_SKIP_REASON,
  startVerification,
  waitForVerification,
  WORKTREE_ID_ENV,
  WORKTREE_INDEX_ENV,
} from '@/lib/verification/gate-runner';
import {
  acquireMachineLock,
  MACHINE_LOCK_ROOT_ENV,
} from '@/lib/verification/machine-lock';
import {
  resolveWorktreeIndex,
  WORKTREE_INDEX_ROOT_ENV,
} from '@/lib/verification/worktree-index';
import { MUTEX_LOG_PREFIX as CLI_MUTEX_LOG_PREFIX } from '@/cli/utils/verify-runner';
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
let lockRoot: string;
let indexRoot: string;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repository whose `work` branch starts level with `main`, plus a verify.yaml. */
function createRepo(verifyYaml: string): string {
  const dir = tempDir('gate-mutex-');
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate-mutex@example.test'], dir);
  git(['config', 'user.name', 'Gate Mutex'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);

  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);

  // Something for work-evidence to find, so the command gates are reached.
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
  return dir;
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

/** Start a run without waiting, so two can be in flight at once. */
async function startRun(worktreeId: string, worktreePath: string): Promise<number> {
  const { runId } = await startVerification({ worktreeId, worktreePath, trigger: 'api' });
  return runId;
}

function waitedSecondsFrom(logTail: string | null): number | null {
  const match = /^\[mutex\] [^\n]*?\bwaited=([0-9]+(?:\.[0-9]+)?)s/m.exec(logTail ?? '');
  return match ? Number(match[1]) : null;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  lockRoot = tempDir('gate-mutex-locks-');
  indexRoot = tempDir('gate-mutex-index-');
  vi.stubEnv(MACHINE_LOCK_ROOT_ENV, lockRoot);
  vi.stubEnv(WORKTREE_INDEX_ROOT_ENV, indexRoot);
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

// =============================================================================
// Per-worktree environment
// =============================================================================

describe('gate environment (Issue #1771)', () => {
  const ECHO_ENV_CONFIG = `
version: 1
gates:
  - id: echo-env
    command: "sh -c 'printf \\"%s|%s\\" \\"$CM_WORKTREE_ID\\" \\"$CM_WORKTREE_INDEX\\" > env.txt'"
    timeoutSec: 30
options:
  baseRef: main
`;

  it('passes CM_WORKTREE_ID and CM_WORKTREE_INDEX to every command gate', async () => {
    const repo = createRepo(ECHO_ENV_CONFIG);
    registerWorktree('wt-env', repo);

    const runId = await runToCompletion('wt-env', repo);

    expect(gatesById(runId).get('echo-env')?.status).toBe('passed');
    const [id, index] = readFileSync(join(repo, 'env.txt'), 'utf8').split('|');
    expect(id).toBe('wt-env');
    // The registry is authoritative: the gate saw the number this worktree owns,
    // which is what makes `E2E_PORT=$((60400+CM_WORKTREE_INDEX))` collision-free.
    expect(index).toBe(String(resolveWorktreeIndex('wt-env', { root: indexRoot })));
  });

  it('gives two worktrees different indices and each its own id', async () => {
    const repoA = createRepo(ECHO_ENV_CONFIG);
    const repoB = createRepo(ECHO_ENV_CONFIG);
    registerWorktree('wt-a', repoA);
    registerWorktree('wt-b', repoB);

    await runToCompletion('wt-a', repoA);
    await runToCompletion('wt-b', repoB);

    const a = readFileSync(join(repoA, 'env.txt'), 'utf8').split('|');
    const b = readFileSync(join(repoB, 'env.txt'), 'utf8').split('|');
    expect(a[0]).toBe('wt-a');
    expect(b[0]).toBe('wt-b');
    // The whole point: two worktrees that run the same gate at the same time
    // must be able to derive two different ports from this number.
    expect(a[1]).not.toBe(b[1]);
  });

  it('names the variables the documented way', () => {
    // The spelling is the contract a repository's verify.yaml is written
    // against; renaming it silently would break every gate using it.
    expect(WORKTREE_ID_ENV).toBe('CM_WORKTREE_ID');
    expect(WORKTREE_INDEX_ENV).toBe('CM_WORKTREE_INDEX');
  });

  it('leaves the registry untouched when no command gate runs', async () => {
    // The claim writes into ~/.commandmate, which the env-clean gate lists. A
    // run that reaches no command gate must not create a directory the next
    // env-clean would report as the delegation's own pollution.
    const repo = createRepo(ECHO_ENV_CONFIG);
    registerWorktree('wt-no-work', repo);
    // No uncommitted work: work-evidence fails and the command gates are skipped.
    execFileSync('git', ['clean', '-fd'], { cwd: repo, stdio: 'ignore' });

    const runId = await runToCompletion('wt-no-work', repo);

    expect(gatesById(runId).get('echo-env')?.status).toBe('skipped');
    expect(existsSync(indexRoot)).toBe(true);
    expect(readFileSync(join(repo, '.commandmate', 'verify.yaml'), 'utf8')).toContain('echo-env');
    // Nothing claimed: the registry we redirected to is still empty.
    expect(readdirSync(indexRoot)).toEqual([]);
  });
});

// =============================================================================
// gate mutex
// =============================================================================

/** Records `start`/`end` around a sleep so overlap is visible in the file. */
function mutexConfig(label: string, sharedLog: string, sleepSec: string): string {
  return `
version: 1
gates:
  - id: shared-resource
    command: "sh -c 'echo ${label}-start >> ${sharedLog}; sleep ${sleepSec}; echo ${label}-end >> ${sharedLog}'"
    timeoutSec: 30
    mutex: shared-fixture
options:
  baseRef: main
`;
}

describe('gates[].mutex (Issue #1771)', () => {
  it('does not let two worktrees run the same mutex at once', async () => {
    const sharedLog = join(tempDir('gate-mutex-log-'), 'order.log');
    const repoA = createRepo(mutexConfig('a', sharedLog, '0.4'));
    const repoB = createRepo(mutexConfig('b', sharedLog, '0.4'));
    registerWorktree('wt-mx-a', repoA);
    registerWorktree('wt-mx-b', repoB);

    const [runA, runB] = await Promise.all([
      startRun('wt-mx-a', repoA),
      startRun('wt-mx-b', repoB),
    ]);
    await Promise.all([waitForVerification(runA), waitForVerification(runB)]);

    expect(gatesById(runA).get('shared-resource')?.status).toBe('passed');
    expect(gatesById(runB).get('shared-resource')?.status).toBe('passed');

    // The evidence is the order the two commands actually wrote, not a status
    // the runner reports about itself: every start is followed by its own end.
    const order = readFileSync(sharedLog, 'utf8').trim().split('\n');
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0].replace('-start', '-end'));
    expect(order[3]).toBe(order[2].replace('-start', '-end'));
  });

  it('lets different mutex names run concurrently', async () => {
    const sharedLog = join(tempDir('gate-mutex-log-'), 'order.log');
    const repoA = createRepo(
      mutexConfig('a', sharedLog, '0.4').replace('mutex: shared-fixture', 'mutex: fixture-a')
    );
    const repoB = createRepo(
      mutexConfig('b', sharedLog, '0.4').replace('mutex: shared-fixture', 'mutex: fixture-b')
    );
    registerWorktree('wt-nm-a', repoA);
    registerWorktree('wt-nm-b', repoB);

    const [runA, runB] = await Promise.all([
      startRun('wt-nm-a', repoA),
      startRun('wt-nm-b', repoB),
    ]);
    await Promise.all([waitForVerification(runA), waitForVerification(runB)]);

    // Interleaved, because nothing said these two share anything. A lock keyed
    // on the gate id instead of the declared name would serialize these too and
    // silently cost the parallelism the feature exists to protect.
    const order = readFileSync(sharedLog, 'utf8').trim().split('\n');
    expect(order.slice(0, 2)).toEqual(
      expect.arrayContaining(['a-start', 'b-start'])
    );
  });

  it('records the wait separately from the duration', async () => {
    const sharedLog = join(tempDir('gate-mutex-log-'), 'order.log');
    // A holds the resource for ~0.6s; B's own command is nearly instant, so any
    // wait folded into its duration would be impossible to miss.
    const repoA = createRepo(mutexConfig('a', sharedLog, '0.6'));
    const repoB = createRepo(mutexConfig('b', sharedLog, '0'));
    registerWorktree('wt-w-a', repoA);
    registerWorktree('wt-w-b', repoB);

    const runA = await startRun('wt-w-a', repoA);
    // Give A time to reach its command gate and take the lock.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const runB = await startRun('wt-w-b', repoB);
    await Promise.all([waitForVerification(runA), waitForVerification(runB)]);

    const gateB = gatesById(runB).get('shared-resource');
    expect(gateB?.status).toBe('passed');

    const waited = waitedSecondsFrom(gateB?.logTail ?? null);
    expect(waited).not.toBeNull();
    expect(waited as number).toBeGreaterThan(0.1);
    // duration_ms is what B's own command took. Folding the wait in would
    // corrupt every timeout budget and every "this gate got slower" reading.
    expect(gateB?.durationMs as number).toBeLessThan((waited as number) * 1000);
    expect(gateB?.logTail).toContain(`${MUTEX_LOG_PREFIX} name=shared-fixture`);
    expect(gateB?.logTail).toContain(`lock=${join(lockRoot, 'shared-fixture.lock')}`);

    // The invariant #1625 fixed still holds: the stored window is the command's,
    // and the wait sits outside it.
    const startedAt = gateB?.startedAt as Date;
    const finishedAt = gateB?.finishedAt as Date;
    expect(finishedAt.getTime() - startedAt.getTime()).toBe(gateB?.durationMs);
  });

  it('records waited=0.0s for a mutexed gate that never queued', async () => {
    const sharedLog = join(tempDir('gate-mutex-log-'), 'order.log');
    const repo = createRepo(mutexConfig('solo', sharedLog, '0'));
    registerWorktree('wt-solo', repo);

    const runId = await runToCompletion('wt-solo', repo);

    // Present even at zero: "this gate is serialized and did not wait" is a
    // different fact from "this gate has no mutex", and the reader has to be
    // able to tell them apart.
    expect(waitedSecondsFrom(gatesById(runId).get('shared-resource')?.logTail ?? null)).toBe(0);
  });

  it('leaves a gate without a mutex byte-identical to before the feature', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: plain
    command: "sh -c 'echo hello'"
    timeoutSec: 30
options:
  baseRef: main
`);
    registerWorktree('wt-plain', repo);

    const runId = await runToCompletion('wt-plain', repo);
    const gate = gatesById(runId).get('plain');
    expect(gate?.status).toBe('passed');
    expect(gate?.logTail).toBe('hello\n');
    expect(gate?.logTail).not.toContain(MUTEX_LOG_PREFIX);
  });

  it('releases the lock when the gate fails, so the next run is not blocked', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: failing
    command: "sh -c 'exit 3'"
    timeoutSec: 30
    mutex: release-check
options:
  baseRef: main
`);
    registerWorktree('wt-rel', repo);

    const first = await runToCompletion('wt-rel', repo);
    expect(gatesById(first).get('failing')?.exitCode).toBe(3);
    expect(existsSync(join(lockRoot, 'release-check.lock'))).toBe(false);

    // A lock leaked by a failing gate would wedge the resource for everyone
    // until the machine was cleaned by hand.
    const second = await runToCompletion('wt-rel', repo);
    expect(gatesById(second).get('failing')?.status).toBe('failed');
  });

  it('reports mutex-wait rather than TIMEOUT when the lock never comes free', async () => {
    const sentinel = join(tempDir('gate-mutex-sentinel-'), 'ran.txt');
    const repo = createRepo(`
version: 1
gates:
  - id: blocked
    command: "sh -c 'echo ran > ${sentinel}'"
    timeoutSec: 1
    mutex: held-elsewhere
options:
  baseRef: main
`);
    registerWorktree('wt-blocked', repo);

    // Another runner on this machine owns the resource for the whole budget.
    const held = await acquireMachineLock('held-elsewhere', {
      root: lockRoot,
      timeoutMs: 1000,
    });
    expect(held.acquired).toBe(true);

    const runId = await runToCompletion('wt-blocked', repo);

    const gate = gatesById(runId).get('blocked');
    // Not `timeout`: the command was never started, so nothing ran long. Not
    // `failed` either — a resource conflict and a broken change must stop
    // reading the same, which is the defect this Issue exists to fix.
    expect(gate?.status).toBe('skipped');
    expect(gate?.exitCode).toBeNull();
    expect(gate?.logTail?.split('\n')[0]).toMatch(
      new RegExp(`^${MUTEX_WAIT_SKIP_REASON.replace(/[.*+?^$()|[\]\\]/g, '\\$&')} waited=`)
    );
    expect(gate?.logTail).toContain("declares mutex 'held-elsewhere'");
    // The sentinel is the evidence: `skipped` is a label the runner writes about
    // itself, an absent file is proof the command never ran.
    expect(existsSync(sentinel)).toBe(false);
    // `error`, so the CLI exits 99 ("no verdict") rather than 20 ("the work is
    // bad") — the distinction the whole Issue is about.
    expect(getVerificationRun(db, runId)?.status).toBe('error');

    if (held.acquired) held.handle.release();
  });
});

describe('runner / CLI mirror', () => {
  it('spells the mutex marker identically on both sides', () => {
    // src/cli is compiled by tsconfig.cli.json alone, with no path aliases, so
    // the CLI cannot import the runner's constant. This is the pin that stops
    // the two copies from drifting.
    expect(CLI_MUTEX_LOG_PREFIX).toBe(MUTEX_LOG_PREFIX);
  });
});
