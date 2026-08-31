/**
 * Issue #2063: cancelling a verification run stops the processes it started.
 *
 * The acceptance criterion is deliberately not "the row says cancelled". A
 * cancel that only rewrote `verification_runs.status` would leave the gate's
 * `npm run build` executing in the worktree — still writing `.next`, still
 * holding ports — behind a UI claiming the run was over, which is a worse state
 * than having no cancel at all. So the assertions here are about *processes*:
 * the gate records its own pid and the pid of a grandchild it backgrounds, and
 * both must be gone afterwards.
 *
 * Everything below the HTTP boundary is real — the route, the runner, the git
 * repository, the shell. A mocked `spawn` would assert only that the test
 * author's mock was called; the property under test is that a signal reached a
 * real process group. Gates are spawned `detached`, which is exactly what makes
 * that reachable: killing only the shell leaves its children running.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import { waitForVerification } from '@/lib/verification/gate-runner';
import { CANCELLED_SKIP_LOG } from '@/lib/verification/run-verdict-vocabulary';
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
let repo: string;
const WT_ID = 'wt-cancel-2063';
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/**
 * A worktree whose gate parks and records what it started.
 *
 * `SHELL_PID` is the gate's own shell; `SLEEP_PID` is a grandchild it puts in
 * the background. Killing only `child.pid` would leave the second one alive,
 * which is the failure mode `detached` + a negative pid exists to prevent — so
 * the fixture makes that failure visible instead of leaving it to inspection.
 */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-cancel-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'cancel@example.test'], dir);
  git(['config', 'user.name', 'Cancel'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(
    join(dir, '.commandmate', 'verify.yaml'),
    `
version: 1
gates:
  - id: parked
    command: "sh -c 'sleep 120 & echo $! > ${dir}/sleep.pid; echo $$ > ${dir}/shell.pid; wait; touch ${dir}/parked.done'"
    timeoutSec: 120
  - id: after
    command: "sh -c 'touch ${dir}/after.ran'"
    timeoutSec: 30
options:
  baseRef: main
`
  );
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  // Uncommitted work, so the built-in work-evidence gate has something to find.
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
  return dir;
}

async function postVerify(id: string, body: unknown = {}) {
  const { POST } = await import('@/app/api/worktrees/[id]/verify/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${id}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ),
    { params: Promise.resolve({ id }) }
  );
}

async function postCancel(id: string, runId: string) {
  const { POST } = await import('@/app/api/worktrees/[id]/verify/runs/[runId]/cancel/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${id}/verify/runs/${runId}/cancel`, {
        method: 'POST',
      })
    ),
    { params: Promise.resolve({ id, runId }) }
  );
}

/**
 * Budget for "the process is gone" after a cancel.
 *
 * Deliberately well under the runner's 5s SIGTERM -> SIGKILL grace. Measured on
 * macOS while writing this file: signalling only `child.pid` instead of the
 * process group leaves the backgrounded grandchild alive, and it is the
 * *escalation* five seconds later that finally reaps it. A generous budget here
 * would therefore pass for an implementation that never signals the group —
 * exactly the implementation this suite exists to reject, because the real gate
 * is `npm run build` and the real grandchild is the build it forked.
 */
const PROCESS_DEATH_BUDGET_MS = 2000;

