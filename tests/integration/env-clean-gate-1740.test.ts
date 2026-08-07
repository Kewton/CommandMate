/**
 * Issue #1740: the send → verify seam for the `env-clean` gate.
 *
 * What the unit suites cannot show is that the two halves meet: the baseline is
 * recorded by the route that creates the task, stored on disk, and read back by
 * a verification run started minutes later against the same task id. A gate that
 * works on hand-built snapshots and never receives the one the route wrote would
 * pass every unit test and report UNKNOWN forever in production.
 *
 * The persistence is real (a temp directory, never `~/.commandmate`), the route
 * is real, the runner is real, the git repository is real. Only the four probes
 * are stubbed — reading the machine's actual ports, tmux server and home
 * directory would make the suite non-deterministic and, for tmux, would reach
 * the developer's own sessions.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
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

/** Where snapshots are written for this suite; never the real state directory. */
let snapshotDir = '';
/** What the (stubbed) probes report right now. */
let machine: EnvSnapshot | null = null;

vi.mock('@/lib/verification/env-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/verification/env-snapshot')>();
  return {
    ...actual,
    // Real persistence, redirected: the JSON round trip is part of what this
    // suite is here to prove.
    saveEnvSnapshot: (taskId: string, snapshot: EnvSnapshot) =>
      actual.saveEnvSnapshot(taskId, snapshot, snapshotDir),
    loadEnvSnapshot: (taskId: string) => actual.loadEnvSnapshot(taskId, snapshotDir),
    captureEnvSnapshot: async () => {
      if (!machine) throw new Error('probe host unavailable');
      return machine;
    },
  };
});

let db: Database.Database;
let repo: string;
const wtId = 'wt-env-1740';
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

const EMPTY_PROBE: EnvProbeResult = { status: 'ok', entries: [], reason: null };

function listing(keys: string[]): EnvProbeResult {
  return {
    status: 'ok',
    entries: keys.map((key) => ({ key, detail: null, anchor: null })),
    reason: null,
  };
}

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

const CONTRACT = `version: 1
title: "env-clean delegation"
goal: |
  Do the work without breaking the machine.
scope:
  allow: ["**"]
`;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(requireEnvClean: boolean): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'env-clean-seam-')));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.commandmate', 'tasks'), { recursive: true });
  writeFileSync(
    join(dir, '.commandmate', 'verify.yaml'),
    `version: 1
gates:
  - id: pass-gate
    command: "sh -c 'exit 0'"
options:
  baseRef: main
  skipInPrimaryCheckout: false
${requireEnvClean ? '  requireEnvClean: true\n' : ''}`
  );
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'env@example.test'], dir);
  git(['config', 'user.name', 'Env'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

function useRepo(requireEnvClean: boolean): void {
  repo = createRepo(requireEnvClean);
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/env-clean',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
}

/** Create the task the way `send --contract` does: through the route. */
async function sendContract(): Promise<string> {
  writeFileSync(join(repo, '.commandmate', 'tasks', 'task.yaml'), CONTRACT);
  const { POST } = await import('@/app/api/worktrees/[id]/tasks/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${wtId}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contractPath: '.commandmate/tasks/task.yaml' }),
      })
    ),
    { params: Promise.resolve({ id: wtId }) }
  );
  expect(response.status).toBe(201);
  return (await response.json()).task.id as string;
}

function agentDidSomeWork(): void {
  writeFileSync(join(repo, 'work.txt'), 'agent output\n');
}

async function verify(taskId: string) {
  const { runId } = await startVerification({
    worktreeId: wtId,
    worktreePath: repo,
    trigger: 'wait',
    taskId,
  });
  await waitForVerification(runId);
  return getVerificationRun(db, runId);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  snapshotDir = mkdtempSync(join(tmpdir(), 'env-clean-store-'));
  tempDirs.push(snapshotDir);
  machine = snapshot({ listeners: listing(['tcp/3000']) });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('baseline capture at task creation', () => {
  it('records nothing while the gate is switched off', async () => {
    useRepo(false);
    const taskId = await sendContract();

    expect(readdirSync(snapshotDir)).toEqual([]);
    expect(existsSync(join(snapshotDir, `${taskId}.json`))).toBe(false);
  });

  it('records the baseline once the gate is switched on', async () => {
    useRepo(true);
    const taskId = await sendContract();

    expect(existsSync(join(snapshotDir, `${taskId}.json`))).toBe(true);
  });

  it('still creates the task when the probes cannot answer at all', async () => {
    useRepo(true);
    machine = null;

    const taskId = await sendContract();
    // No baseline, and the send succeeded — the failure surfaces as UNKNOWN at
    // verification time rather than blocking the delegation.
    expect(existsSync(join(snapshotDir, `${taskId}.json`))).toBe(false);
  });
});

describe('send → verify', () => {
  it('passes when the machine is handed back as it was found', async () => {
    useRepo(true);
    const taskId = await sendContract();
    agentDidSomeWork();

    const run = await verify(taskId);
    expect(run?.gates.find((gate) => gate.gateId === ENV_CLEAN_GATE_ID)?.status).toBe('passed');
    expect(run?.status).toBe('passed');
  });

  it('fails when a server started during the task is still listening', async () => {
    useRepo(true);
    const taskId = await sendContract();
    agentDidSomeWork();
    machine = snapshot({ listeners: listing(['tcp/3000', 'tcp/3779']) });

    const run = await verify(taskId);
    const gate = run?.gates.find((entry) => entry.gateId === ENV_CLEAN_GATE_ID);
    expect(gate?.status).toBe('failed');
    expect(gate?.logTail).toContain('+ tcp/3779');
    expect(run?.status).toBe('failed');
  });

  it('fails when the production server that was running is gone', async () => {
    useRepo(true);
    const taskId = await sendContract();
    agentDidSomeWork();
    machine = snapshot();

    const run = await verify(taskId);
    const gate = run?.gates.find((entry) => entry.gateId === ENV_CLEAN_GATE_ID);
    expect(gate?.status).toBe('failed');
    expect(gate?.logTail).toContain('- tcp/3000');
    expect(run?.status).toBe('failed');
  });

  it('reports UNKNOWN — never a pass — when the send never recorded a baseline', async () => {
    useRepo(true);
    machine = null;
    const taskId = await sendContract();
    machine = snapshot({ listeners: listing(['tcp/3000']) });
    agentDidSomeWork();

    const run = await verify(taskId);
    const gate = run?.gates.find((entry) => entry.gateId === ENV_CLEAN_GATE_ID);
    expect(gate?.status).not.toBe('passed');
    expect(gate?.logTail).toContain('UNKNOWN');
    expect(run?.status).toBe('failed');
  });

  it('leaves the run untouched while the gate is off, even on a broken machine', async () => {
    useRepo(false);
    const taskId = await sendContract();
    agentDidSomeWork();
    machine = snapshot({ 'home-entries': listing(['.commandmate-uat-1726']) });

    const run = await verify(taskId);
    expect(run?.gates.map((gate) => gate.gateId)).toEqual(['work-evidence', 'scope', 'pass-gate']);
    expect(run?.status).toBe('passed');
  });
});
