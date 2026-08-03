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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
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
import { SCOPE_SKIP_NO_CONTRACT } from '@/lib/verification/scope-gate';
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

/** Turn the uncommitted work of {@link addWork} into a commit on `work`. */
function commitWork(): void {
  git(['add', '-A'], repo);
  git(['commit', '-m', 'agent work'], repo);
}

/**
 * Re-declare the repository with no failing gate.
 *
 * The shared fixture declares `fail-gate`, and {@link aggregateRunStatus} ranks
 * `failed` above `error` — so a run that reported `error` for the right reason
 * would be indistinguishable from one that reported `failed` for the wrong one.
 * Tests whose subject is the run *status* use this instead.
 */
function usePassingGatesOnly(extraOptions = ''): void {
  writeFileSync(
    join(repo, '.commandmate', 'verify.yaml'),
    `version: 1
gates:
  - id: pass-gate
    command: "sh -c 'exit 0'"
options:
  baseRef: main
  skipInPrimaryCheckout: false
${extraOptions}`
  );
}

function seedTask(
  options: {
    gates?: string[];
    status?: TaskStatus;
    requireWorkEvidence?: boolean;
    requireScopeClean?: boolean;
    requireCommit?: boolean;
    allow?: string[];
    contractPath?: string;
  } = {}
): Task {
  const gates = options.gates ? `verify:\n  gates: [${options.gates.join(', ')}]\n` : '';
  const flags = (['requireWorkEvidence', 'requireScopeClean', 'requireCommit'] as const)
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
    if (dir) removeTempDir(dir);
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
    usePassingGatesOnly();
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'pass-gate',
    ]);
    const scope = run?.gates.find((gate) => gate.gateId === 'scope');
    expect(scope?.status).toBe('skipped');
    expect(scope?.logTail).toBe(SCOPE_SKIP_NO_CONTRACT);
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

/**
 * Issue #1620: a worker that verifies its own work moves the task to
 * `succeeded`, and the orchestrator's later `wait --verify` then resolved no
 * task at all — so the contract's scope was never judged and the run still
 * reported `passed`. Two properties keep that from happening silently: a run
 * that names its task judges that contract whatever the task's status, and a
 * run that cannot attach to a contract which exists says so instead of
 * collapsing into the harmless contract-less skip.
 */