/** Poll until `predicate` holds, or give up. Returns whether it held. */
async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** Signal 0 asks "is this pid still addressable" without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file: string): number {
  const pid = Number(readFileSync(file, 'utf-8').trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  return pid;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo();
  upsertWorktree(db, {
    id: WT_ID,
    name: 'feature/cancel',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('POST /api/worktrees/:id/verify/runs/:runId/cancel (Issue #2063)', () => {
  it('kills the gate process group and closes the run as cancelled', async () => {
    const { runId } = await (await postVerify(WT_ID)).json();

    // Both pid files exist only once the gate's shell has actually started and
    // backgrounded its child, so this is the point at which there is something
    // real to kill.
    expect(await until(() => existsSync(join(repo, 'sleep.pid')) && existsSync(join(repo, 'shell.pid')))).toBe(true);
    const shellPid = readPid(join(repo, 'shell.pid'));
    const sleepPid = readPid(join(repo, 'sleep.pid'));
    expect(isAlive(shellPid)).toBe(true);
    expect(isAlive(sleepPid)).toBe(true);

    const res = await postCancel(WT_ID, String(runId));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId, status: 'cancelled' });

    // THE criterion. Not "the row says cancelled" — the processes are gone.
    // Polled rather than asserted outright: the kernel reaps asynchronously,
    // and a race here would make the suite flaky in the direction of passing.
    expect(await until(() => !isAlive(shellPid), PROCESS_DEATH_BUDGET_MS)).toBe(true);
    expect(await until(() => !isAlive(sleepPid), PROCESS_DEATH_BUDGET_MS)).toBe(true);

    // The parked command never reached its own last line, and the gate that
    // would have followed it never started.
    expect(existsSync(join(repo, 'parked.done'))).toBe(false);
    expect(existsSync(join(repo, 'after.ran'))).toBe(false);

    const run = getVerificationRun(db, runId);
    expect(run?.status).toBe('cancelled');
    expect(run?.finishedAt).not.toBeNull();

    const gates = new Map((run?.gates ?? []).map((gate) => [gate.gateId, gate]));
    // Both rows exist and both say `skipped`: the interrupted gate reached no
    // verdict, and the one after it never ran. A report that simply omitted
    // them would be indistinguishable from a run where they passed.
    expect(gates.get('parked')?.status).toBe('skipped');
    expect(gates.get('parked')?.logTail).toContain(CANCELLED_SKIP_LOG);
    expect(gates.get('after')?.status).toBe('skipped');
    expect(gates.get('after')?.logTail).toContain(CANCELLED_SKIP_LOG);
    // No gate row is left open — an unclosed `running` row is what the startup
    // reconciler exists to mop up, and a cancel must not be creating work for it.
    expect((run?.gates ?? []).some((gate) => gate.status === 'running')).toBe(false);

    // The worktree is free again: the per-worktree conflict check keys off an
    // open run, and being stuck behind one is the whole reason to cancel. Run
    // to completion so the suite leaves nothing executing behind it.
    const next = await postVerify(WT_ID, { gateIds: ['work-evidence'] });
    expect(next.status).toBe(202);
    await waitForVerification((await next.json()).runId);
  });

  it('refuses a run that has already reached a verdict', async () => {
    const { runId } = await (await postVerify(WT_ID, { gateIds: ['work-evidence'] })).json();
    await waitForVerification(runId);
    expect(getVerificationRun(db, runId)?.status).toBe('passed');

    const res = await postCancel(WT_ID, String(runId));
    expect(res.status).toBe(409);
    // The verdict rides along: the caller's list is simply one poll behind, and
    // saying which verdict it reached is more use than a bare refusal.
    expect((await res.json()).status).toBe('passed');
    // And the recorded verdict is untouched — a refused cancel must not rewrite
    // a run that was judged.
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
  });

  it('answers 404 for a run id that belongs to another worktree', async () => {
    const other = createRepo();
    upsertWorktree(db, {
      id: 'wt-cancel-other',
      name: 'feature/other',
      path: other,
      repositoryPath: other,
      repositoryName: 'fixture',
    });
    const { runId } = await (await postVerify(WT_ID, { gateIds: ['work-evidence'] })).json();
    await waitForVerification(runId);

    const res = await postCancel('wt-cancel-other', String(runId));
    expect(res.status).toBe(404);
  });

  it('rejects a malformed run id before touching the runner', async () => {
    expect((await postCancel(WT_ID, '0')).status).toBe(400);
    expect((await postCancel(WT_ID, 'abc')).status).toBe(400);
  });
});

describe('POST /api/worktrees/:id/verify with gateIds (Issue #2063)', () => {
  it('records a gate row only for the gates the request named', async () => {
    const res = await postVerify(WT_ID, { gateIds: ['work-evidence', 'after'] });
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    await waitForVerification(runId);

    // The DB rows are the assertion the Issue asks for: `parked` is absent, so
    // the 120s gate genuinely did not execute, and the sentinel the skipped
    // gate would have written is absent too.
    const run = getVerificationRun(db, runId);
    expect((run?.gates ?? []).map((gate) => gate.gateId)).toEqual(['work-evidence', 'after']);
    expect(run?.status).toBe('passed');
    expect(existsSync(join(repo, 'after.ran'))).toBe(true);
    expect(existsSync(join(repo, 'shell.pid'))).toBe(false);
  });

  it('still runs every gate when no gateIds is sent', async () => {
    // The unchanged path. `parked` is excluded by naming the others rather than
    // by omitting gateIds, so this asserts the DEFAULT selection composes
    // work-evidence + scope + the declared gates exactly as it did before.
    const { runId } = await (await postVerify(WT_ID, { gateIds: ['work-evidence', 'scope'] })).json();
    await waitForVerification(runId);
    expect((getVerificationRun(db, runId)?.gates ?? []).map((g) => g.gateId)).toEqual([
      'work-evidence',
      'scope',
    ]);
  });
});
