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
  updateTaskStatus,
  upsertWorktree,
  type Task,
  type TaskStatus,
} from '@/lib/db';
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
  options: { gates?: string[]; status?: TaskStatus; requireWorkEvidence?: boolean } = {}
): Task {
  const gates = options.gates ? `verify:\n  gates: [${options.gates.join(', ')}]\n` : '';
  const success =
    options.requireWorkEvidence === undefined
      ? ''
      : `success:\n  requireWorkEvidence: ${options.requireWorkEvidence}\n`;
  return createTask(db, {
    worktreeId: wtId,
    cliToolId: 'claude',
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: contract run
goal: do the work
scope:
  allow: ["**"]
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
    // that ignored the contract would have failed here. work-evidence is added
    // because the contract's success.requireWorkEvidence defaults to true.
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['work-evidence', 'pass-gate']);
    expect(run?.status).toBe('passed');
  });

  it('omits work-evidence when the contract does not require it', async () => {
    seedTask({ gates: ['pass-gate'], requireWorkEvidence: false });
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

  it('records a run against an explicit task id whose row is gone', async () => {
    addWork();
    const missingTaskId = '00000000-0000-4000-8000-000000000000';

    const runId = await runToCompletion({ taskId: missingTaskId });
    expect(getVerificationRun(db, runId)?.taskId).toBe(missingTaskId);
  });
});
