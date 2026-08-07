/**
 * The `env-clean` gate inside a real verification run (Issue #1740).
 *
 * Asserted against recorded gate rows and run statuses rather than against the
 * evaluator's return value: what the Issue asks for is that a delegation which
 * broke the machine cannot collect a green run, and only the recorded verdict
 * proves that.
 *
 * Only the two functions that touch the real machine are stubbed
 * (`captureEnvSnapshot`, `loadEnvSnapshot`); the diff, the attribution and the
 * whole runner are real. No port is opened, no tmux server is contacted and no
 * home directory is read.
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
import { createTask, getVerificationRun, upsertWorktree, type Task } from '@/lib/db';
import { parseTaskContract, type TaskContract } from '@/lib/tasks/contract-parser';
import { startVerification, waitForVerification } from '@/lib/verification/gate-runner';
import { ENV_CLEAN_GATE_ID } from '@/lib/verification/verify-config';
import {
  ENV_SNAPSHOT_VERSION,
  type EnvProbeId,
  type EnvProbeResult,
  type EnvSnapshot,
} from '@/lib/verification/env-snapshot';
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

/** Baselines keyed by task id, and the snapshot the "current" probe returns. */
const baselines = new Map<string, EnvSnapshot>();
let currentSnapshot: EnvSnapshot | null = null;
let captureCalls = 0;

vi.mock('@/lib/verification/env-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/verification/env-snapshot')>();
  return {
    ...actual,
    loadEnvSnapshot: (taskId: string) => baselines.get(taskId) ?? null,
    captureEnvSnapshot: async () => {
      captureCalls += 1;
      if (!currentSnapshot) throw new Error('probe host unavailable');
      return currentSnapshot;
    },
  };
});

let db: Database.Database;
let repo: string;
const wtId = 'wt-env-clean';
const tempDirs: string[] = [];

const EMPTY_PROBE: EnvProbeResult = { status: 'ok', entries: [], reason: null };

function snapshot(overrides: Partial<Record<EnvProbeId, EnvProbeResult>> = {}): EnvSnapshot {
  return {
    version: ENV_SNAPSHOT_VERSION,
    capturedAt: 1_700_000_000_000,
    worktreeId: wtId,
    probes: {
      listeners: EMPTY_PROBE,
      'tmux-sessions': EMPTY_PROBE,
      'home-entries': EMPTY_PROBE,
      'commandmate-entries': EMPTY_PROBE,
      ...overrides,
    },
  };
}

