/**
 * Verification ↔ task-contract integration (Issue #1545, Phase 2-1).
 *
 * This is where "the agent said it was done" is supposed to stop being the same
 * claim as "the work passes". The assertions are therefore about the task's
 * *recorded* status after a real run against a real repository — a mocked runner
 * would only prove the mapping table was typed correctly.
 *
 * Gates are `sh -c 'exit N'`, so each run costs milliseconds.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createTask,
  getTask,
  getVerificationRun,
  listTaskEvents,
  upsertWorktree,
  type Task,
  type TaskStatus,
} from '@/lib/db';
// See tasks-db.test.ts: fixtures reach past the barrel on purpose (#1548).
import { updateTaskStatus } from '@/lib/db/tasks-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { startVerification, waitForVerification } from '@/lib/verification/gate-runner';

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
const wtId = 'wt-contract';
const tempDirs: string[] = [];

const CONFIG = `version: 1
gates:
  - id: pass-gate
    command: "sh -c 'exit 0'"
    timeoutSec: 30
  - id: fail-gate
    command: "sh -c 'exit 1'"
    timeoutSec: 30
options:
  baseRef: main
  skipInPrimaryCheckout: false
`;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/**
 * A repo whose `work` branch starts level with `main`, so `baseRef: main` stays
 * a fixed point instead of following HEAD.
 */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task-verify-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'task@example.test'], dir);
  git(['config', 'user.name', 'Task'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), CONFIG);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

function addWork(): void {
  writeFileSync(join(repo, 'work.txt'), 'agent output\n');
}

