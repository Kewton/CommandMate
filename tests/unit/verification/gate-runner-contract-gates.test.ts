/**
 * Contract-carried verification gates (Issue #1791, #1756 案 B).
 *
 * An Issue-specific gate used to have only one route into a worktree: the
 * orchestrator appending it to `.commandmate/verify.yaml`. That file stays
 * inside the work-evidence change set, so a worktree carrying nothing but the
 * append reads as "the agent did work" and `exit 21` stops meaning anything.
 * The contract carries the definition instead — it is already snapshotted into
 * `tasks.contract_json` and already excluded from both gates' change sets.
 *
 * The gates here are `sh -c 'exit N'`, so the assertions are about a real run
 * against a real repository: whether the defined gate *executed* and whether
 * its exit code reached the run's verdict. A mocked runner would only prove the
 * plumbing compiles, and the failure this Issue is about is a gate that is
 * declared and never runs.
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
import {
  createTask,
  getTask,
  getVerificationRun,
  upsertWorktree,
  type Task,
  type TaskStatus,
  type VerificationGateSource,
} from '@/lib/db';
import { updateTaskStatus } from '@/lib/db/tasks-db';
import { parseTaskContract, type TaskContract } from '@/lib/tasks/contract-parser';
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
const wtId = 'wt-contract-gates';
const tempDirs: string[] = [];

/** Only passing gates: a failing verdict in these tests must come from the contract. */
const CONFIG = `version: 1
gates:
  - id: repo-lint
    command: "sh -c 'exit 0'"
    timeoutSec: 30
  - id: repo-unit
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
  skipInPrimaryCheckout: false
`;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'contract-gates-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate@example.test'], dir);
  git(['config', 'user.name', 'Gate'], dir);
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

interface SeedOptions {
  /** Raw `verify:` block; omitted means the contract declares nothing there. */
  verify?: string;
  status?: TaskStatus;
  /** Applied to the parsed contract before it is stored (legacy-row fixtures). */
  mutate?: (contract: TaskContract) => void;
}

function seedTask(options: SeedOptions = {}): Task {
  const contract = parseTaskContract(
    `version: 1
title: contract gates
goal: do the work
scope:
  allow: ["**"]
${options.verify ?? ''}`,
    'task.yaml'
  );
  options.mutate?.(contract);
  return createTask(db, {
    worktreeId: wtId,
    cliToolId: 'claude',
    contractPath: '.commandmate/tasks/t.yaml',
    contract,
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

/** `[gateId, source]` for every gate row of a run, in execution order. */
function gateSources(runId: number): Array<[string, VerificationGateSource | null]> {
  return (getVerificationRun(db, runId)?.gates ?? []).map((gate) => [gate.gateId, gate.source]);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo();
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/contract-gates',
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

const PASSING_REPRO = `verify:
  gates: [repo-lint, issue-1791-repro]
  gateDefinitions:
    - id: issue-1791-repro
      command: "sh -c 'exit 0'"
      timeoutSec: 30
`;

const FAILING_REPRO = `verify:
  gates: [repo-lint, issue-1791-repro]
  gateDefinitions:
    - id: issue-1791-repro
      command: "sh -c 'echo repro failed >&2; exit 3'"
      timeoutSec: 30
`;

describe('a gate the contract defines actually runs', () => {
  it('executes it and lets it pass the run', async () => {
    seedTask({ verify: PASSING_REPRO });
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'repo-lint',
      'issue-1791-repro',
    ]);
    expect(run?.status).toBe('passed');
  });

  it('lets it fail the run, with its exit code and log', async () => {
    // The direction that proves the gate is not decorative: nothing else in
    // this fixture can fail, so a green run here would mean the definition was
    // recorded and never executed.
    const task = seedTask({ verify: FAILING_REPRO });
    addWork();

    const runId = await runToCompletion();
    const run = getVerificationRun(db, runId);
    const repro = run?.gates.find((gate) => gate.gateId === 'issue-1791-repro');

    expect(repro?.status).toBe('failed');
    expect(repro?.exitCode).toBe(3);
    expect(repro?.logTail).toContain('repro failed');
    expect(run?.status).toBe('failed');
    // ...and the verdict reaches the task, which is what `wait --verify` reads.
    expect(getTask(db, task.id)?.status).toBe('failed');
  });

  it('runs it after every verify.yaml gate when the contract selects no gates', async () => {
    seedTask({
      verify:
        'verify:\n  gateDefinitions:\n    - id: issue-1791-repro\n' +
        '      command: "sh -c \'exit 0\'"\n',
    });
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    // Omitting `gates` means "every declared gate", which now spans both
    // declaration sites — the repository's first, the delegation's last.
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'repo-lint',
      'repo-unit',
      'issue-1791-repro',
    ]);
    expect(run?.status).toBe('passed');
  });

  it('is reachable by name from an explicit --gates selection', async () => {
    seedTask({ verify: FAILING_REPRO });
    addWork();

    const run = getVerificationRun(db, await runToCompletion({ gateIds: ['issue-1791-repro'] }));
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['issue-1791-repro']);
    expect(run?.status).toBe('failed');
  });

  it('honours the contract selection that leaves a verify.yaml gate out', async () => {
    seedTask({ verify: PASSING_REPRO });
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.gates.map((gate) => gate.gateId)).not.toContain('repo-unit');
  });
});