describe('detached contracts', () => {
  it('judges the contract scope of a task the run names, even after it was closed', async () => {
    const task = seedTask({ gates: ['pass-gate'], allow: ['allowed/**'] });
    updateTaskStatus(db, task.id, 'succeeded');
    addWork(); // work.txt, which "allowed/**" does not cover

    const run = getVerificationRun(db, await runToCompletion({ taskId: task.id }));
    expect(run?.gates.find((gate) => gate.gateId === 'scope')?.status).toBe('failed');
    expect(run?.status).toBe('failed');
    // The verdict belongs to the run. The closed task is still not walked back.
    expect(getTask(db, task.id)?.status).toBe('succeeded');
  });

  it('finds a task whose gates failed without being told its id', async () => {
    // The state machine reopens `failed` for a re-run, so a re-run has to be
    // able to *find* it: resolving only the active statuses meant the retry
    // every worker performs after a red gate lost the contract.
    const task = seedTask({ gates: ['pass-gate'], allow: ['allowed/**'] });
    updateTaskStatus(db, task.id, 'failed');
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.taskId).toBe(task.id);
    expect(run?.gates.find((gate) => gate.gateId === 'scope')?.status).toBe('failed');
  });

  it('refuses to report passed when a closed contract could not be attached', async () => {
    usePassingGatesOnly();
    const task = seedTask();
    updateTaskStatus(db, task.id, 'succeeded');
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    const scope = run?.gates.find((gate) => gate.gateId === 'scope');
    expect(scope?.status).toBe('skipped');
    // The reader has to be able to tell this from "no contract exists".
    expect(scope?.logTail).not.toBe(SCOPE_SKIP_NO_CONTRACT);
    expect(scope?.logTail).toContain(task.id);
    expect(scope?.logTail).toContain('succeeded');
    expect(run?.status).toBe('error');
    // Not attributed: this run did not judge that task, and saying it did would
    // put a verdict-less run in the task's history.
    expect(run?.taskId).toBeNull();
  });

  it('stays green when the closed contract never asked for a clean scope', async () => {
    // Nothing was declined: the gate would have skipped even fully attached.
    usePassingGatesOnly();
    const task = seedTask({ requireScopeClean: false });
    updateTaskStatus(db, task.id, 'succeeded');
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.find((gate) => gate.gateId === 'scope')?.status).toBe('skipped');
    expect(run?.status).toBe('passed');
  });

  it('stays green when a contract was created but never sent', async () => {
    // `pending` means no message went out, so no run can be about it yet.
    usePassingGatesOnly();
    seedTask({ status: 'pending' });
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.status).toBe('passed');
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

/**
 * Issue #1642: the delegation-scoped commit requirement.
 *
 * `options.requireCommit` (#1628) answers the same question per repository, and
 * a repository has exactly one verify.yaml — so "a delegated worker must commit"
 * and "my own interactive `commandmate verify` must still report lint/typecheck
 * while I am mid-edit" could not both be true. A failing work-evidence gate
 * skips every gate after it, so the interactive case loses all its output.
 *
 * The verdicts here are the counterpart of the sentences pinned in
 * tests/unit/tasks/contract-message.test.ts. The pair is the Issue: a rule the
 * preamble declares and the runner does not check is the defect.
 */
describe('success.requireCommit (Issue #1642)', () => {
  /** work-evidence's own verdict, not just the run's. */
  function workEvidence(runId: number) {
    return getVerificationRun(db, runId)?.gates.find((gate) => gate.gateId === 'work-evidence');
  }

  it('fails a contract that requires a commit when the worker left the work uncommitted', async () => {
    // The acceptance criterion: `wait --verify` must not hand back exit 0 here.
    // `not_started` is what the CLI maps to exit 21.
    const task = seedTask({ gates: ['pass-gate'], requireCommit: true });
    usePassingGatesOnly();
    addWork();

    const runId = await runToCompletion({ taskId: task.id });

    expect(workEvidence(runId)?.status).toBe('failed');
    // uncommitted counts verify.yaml too — usePassingGatesOnly() rewrote it, and
    // #1580 excludes contract files but deliberately not verify.yaml.
    expect(workEvidence(runId)?.logTail).toMatch(
      /commits=0 uncommitted=[1-9]\d* requireCommit=true/
    );
    expect(workEvidence(runId)?.logTail).toContain('success.requireCommit (task contract)');
    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
    expect(getTask(db, task.id)?.status).toBe('not_started');
  });

  it('passes the same contract once the work is committed', async () => {
    // Pairs with the case above: without it, the failure could be coming from
    // the contract being unusable rather than from the missing commit.
    const task = seedTask({ gates: ['pass-gate'], requireCommit: true });
    usePassingGatesOnly();
    addWork();
    commitWork();

    const runId = await runToCompletion({ taskId: task.id });

    expect(workEvidence(runId)?.status).toBe('passed');
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
    expect(getTask(db, task.id)?.status).toBe('succeeded');
  });

  describe('the OR against options.requireCommit', () => {
    // The three cells the PM decision fixes. "The contract wins" would make the
    // middle one pass, which is how a delegation would quietly switch off a rule
    // the repository declared.
    it('verify.yaml false × contract true → a commit is required', async () => {
      const task = seedTask({ gates: ['pass-gate'], requireCommit: true });
      usePassingGatesOnly();
      addWork();

      const runId = await runToCompletion({ taskId: task.id });
      expect(getVerificationRun(db, runId)?.status).toBe('not_started');
      expect(workEvidence(runId)?.logTail).toContain('success.requireCommit (task contract)');
      expect(workEvidence(runId)?.logTail).not.toContain('options.requireCommit');
    });

    it('verify.yaml true × contract false → a commit is still required', async () => {
      const task = seedTask({ gates: ['pass-gate'], requireCommit: false });
      usePassingGatesOnly('  requireCommit: true\n');
      addWork();

      const runId = await runToCompletion({ taskId: task.id });
      expect(getVerificationRun(db, runId)?.status).toBe('not_started');
      expect(workEvidence(runId)?.logTail).toContain(
        'options.requireCommit (.commandmate/verify.yaml)'
      );
      expect(workEvidence(runId)?.logTail).not.toContain('success.requireCommit');
    });

    it('both declared → both are named in the reason', async () => {
      const task = seedTask({ gates: ['pass-gate'], requireCommit: true });
      usePassingGatesOnly('  requireCommit: true\n');
      addWork();

      const runId = await runToCompletion({ taskId: task.id });
      expect(workEvidence(runId)?.logTail).toContain(
        'options.requireCommit (.commandmate/verify.yaml) and success.requireCommit (task contract)'
      );
    });

    it('both omitted → an uncommitted change is still work evidence', async () => {
      const task = seedTask({ gates: ['pass-gate'] });
      usePassingGatesOnly();
      addWork();

      const runId = await runToCompletion({ taskId: task.id });
      expect(workEvidence(runId)?.status).toBe('passed');
      expect(workEvidence(runId)?.logTail).not.toContain('requireCommit');
      expect(getVerificationRun(db, runId)?.status).toBe('passed');
      expect(getTask(db, task.id)?.status).toBe('succeeded');
    });
  });

  it('leaves a contract-less `commandmate verify` running every gate on a dirty tree', async () => {
    // The case options.requireCommit could not keep working: the interactive
    // "am I breaking anything right now" run, where work-evidence failing would
    // take lint / typecheck / unit down with it as `skipped`.
    usePassingGatesOnly();
    addWork();

    const runId = await runToCompletion();
    const run = getVerificationRun(db, runId);

    expect(run?.taskId).toBeNull();
    expect(workEvidence(runId)?.status).toBe('passed');
    expect(run?.gates.find((gate) => gate.gateId === 'pass-gate')?.status).toBe('passed');
    expect(run?.status).toBe('passed');
  });

  it('does not read the requirement off a contract the run could not attach to', async () => {
    // A detached contract is already reported by the scope gate (#1620); reading
    // its flags anyway would let a closed task govern a run it is not part of.
    const task = seedTask({ gates: ['pass-gate'], requireCommit: true });
    updateTaskStatus(db, task.id, 'succeeded');
    usePassingGatesOnly();
    addWork();

    const runId = await runToCompletion();

    expect(getVerificationRun(db, runId)?.taskId).toBeNull();
    expect(workEvidence(runId)?.status).toBe('passed');
    expect(workEvidence(runId)?.logTail).not.toContain('requireCommit');
    // ...and the run is still not green, because scope went unjudged.
    expect(getVerificationRun(db, runId)?.status).toBe('error');
  });
});