function seedTask(
  options: {
    gates?: string[];
    status?: TaskStatus;
    requireWorkEvidence?: boolean;
    requireScopeClean?: boolean;
    allow?: string[];
    contractPath?: string;
  } = {}
): Task {
  const gates = options.gates ? `verify:\n  gates: [${options.gates.join(', ')}]\n` : '';
  const flags = (['requireWorkEvidence', 'requireScopeClean'] as const)
    .filter((key) => options[key] !== undefined)
    .map((key) => `  ${key}: ${options[key]}\n`)
    .join('');
  const success = flags === '' ? '' : `success:\n${flags}`;
  const allow = JSON.stringify(options.allow ?? ['**']);
  return createTask(db, {
    worktreeId: wtId,
    cliToolId: 'claude',
    contractPath: options.contractPath ?? '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: contract run
goal: do the work
scope:
  allow: ${allow}
${gates}${success}`,
      'task.yaml'
    ),
    status: options.status ?? 'running',
  });
}

async function runToCompletion(input: { taskId?: string; gateIds?: string[] } = {}) {
  const { runId } = await startVerification({
    worktreeId: wtId,
    worktreePath: repo,
    trigger: 'wait',
    taskId: input.taskId,
    gateIds: input.gateIds,
  });
  await waitForVerification(runId);
  return runId;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo();
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/contract',
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
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('task resolution', () => {
  it('attributes a run to the worktree active task without being told its id', async () => {
    const task = seedTask();
    addWork();

    const runId = await runToCompletion();
    expect(getVerificationRun(db, runId)?.taskId).toBe(task.id);
  });

  it('uses the contract gates as the default selection', async () => {
    seedTask({ gates: ['pass-gate'] });
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    // fail-gate is declared in verify.yaml but not in the contract, so a run
    // that ignored the contract would have failed here. work-evidence and scope
    // are added because the contract's success flags both default to true.
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'pass-gate',
    ]);
    expect(run?.status).toBe('passed');
  });

  it('omits the built-in gates when the contract does not require them', async () => {
    seedTask({ gates: ['pass-gate'], requireWorkEvidence: false, requireScopeClean: false });
    // No addWork(): without the work-evidence gate an empty worktree still passes.

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['pass-gate']);
    expect(run?.status).toBe('passed');
  });

  it('lets an explicit gate selection override the contract', async () => {
    seedTask({ gates: ['pass-gate'] });
    addWork();

    const run = getVerificationRun(db, await runToCompletion({ gateIds: ['fail-gate'] }));
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['fail-gate']);
    expect(run?.status).toBe('failed');
  });

  it('runs every gate when no task and no selection narrow it', async () => {
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.taskId).toBeNull();
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'pass-gate',
      'fail-gate',
    ]);
  });

  it('ignores a pending task: nothing was sent, so no run belongs to it', async () => {
    const task = seedTask({ status: 'pending' });
    addWork();

    const runId = await runToCompletion();
    expect(getVerificationRun(db, runId)?.taskId).toBeNull();
    expect(getTask(db, task.id)?.status).toBe('pending');
  });
});

describe('task status transitions', () => {
  it('moves a task to succeeded when every gate passes', async () => {
    const task = seedTask({ gates: ['work-evidence', 'pass-gate'] });
    addWork();

    const runId = await runToCompletion();
    const updated = getTask(db, task.id);
    expect(updated?.status).toBe('succeeded');
    expect(updated?.lastVerificationRunId).toBe(runId);
    expect(updated?.finishedAt).not.toBeNull();
  });

  it('moves a task to failed when a gate fails', async () => {
    const task = seedTask({ gates: ['fail-gate'] });
    addWork();

    const runId = await runToCompletion();
    expect(getVerificationRun(db, runId)?.status).toBe('failed');
    expect(getTask(db, task.id)?.status).toBe('failed');
  });

  it('moves a task to not_started when the agent produced nothing', async () => {
    const task = seedTask({ gates: ['work-evidence', 'pass-gate'] });
    // No addWork(): the tree is clean and level with main.

    const runId = await runToCompletion();
    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
    expect(getTask(db, task.id)?.status).toBe('not_started');
  });

  it('fails a task when the verify config is unusable, rather than leaving it verifying', async () => {
    const task = seedTask();
    addWork();
    writeFileSync(join(repo, '.commandmate', 'verify.yaml'), 'version: 1\ngates: []\n');

    const runId = await runToCompletion();
    expect(getVerificationRun(db, runId)?.status).toBe('error');

    const updated = getTask(db, task.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.lastVerificationRunId).toBe(runId);
  });

  it('does not reopen a task that already reached a terminal status', async () => {
    const task = seedTask({ gates: ['pass-gate'] });
    updateTaskStatus(db, task.id, 'succeeded');
    addWork();

    const runId = await runToCompletion({ taskId: task.id });
    expect(getVerificationRun(db, runId)?.taskId).toBe(task.id);
    const updated = getTask(db, task.id);
    expect(updated?.status).toBe('succeeded');
    // The run is recorded, but the closed task is not touched by it.
    expect(updated?.lastVerificationRunId).toBeNull();
  });

  it('moves a task to failed when the work went outside the contract scope', async () => {
    const task = seedTask({ gates: ['pass-gate'], allow: ['allowed/**'] });
    addWork(); // work.txt, which "allowed/**" does not cover

    const runId = await runToCompletion();
    const run = getVerificationRun(db, runId);
    expect(run?.status).toBe('failed');
    // Every gate still runs: one report should list every problem.
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'pass-gate',
    ]);
    const scope = run?.gates.find((gate) => gate.gateId === 'scope');
    expect(scope?.status).toBe('failed');
    expect(scope?.logTail).toContain('  - work.txt');
    expect(getTask(db, task.id)?.status).toBe('failed');
  });

  it('passes a task whose work stayed inside the contract scope', async () => {
    // The paired case: without it, a gate that failed unconditionally would
    // satisfy the assertion above.
    const task = seedTask({ gates: ['pass-gate'], allow: ['allowed/**'] });
    mkdirSync(join(repo, 'allowed'), { recursive: true });
    writeFileSync(join(repo, 'allowed', 'work.txt'), 'agent output\n');

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.find((gate) => gate.gateId === 'scope')?.status).toBe('passed');
    expect(run?.status).toBe('passed');
    expect(getTask(db, task.id)?.status).toBe('succeeded');
  });
});

describe('scope gate selection', () => {
  it('skips scope without failing a contract-less run', async () => {
    // The default selection always includes scope, so counting its skip would
    // turn every verification in a repository without contracts into an error.
    writeFileSync(
      join(repo, '.commandmate', 'verify.yaml'),
      `version: 1
gates:
  - id: pass-gate
    command: "sh -c 'exit 0'"
options:
  baseRef: main
  skipInPrimaryCheckout: false
`
    );
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'pass-gate',
    ]);
    expect(run?.gates.find((gate) => gate.gateId === 'scope')?.status).toBe('skipped');
    expect(run?.status).toBe('passed');
  });

  it('errors when scope was asked for by name and could not be judged', async () => {
    // "We declined to check" must not read as "we checked and it was fine".
    addWork();

    const run = getVerificationRun(db, await runToCompletion({ gateIds: ['scope'] }));
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['scope']);
    expect(run?.status).toBe('error');
  });

  it('runs scope alone when asked for by name and a contract exists', async () => {
    seedTask({ allow: ['allowed/**'] });
    addWork();

    const run = getVerificationRun(db, await runToCompletion({ gateIds: ['scope'] }));
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['scope']);
    expect(run?.status).toBe('failed');
  });

  it('drops scope from the selection when the contract switches it off', async () => {
    const task = seedTask({ gates: ['pass-gate'], allow: ['allowed/**'], requireScopeClean: false });
    addWork(); // outside allow, but the contract does not ask for a clean scope

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['work-evidence', 'pass-gate']);
    expect(run?.status).toBe('passed');
    expect(getTask(db, task.id)?.status).toBe('succeeded');
  });

  it('skips scope on requireScopeClean: false even when the gate is in the selection', async () => {
    // A contract that names no gates runs every gate, so the flag has to be
    // honoured by the gate itself and not only by the selection above it.
    const task = seedTask({ allow: ['allowed/**'], requireScopeClean: false });
    addWork(); // outside allow

    const run = getVerificationRun(db, await runToCompletion({ gateIds: ['scope'] }));
    const scope = run?.gates.find((gate) => gate.gateId === 'scope');
    expect(scope?.status).toBe('skipped');
    expect(scope?.logTail).toContain('requireScopeClean: false');
    // Asked for by name and declined, so the run must not read as a pass.
    expect(run?.status).toBe('error');
    expect(getTask(db, task.id)?.status).toBe('failed');
  });

  it('does not count the contract file against a scope that does not list it', async () => {
    const task = seedTask({
      gates: ['pass-gate'],
      allow: ['allowed/**'],
      contractPath: 'custom/t.yaml',
    });
    mkdirSync(join(repo, 'custom'), { recursive: true });
    writeFileSync(join(repo, 'custom', 't.yaml'), 'version: 1\n');

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.find((gate) => gate.gateId === 'scope')?.status).toBe('passed');
    expect(getTask(db, task.id)?.status).toBe('succeeded');
  });

  it('records scope as skipped when work-evidence stopped the run', async () => {
    seedTask({ gates: ['pass-gate'], allow: ['allowed/**'] });
    // No work at all: the run never reaches a scope judgement.

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.status).toBe('not_started');
    const scope = run?.gates.find((gate) => gate.gateId === 'scope');
    expect(scope?.status).toBe('skipped');
    expect(scope?.logTail).toContain('work-evidence');
  });
});

describe('task status transitions (continued)', () => {
  it('records a run against an explicit task id whose row is gone', async () => {
    addWork();
    const missingTaskId = '00000000-0000-4000-8000-000000000000';

    const runId = await runToCompletion({ taskId: missingTaskId });
    expect(getVerificationRun(db, runId)?.taskId).toBe(missingTaskId);
  });
});

/**
 * Issue #1548: the run is the source of the verify_* events, so the log has to
 * show a task entering verification and leaving it with a named verdict — not
 * just the final status, which cannot distinguish "the gates failed" from
 * "something wrote failed".
 */
describe('task events raised by a run', () => {
  const eventLog = (taskId: string) =>
    listTaskEvents(db, taskId).map((e) => [e.event, e.toStatus]);

  it('brackets a passing run with verify_started and verify_passed', async () => {
    const task = seedTask({ gates: ['work-evidence', 'pass-gate'] });
    addWork();

    const runId = await runToCompletion();
    expect(eventLog(task.id)).toEqual([
      ['verify_started', 'verifying'],
      ['verify_passed', 'succeeded'],
    ]);
    expect(listTaskEvents(db, task.id).every((e) => e.payload?.runId === runId)).toBe(true);
  });

  it('names the verdict for a failing run', async () => {
    const task = seedTask({ gates: ['fail-gate'] });
    addWork();

    await runToCompletion();
    expect(eventLog(task.id)).toEqual([
      ['verify_started', 'verifying'],
      ['verify_failed', 'failed'],
    ]);
  });

  it('names the verdict when the agent produced nothing', async () => {
    const task = seedTask({ gates: ['work-evidence', 'pass-gate'] });

    await runToCompletion();
    expect(eventLog(task.id)).toEqual([
      ['verify_started', 'verifying'],
      ['verify_not_started', 'not_started'],
    ]);
  });

  it('still passes through verifying when the config is unusable', async () => {
    // The run opened and errored immediately. Jumping straight to a verdict
    // would be a transition the machine has no rule for, so the task would
    // never leave `running` at all.
    const task = seedTask();
    addWork();
    writeFileSync(join(repo, '.commandmate', 'verify.yaml'), 'version: 1\ngates: []\n');

    await runToCompletion();
    expect(eventLog(task.id)).toEqual([
      ['verify_started', 'verifying'],
      ['verify_failed', 'failed'],
    ]);
  });

  it('records the refusal when a run targets an already-succeeded task', async () => {
    const task = seedTask({ gates: ['pass-gate'] });
    updateTaskStatus(db, task.id, 'succeeded');
    addWork();

    await runToCompletion({ taskId: task.id });
    // Both events are refused, and both are on the record: a run that tried to
    // reopen a closed task is exactly the thing worth being able to find later.
    expect(eventLog(task.id)).toEqual([
      ['verify_started', null],
      ['verify_passed', null],
    ]);
    expect(getTask(db, task.id)?.status).toBe('succeeded');
  });

  it('reopens a failed task for a re-run, which a terminal-status check could not', async () => {
    const task = seedTask({ gates: ['pass-gate'] });
    updateTaskStatus(db, task.id, 'failed');
    addWork();

    await runToCompletion({ taskId: task.id });
    expect(eventLog(task.id)).toEqual([
      ['verify_started', 'verifying'],
      ['verify_passed', 'succeeded'],
    ]);
  });

  it('writes no events at all when no task governs the run', async () => {
    addWork();
    await runToCompletion();
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
  });
});