describe('where each verdict came from is recorded', () => {
  it('labels built-in, repository and contract gates distinctly', async () => {
    // Without this column the two kinds of gate are indistinguishable in the
    // report, and a run green on criteria the repository never agreed to looks
    // exactly like one green on the criteria it did.
    seedTask({ verify: PASSING_REPRO });
    addWork();

    expect(gateSources(await runToCompletion())).toEqual([
      ['work-evidence', 'builtin'],
      ['scope', 'builtin'],
      ['repo-lint', 'verify.yaml'],
      ['issue-1791-repro', 'contract'],
    ]);
  });

  it('keeps the source on gates that were recorded without running', async () => {
    // No addWork(): work-evidence fails, so everything below it is `skipped` —
    // and a skipped Issue gate must still be attributable.
    seedTask({ verify: PASSING_REPRO });

    const runId = await runToCompletion();
    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
    expect(gateSources(runId)).toEqual([
      ['work-evidence', 'builtin'],
      ['scope', 'builtin'],
      ['repo-lint', 'verify.yaml'],
      ['issue-1791-repro', 'contract'],
    ]);
  });
});

describe('a contract cannot redefine the repository gates', () => {
  it('refuses to run when a contract gate id collides with a verify.yaml one', async () => {
    // `validateContractAgainstVerifyConfig` rejects this at send, so reaching
    // the runner means the contract was stored by an older build. Running both
    // would put two rows under one id, which is the ambiguity `source` exists
    // to remove — so the run errors instead of guessing which one counts.
    seedTask({
      verify:
        'verify:\n  gates: [repo-lint]\n  gateDefinitions:\n    - id: repo-lint\n' +
        '      command: "sh -c \'exit 0\'"\n',
    });
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.status).toBe('error');
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['config']);
    expect(run?.gates[0].logTail).toContain('already declared in .commandmate/verify.yaml');
  });

  it('does not run the gates of a contract this run could not attach to', async () => {
    // findDetachedContract: the agent verified itself and closed its own task,
    // so this run is not about that contract — the same rule requireCommit
    // follows. Its gates must not silently attach to an unrelated run.
    const task = seedTask({ verify: FAILING_REPRO });
    updateTaskStatus(db, task.id, 'succeeded');
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.taskId).toBeNull();
    expect(run?.gates.map((gate) => gate.gateId)).not.toContain('issue-1791-repro');
  });
});

describe('contracts written before the field existed', () => {
  it('runs a stored contract whose verify block has no gateDefinitions key', async () => {
    // tasks.contract_json is JSON.parse'd straight back into a TaskContract with
    // no re-validation, so rows written before #1791 arrive with the key absent
    // rather than empty. Reading it as `undefined.length` would break every
    // pre-existing task the first time it verified.
    seedTask({
      verify: 'verify:\n  gates: [repo-lint]\n',
      mutate: (contract) => {
        delete (contract.verify as { gateDefinitions?: unknown }).gateDefinitions;
      },
    });
    addWork();

    const run = getVerificationRun(db, await runToCompletion());
    expect(run?.status).toBe('passed');
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([
      'work-evidence',
      'scope',
      'repo-lint',
    ]);
  });
});

describe('verify.yaml is read, never written', () => {
  it('leaves the file byte-identical across a run that used a contract gate', async () => {
    // The premise of 案 B: the whole point of carrying gates in the contract is
    // that the repository's own declaration of passing is not touched. A run
    // that rewrote it would put the change back in the work-evidence set.
    seedTask({ verify: PASSING_REPRO });
    addWork();

    const before = readFileSync(join(repo, '.commandmate', 'verify.yaml'));
    await runToCompletion();
    expect(readFileSync(join(repo, '.commandmate', 'verify.yaml')).equals(before)).toBe(true);
    expect(before.toString('utf8')).not.toContain('issue-1791-repro');
  });
});