function listing(keys: string[]): EnvProbeResult {
  return {
    status: 'ok',
    entries: keys.map((key) => ({ key, detail: null, anchor: null })),
    reason: null,
  };
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/**
 * A repository whose verify.yaml is already committed on `main`.
 *
 * Committed, not written afterwards: `.commandmate/verify.yaml` is deliberately
 * *not* excluded from the change set (only `.commandmate/tasks/` is), so leaving
 * it uncommitted would make work-evidence pass on the fixture's own config and
 * the "there was nothing to verify" case unreachable.
 */
function setupRepo(extraOptions = ''): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'env-clean-verify-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'env@example.test'], dir);
  git(['config', 'user.name', 'Env'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(
    join(dir, '.commandmate', 'verify.yaml'),
    `version: 1
gates:
  - id: pass-gate
    command: "sh -c 'exit 0'"
options:
  baseRef: main
  skipInPrimaryCheckout: false
${extraOptions}`
  );
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);

  repo = dir;
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/env-clean',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
}

function addWork(): void {
  writeFileSync(join(repo, 'work.txt'), 'agent output\n');
}

function seedTask(options: { requireEnvClean?: boolean } = {}): Task {
  const parsed = parseTaskContract(
    `version: 1
title: env-clean run
goal: do the work
scope:
  allow: ["**"]
`,
    'task.yaml'
  );
  // `success.requireEnvClean` cannot be spelled in YAML yet: SUCCESS_KEYS in
  // lib/tasks/contract-parser.ts is a closed set and that file is outside this
  // delegation's scope.allow. The stored contract is JSON, so the key survives
  // the round trip and the resolver reads it — which is what makes this the
  // behaviour the parser change will switch on, not a mock of it.
  const contract =
    options.requireEnvClean === undefined
      ? parsed
      : ({
          ...parsed,
          success: { ...parsed.success, requireEnvClean: options.requireEnvClean },
        } as TaskContract);

  return createTask(db, {
    worktreeId: wtId,
    cliToolId: 'claude',
    contractPath: '.commandmate/tasks/t.yaml',
    contract,
    status: 'running',
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
  return getVerificationRun(db, runId);
}

function envCleanGate(run: ReturnType<typeof getVerificationRun>) {
  return run?.gates.find((gate) => gate.gateId === ENV_CLEAN_GATE_ID);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  baselines.clear();
  currentSnapshot = snapshot();
  captureCalls = 0;

  setupRepo();
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('default is off', () => {
  it('does not run, record or even probe env-clean when nothing declares it', async () => {
    seedTask();
    addWork();

    const run = await runToCompletion();
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['work-evidence', 'scope', 'pass-gate']);
    expect(run?.status).toBe('passed');
    expect(captureCalls).toBe(0);
  });

  it('stays off for a contract that explicitly declines it', async () => {
    const task = seedTask({ requireEnvClean: false });
    addWork();

    const run = await runToCompletion({ taskId: task.id });
    expect(envCleanGate(run)).toBeUndefined();
    expect(run?.status).toBe('passed');
  });
});

describe('repository-wide opt-in (options.requireEnvClean)', () => {
  beforeEach(() => {
    setupRepo('  requireEnvClean: true\n');
  });

  it('passes when the machine is exactly as the task found it', async () => {
    const task = seedTask();
    baselines.set(task.id, snapshot({ listeners: listing(['tcp/3000']) }));
    currentSnapshot = snapshot({ listeners: listing(['tcp/3000']) });
    addWork();

    const run = await runToCompletion({ taskId: task.id });
    expect(envCleanGate(run)?.status).toBe('passed');
    expect(run?.status).toBe('passed');
  });

  it('fails the run when a server was left listening', async () => {
    const task = seedTask();
    baselines.set(task.id, snapshot());
    currentSnapshot = snapshot({ listeners: listing(['tcp/3779']) });
    addWork();

    const run = await runToCompletion({ taskId: task.id });
    expect(envCleanGate(run)?.status).toBe('failed');
    expect(envCleanGate(run)?.logTail).toContain('tcp/3779');
    expect(run?.status).toBe('failed');
  });

  it('fails the run when a session that existed at task start is gone', async () => {
    const task = seedTask();
    baselines.set(task.id, snapshot({ 'tmux-sessions': listing(['mcbd-claude-other-wt']) }));
    currentSnapshot = snapshot();
    addWork();

    const run = await runToCompletion({ taskId: task.id });
    expect(envCleanGate(run)?.status).toBe('failed');
    expect(run?.status).toBe('failed');
  });

  it('reports UNKNOWN and fails the run when no baseline was recorded', async () => {
    const task = seedTask();
    addWork();

    const run = await runToCompletion({ taskId: task.id });
    const gate = envCleanGate(run);
    expect(gate?.status).toBe('error');
    expect(gate?.status).not.toBe('passed');
    expect(gate?.logTail).toContain('UNKNOWN');
    expect(run?.status).toBe('failed');
  });

  it('reports UNKNOWN and fails the run when a probe could not answer', async () => {
    const task = seedTask();
    baselines.set(task.id, snapshot());
    currentSnapshot = snapshot({
      listeners: { status: 'unavailable', entries: [], reason: 'lsof could not be run' },
    });
    addWork();

    const run = await runToCompletion({ taskId: task.id });
    expect(envCleanGate(run)?.status).toBe('error');
    expect(envCleanGate(run)?.logTail).toContain('lsof could not be run');
    expect(run?.status).toBe('failed');
  });

  it('records env-clean as not run when there was no work to verify', async () => {
    const task = seedTask();
    baselines.set(task.id, snapshot());

    const run = await runToCompletion({ taskId: task.id });
    expect(run?.status).toBe('not_started');
    expect(envCleanGate(run)?.status).toBe('skipped');
    expect(captureCalls).toBe(0);
  });
});

describe('per-delegation opt-in (success.requireEnvClean)', () => {
  it('runs the gate from the contract alone, with the repository switch off', async () => {
    const task = seedTask({ requireEnvClean: true });
    baselines.set(task.id, snapshot());
    currentSnapshot = snapshot({ 'home-entries': listing(['.commandmate-uat-1726']) });
    addWork();

    const run = await runToCompletion({ taskId: task.id });
    expect(envCleanGate(run)?.status).toBe('failed');
    expect(envCleanGate(run)?.logTail).toContain('.commandmate-uat-1726');
    expect(run?.status).toBe('failed');
  });

  it('survives a contract that names a narrower gate list', async () => {
    const task = seedTask({ requireEnvClean: true });
    baselines.set(task.id, snapshot());
    addWork();

    // gateIds names only pass-gate; the declared requirement still adds env-clean,
    // so a delegation cannot lose the gate by listing gates.
    const run = await runToCompletion({ taskId: task.id, gateIds: ['pass-gate'] });
    expect(envCleanGate(run)).toBeDefined();
  });
});

describe('explicit --gates env-clean', () => {
  it('is accepted as a gate id and reports UNKNOWN without a baseline', async () => {
    seedTask();
    addWork();

    const run = await runToCompletion({ gateIds: [ENV_CLEAN_GATE_ID] });
    const gate = envCleanGate(run);
    expect(gate?.status).toBe('error');
    expect(gate?.logTail).toContain('no baseline snapshot exists');
    expect(run?.status).toBe('failed');
  });

  it('is a real selection, so it is not rejected as "no gates"', async () => {
    seedTask();
    addWork();

    const run = await runToCompletion({ gateIds: [ENV_CLEAN_GATE_ID] });
    expect(run?.gates.map((gate) => gate.gateId)).toEqual([ENV_CLEAN_GATE_ID]);
  });
});
