/**
 * A run cancelled while it waits for its FIRST verification slot leaves the
 * queue at once (Issue #3909), as the re-take after a mutex wait has since
 * #3884 N3.
 *
 * Real processes and the real slot queue, as `gate-slot-mutex-3884.test.ts`
 * does it: "both slots are full" has to be two gates really executing, and
 * "the cancelled run never started" is an ordering of process execution.
 *
 * The lock root and the index registry are redirected into `mkdtemp` for every
 * test, so nothing here serializes against a live run in another worktree.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import type { VerificationGateResult } from '@/lib/db';
import {
  cancelVerification,
  MAX_CONCURRENT_VERIFICATIONS,
  startVerification,
  waitForVerification,
} from '@/lib/verification/gate-runner';
import { MACHINE_LOCK_ROOT_ENV } from '@/lib/verification/machine-lock';
import { WORKTREE_INDEX_ROOT_ENV } from '@/lib/verification/worktree-index';
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
  const dir = tempDir('gate-slot-3909-');
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate-slot-3909@example.test'], dir);
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

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  vi.stubEnv(MACHINE_LOCK_ROOT_ENV, tempDir('gate-slot-3909-locks-'));
  vi.stubEnv(WORKTREE_INDEX_ROOT_ENV, tempDir('gate-slot-3909-index-'));
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

/** The `[timing]` queue of a gate, in seconds. */
function queueOf(logTail: string | null | undefined): number | null {
  const match = /^\[timing\] queue=([0-9.]+)s /m.exec(logTail ?? '');
  return match ? Number(match[1]) : null;
}

/** Two runs whose `lint` executes for `sleepSec`, holding both slots until it ends. */
async function fillBothSlots(prefix: string, sharedLog: string, sleepSec: string): Promise<number[]> {
  expect(MAX_CONCURRENT_VERIFICATIONS).toBe(2);
  const runs = [
    await startRun(`${prefix}-b`, gateConfig('lint', 'b', sharedLog, sleepSec)),
    await startRun(`${prefix}-c`, gateConfig('lint', 'c', sharedLog, sleepSec)),
  ];
  expect(
    await until(() => logLines(sharedLog).filter((line) => line.endsWith('-start')).length === 2)
  ).toBe(true);
  return runs;
}

describe('cancelling a run queued for its first slot (Issue #3909)', () => {
  it('closes it cancelled at once while both slots execute long gates', async () => {
    const sharedLog = join(tempDir('gate-slot-3909-log-'), 'order.log');
    // B and C execute for longer than the cancel endpoint waits (8s).
    const [runB, runC] = await fillBothSlots('wt-q-1', sharedLog, '10');
    const runA = await startRun('wt-q-1-a', gateConfig('lint', 'a', sharedLog, '0'));
    // A is queued: it has written no gate row, because executeRun has not begun.
    expect(getVerificationRun(db, runA)?.status).toBe('running');
    expect(getVerificationRun(db, runA)?.gates).toEqual([]);

    const startedAt = Date.now();
    const outcome = await cancelVerification(runA);
    // Before #3909 the wait was not abandonable: A stayed queued behind B and
    // C, and the endpoint answered `requested` with A still `running`.
    expect(outcome).toEqual({ kind: 'cancelled', status: 'cancelled' });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(getVerificationRun(db, runA)?.status).toBe('cancelled');
    expect(getVerificationRun(db, runA)?.gates).toEqual([]);
    // B and C are untouched, and A never started.
    expect([...logLines(sharedLog)].sort()).toEqual(['b-start', 'c-start']);

    // The abandoned wait left no claim on a slot behind it: when B ends, the
    // slot goes to the next run waiting, not to the cancelled one.
    const runD = await startRun('wt-q-1-d', gateConfig('lint', 'd', sharedLog, '0'));
    expect(await cancelVerification(runB)).toEqual({ kind: 'cancelled', status: 'cancelled' });
    expect(await waitForVerification(runD)).toBe('passed');
    expect(logLines(sharedLog)).not.toContain('a-start');

    await cancelVerification(runC);
  }, 40_000);

  it('still runs a queued run that is not cancelled, with its queue on the record', async () => {
    // Negative control: making the wait abandonable must not make it skippable.
    const sharedLog = join(tempDir('gate-slot-3909-log-'), 'order.log');
    // Long enough that A's repository is made while both still execute, under a loaded runner too.
    const [runB, runC] = await fillBothSlots('wt-q-2', sharedLog, '3');
    const runA = await startRun('wt-q-2-a', gateConfig('lint', 'a', sharedLog, '0'));
    expect(getVerificationRun(db, runA)?.gates).toEqual([]);

    expect(await waitForVerification(runA)).toBe('passed');
    await Promise.all([waitForVerification(runB), waitForVerification(runC)]);
    const lines = logLines(sharedLog);
    // A started only once a slot came free: after one of B / C ended.
    const firstEnd = Math.min(lines.indexOf('b-end'), lines.indexOf('c-end'));
    expect(lines.indexOf('a-start')).toBeGreaterThan(firstEnd);
    const lint = gateOf(runA, 'lint');
    expect(lint?.status).toBe('passed');
    expect(queueOf(lint?.logTail) as number).toBeGreaterThan(0);
  }, 30_000);
});
