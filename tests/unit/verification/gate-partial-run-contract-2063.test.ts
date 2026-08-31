/**
 * A narrowed run cannot close a contract it never judged (Issue #2063).
 *
 * ## The chain this closes
 *
 * `#2063` added a one-click "re-run only the failed gates", which by
 * construction always sends a PROPER SUBSET of the gates. Before this file's
 * assertions held, that subset could be `['unit']` alone, and:
 *
 *   1. `selectGates` decided `runWorkEvidence` / `scope` from the request only,
 *      so both were off;
 *   2. `aggregateRunStatus` saw a single `passed` and called the run `passed`;
 *   3. a Web run carries no `taskId`, so `getVerifiableTask` adopted the
 *      worktree's `failed` contract task (`VERIFIABLE_TASK_STATUSES` includes
 *      `failed` on purpose, since #1620 — a retry must be able to reopen one);
 *   4. the state machine walked it `verify_started` -> `verify_passed` ->
 *      `succeeded`.
 *
 * A contract declaring `success.requireScopeClean: true` was therefore closed
 * as done with `scope.allow` never evaluated and no work evidence ever
 * established — a green verdict from having checked one gate out of twelve.
 *
 * The fix is the rule `runEnvClean` has followed since #1740, applied to the
 * other two built-ins: `gateIds` narrows which DECLARED gates run, and cannot
 * drop a criterion the contract declared.
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
import { createTask, getTask, getVerificationRun, upsertWorktree, type Task } from '@/lib/db';
import { updateTaskStatus } from '@/lib/db/tasks-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { startVerification, waitForVerification } from '@/lib/verification/gate-runner';
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
const WT_ID = 'wt-partial-2063';
const tempDirs: string[] = [];

/** `unit` passes, `lint` fails — the shape the shortcut is pressed from. */
const CONFIG = `
version: 1
gates:
  - id: lint
    command: "sh -c 'exit 1'"
    timeoutSec: 30
  - id: unit
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
`;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'partial-run-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'partial@example.test'], dir);
  git(['config', 'user.name', 'Partial'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), CONFIG);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

/** A change OUTSIDE the contract's `scope.allow`, so the scope gate has a verdict. */
function addOutOfScopeWork(): void {
  writeFileSync(join(repo, 'forbidden.txt'), 'touched a file the contract forbade\n');
}

/**
 * A contract task in the state a "re-run the failed gates" press starts from:
 * `failed`, which `getVerifiableTask` adopts so a retry can reopen it (#1620).
 */
function seedFailedContractTask(
  overrides: { allow?: string[]; requireScopeClean?: boolean } = {}
): Task {
  const allow = JSON.stringify(overrides.allow ?? ['allowed/**']);
  const success =
    overrides.requireScopeClean === undefined
      ? ''
      : `success:\n  requireScopeClean: ${overrides.requireScopeClean}\n`;
  const task = createTask(db, {
    worktreeId: WT_ID,
    cliToolId: 'claude',
    contractPath: '.commandmate/tasks/issue-2063.yaml',
    contract: parseTaskContract(
      `version: 1
title: contract under a narrowed run
goal: do the work
scope:
  allow: ${allow}
${success}`,
      'task.yaml'
    ),
    status: 'running',
  });
  updateTaskStatus(db, task.id, 'failed');
  return task;
}

/** The Web path: no taskId, so the run resolves the worktree's task itself. */
async function webRun(gateIds?: string[]): Promise<number> {
  const { runId } = await startVerification({
    worktreeId: WT_ID,
    worktreePath: repo,
    trigger: 'api',
    gateIds,
  });
  await waitForVerification(runId);
  return runId;
}

function gateIdsOf(runId: number): string[] {
  return (getVerificationRun(db, runId)?.gates ?? []).map((gate) => gate.gateId);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo();
  upsertWorktree(db, {
    id: WT_ID,
    name: 'feature/2063',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('a gateIds run against a contract that requires a clean scope', () => {
  it('does not turn the task succeeded by re-running only the gate that failed', async () => {
    const task = seedFailedContractTask();
    addOutOfScopeWork();

    // Exactly what the "re-run only the failed gates" button sends after a run
    // in which `unit` was the only red gate.
    const runId = await webRun(['unit']);

    // `unit` really did pass — this is not a test that fails for the wrong
    // reason. What must not happen is the run inheriting that pass as a verdict
    // about the contract.
    const gates = new Map(
      (getVerificationRun(db, runId)?.gates ?? []).map((gate) => [gate.gateId, gate])
    );
    expect(gates.get('unit')?.status).toBe('passed');

    // The contract's own criteria were evaluated, and the diff is outside
    // `scope.allow`, so the run is failed and the task stays failed.
    expect(gates.get('scope')?.status).toBe('failed');
    expect(getVerificationRun(db, runId)?.status).toBe('failed');
    expect(getTask(db, task.id)?.status).not.toBe('succeeded');
    expect(getTask(db, task.id)?.status).toBe('failed');
  });

  it('forces work-evidence and scope in, and still narrows the declared gates', async () => {
    seedFailedContractTask({ allow: ['**'] });
    addOutOfScopeWork();

    const runId = await webRun(['unit']);

    // `lint` — a repository gate — is genuinely dropped, which is the whole
    // point of the feature. The two built-ins the contract declared are not.
    expect(gateIdsOf(runId)).toEqual(['work-evidence', 'scope', 'unit']);
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
  });

  it('counts a scope it could not judge, rather than passing without it', async () => {
    // `allow: ['**']` admits everything, so scope PASSES above. Here the task
    // is gone by the time the run starts: no contract attaches, nothing forces
    // the built-ins, and the narrowed run is exactly as narrow as it was asked
    // to be — the contract-less behaviour, unchanged.
    addOutOfScopeWork();

    const runId = await webRun(['unit']);
    expect(gateIdsOf(runId)).toEqual(['unit']);
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
  });

  it('lets a contract switch the scope requirement off and keep a narrow run narrow', async () => {
    // `requireScopeClean: false` is a declaration too, and it says the opposite.
    // Honouring it is what keeps this a rule about declarations rather than a
    // blanket "always run scope".
    seedFailedContractTask({ requireScopeClean: false });
    addOutOfScopeWork();

    const runId = await webRun(['unit']);
    // work-evidence still runs: `requireWorkEvidence` defaults to true and this
    // contract did not switch it off.
    expect(gateIdsOf(runId)).toEqual(['work-evidence', 'unit']);
  });

  it('leaves a full run (no gateIds) byte-for-byte as it was', async () => {
    seedFailedContractTask({ allow: ['**'] });
    addOutOfScopeWork();

    const runId = await webRun();
    expect(gateIdsOf(runId)).toEqual(['work-evidence', 'scope', 'lint', 'unit']);
    // `lint` exits 1, so the run is failed — the default path is untouched.
    expect(getVerificationRun(db, runId)?.status).toBe('failed');
  });
});
