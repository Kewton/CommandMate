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
 * Issue #2442 extends the same seam in three directions and adds the case the
 * incidents were actually about — a tmux session that existed when the task began
 * and is gone by verification time:
 *
 *   - the contract's own `success.requireEnvClean` now parses, so the switch works
 *     per delegation and not only per repository;
 *   - a contract may select the gate by naming it in `verify.gates`, which has to
 *     record a baseline even though both booleans are false;
 *   - this repository's `.commandmate/verify.yaml` turns the option on, asserted
 *     here against the real file rather than a fixture.
 *
 * Issue #2472 closes the case that made every delegation into an idle worktree
 * fail: the route writes the baseline before the send starts the agent's
 * session, so the route now records that session's name in the baseline and the
 * gate excuses exactly that one addition — asserted through the stored file.
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
import { join, resolve as resolvePath } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import { startVerification, waitForVerification } from '@/lib/verification/gate-runner';
import {
  defaultPlannedGateIds,
  ENV_CLEAN_GATE_ID,
  loadVerifyConfig,
} from '@/lib/verification/verify-config';
import { MCBD_SESSION_PREFIX } from '@/lib/verification/env-snapshot';
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

/**
 * Create the task the way `send --contract` does: through the route, naming the
 * agent and instance the way the CLI does when `--agent` / `--instance` is given.
 */
async function sendContract(
  source: string = CONTRACT,
  target: { cliToolId?: string; instanceId?: string } = {}
): Promise<string> {
  writeFileSync(join(repo, '.commandmate', 'tasks', 'task.yaml'), source);
  const { POST } = await import('@/app/api/worktrees/[id]/tasks/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${wtId}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contractPath: '.commandmate/tasks/task.yaml', ...target }),
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

// =============================================================================
// Issue #2442
// =============================================================================

/** A worker's tmux session, named the way `lib/tmux` names them. */
const OTHER_WORKER_SESSION = `${MCBD_SESSION_PREFIX}claude-wt-other-2442`;
const OWN_SESSION = `${MCBD_SESSION_PREFIX}claude-${wtId}`;

/** The contract spellings #2442 opened, each as the only thing switching the gate on. */
const CONTRACT_SUCCESS_FLAG = `${CONTRACT}success:
  requireEnvClean: true
`;
const CONTRACT_NAMING_THE_GATE = `${CONTRACT}verify:
  gates: [env-clean, pass-gate]
`;
const CONTRACT_SAYING_FALSE = `${CONTRACT}success:
  requireEnvClean: false
`;

describe('the tmux wipe this gate exists for (#1624, 2026-09-08)', () => {
  it('fails the run when a session that existed at task start is gone', async () => {
    // The shape of both incidents: a socket-less `kill-server` takes down every
    // `mcbd-*` session on the machine, including other workers'. Nothing inside
    // the repository changed, so `scope` and `work-evidence` are both green — this
    // gate is the only one that can see it.
    useRepo(true);
    machine = snapshot({
      listeners: listing(['tcp/3000']),
      'tmux-sessions': listing([OWN_SESSION, OTHER_WORKER_SESSION]),
    });
    const taskId = await sendContract();
    agentDidSomeWork();

    machine = snapshot({ listeners: listing(['tcp/3000']), 'tmux-sessions': listing([]) });

    const run = await verify(taskId);
    const gate = run?.gates.find((entry) => entry.gateId === ENV_CLEAN_GATE_ID);
    expect(gate?.status).toBe('failed');
    // Both losses are named: a removal is a violation whoever owned it.
    expect(gate?.logTail).toContain(`- ${OWN_SESSION}`);
    expect(gate?.logTail).toContain(`- ${OTHER_WORKER_SESSION}`);
    expect(run?.status).toBe('failed');
    expect(run?.gates.find((entry) => entry.gateId === 'scope')?.status).toBe('passed');
  });

  it('compares against the stored baseline after the agent is gone', async () => {
    // The row the Issue's table calls "the agent died, the verification server did
    // not". The baseline is a file, not memory, so the comparison survives the
    // session it describes — which is the only reason a wipe can be attributed at
    // all. Verified by reading it off disk between the two halves of the run.
    useRepo(true);
    machine = snapshot({ 'tmux-sessions': listing([OWN_SESSION]) });
    const taskId = await sendContract();

    const stored = JSON.parse(readFileSync(join(snapshotDir, `${taskId}.json`), 'utf-8'));
    expect(stored.probes['tmux-sessions'].entries.map((e: { key: string }) => e.key)).toEqual([
      OWN_SESSION,
    ]);

    agentDidSomeWork();
    machine = snapshot({ 'tmux-sessions': listing([]) });

    expect((await verify(taskId))?.status).toBe('failed');
  });

  it('produces no result at all when verification is never started', async () => {
    // The last row of the Issue's table, stated rather than wished away: if the
    // verification server is gone too, nothing runs and nothing is written. This
    // gate is a detector, not a watchdog — it cannot report on a run that never
    // happened, and must not be described as if it could.
    useRepo(true);
    machine = snapshot({ 'tmux-sessions': listing([OWN_SESSION]) });
    const taskId = await sendContract();
    machine = snapshot({ 'tmux-sessions': listing([]) });

    // The baseline is on disk and still readable; there is simply no verdict.
    expect(existsSync(join(snapshotDir, `${taskId}.json`))).toBe(true);
    expect(getVerificationRun(db, 1)).toBeNull();
  });
});

describe('the contract can switch the gate on by itself (#2442)', () => {
  it('records a baseline from success.requireEnvClean alone', async () => {
    // Before #2442 the parser refused this key outright (400 at send).
    useRepo(false);
    const taskId = await sendContract(CONTRACT_SUCCESS_FLAG);

    expect(existsSync(join(snapshotDir, `${taskId}.json`))).toBe(true);
  });

  it('runs the gate and fails on a wipe from success.requireEnvClean alone', async () => {
    useRepo(false);
    machine = snapshot({ 'tmux-sessions': listing([OWN_SESSION]) });
    const taskId = await sendContract(CONTRACT_SUCCESS_FLAG);
    agentDidSomeWork();
    machine = snapshot({ 'tmux-sessions': listing([]) });

    const run = await verify(taskId);
    expect(run?.gates.find((entry) => entry.gateId === ENV_CLEAN_GATE_ID)?.status).toBe('failed');
    expect(run?.status).toBe('failed');
  });

  it('records a baseline from verify.gates: [env-clean] with both booleans false', async () => {
    // The seam that had to move with the gate id. Opening the id in
    // `validateContractAgainstVerifyConfig` without teaching `recordEnvBaseline`
    // about it would produce a gate that runs and can only ever say UNKNOWN.
    useRepo(false);
    machine = snapshot({ 'tmux-sessions': listing([OWN_SESSION]) });
    const taskId = await sendContract(CONTRACT_NAMING_THE_GATE);

    expect(existsSync(join(snapshotDir, `${taskId}.json`))).toBe(true);

    agentDidSomeWork();
    machine = snapshot({ 'tmux-sessions': listing([]) });

    const run = await verify(taskId);
    const gate = run?.gates.find((entry) => entry.gateId === ENV_CLEAN_GATE_ID);
    expect(gate?.status).toBe('failed');
    // Specifically NOT the UNKNOWN this test exists to rule out.
    expect(gate?.logTail).not.toContain('UNKNOWN');
    expect(run?.status).toBe('failed');
  });

  it('passes that same contract when the machine is handed back intact', async () => {
    // Mutation control for the test above: a gate that failed no matter what
    // would have satisfied it too.
    useRepo(false);
    machine = snapshot({ 'tmux-sessions': listing([OWN_SESSION]) });
    const taskId = await sendContract(CONTRACT_NAMING_THE_GATE);
    agentDidSomeWork();

    const run = await verify(taskId);
    expect(run?.gates.find((entry) => entry.gateId === ENV_CLEAN_GATE_ID)?.status).toBe('passed');
    expect(run?.status).toBe('passed');
  });

  it('cannot switch OFF a gate the repository declared', async () => {
    // `success.requireEnvClean: false` against `options.requireEnvClean: true`.
    // A contract may only ever tighten; letting it relax the repository's rule
    // would reopen the hole one delegation at a time.
    useRepo(true);
    machine = snapshot({ 'tmux-sessions': listing([OWN_SESSION]) });
    const taskId = await sendContract(CONTRACT_SAYING_FALSE);

    expect(existsSync(join(snapshotDir, `${taskId}.json`))).toBe(true);

    agentDidSomeWork();
    machine = snapshot({ 'tmux-sessions': listing([]) });

    expect((await verify(taskId))?.status).toBe('failed');
  });
});

describe('this repository has the option switched on (#2442)', () => {
  it('declares options.requireEnvClean in its own verify.yaml', () => {
    // Read off the real file, through the real loader. A fixture asserting the
    // same thing would pass with the repository's own switch left off — which is
    // exactly the state this Issue exists to change.
    const config = loadVerifyConfig(resolvePath(__dirname, '..', '..'));

    expect(config).not.toBeNull();
    expect(config?.options.requireEnvClean).toBe(true);
  });

  it("adds env-clean to this repository's default gate set", () => {
    // The switch has to reach the planner, not only the loader: `defaultPlannedGateIds`
    // is what the pane's progress denominator and the re-run list are built from.
    const config = loadVerifyConfig(resolvePath(__dirname, '..', '..'));

    expect(config).not.toBeNull();
    expect(defaultPlannedGateIds(config!)).toContain(ENV_CLEAN_GATE_ID);
  });
});

// =============================================================================
// Issue #2472
// =============================================================================

describe('the delegation’s own agent session (#2472)', () => {
  const CODEX_SESSION = `${MCBD_SESSION_PREFIX}codex-${wtId}`;

  function storedTaskSession(taskId: string): unknown {
    return JSON.parse(readFileSync(join(snapshotDir, `${taskId}.json`), 'utf-8')).taskSession;
  }

  function envCleanGate(run: Awaited<ReturnType<typeof verify>>) {
    return run?.gates.find((entry) => entry.gateId === ENV_CLEAN_GATE_ID);
  }

  it('passes when the only new session is the one the send started', async () => {
    // The #2470 shape. No session is running when the task is created, so the
    // session `send` starts right after is not in the baseline. Before #2472
    // this was exit 20 on a single `+ mcbd-claude-<wt> [self]` line, with
    // nothing wrong with the work.
    useRepo(true);
    machine = snapshot({ listeners: listing(['tcp/3000']), 'tmux-sessions': listing([]) });
    const taskId = await sendContract();
    expect(storedTaskSession(taskId)).toBe(OWN_SESSION);

    // What `send` does next in an idle worktree: start the agent's session.
    machine = snapshot({
      listeners: listing(['tcp/3000']),
      'tmux-sessions': listing([OWN_SESSION]),
    });
    agentDidSomeWork();

    const run = await verify(taskId);
    expect(envCleanGate(run)?.status).toBe('passed');
    expect(envCleanGate(run)?.logTail).toContain(`+ ${OWN_SESSION} [task session, excused]`);
    expect(run?.status).toBe('passed');
  });

  it('records the instance the task was sent to, and excuses only that one', async () => {
    useRepo(true);
    const taskId = await sendContract(CONTRACT, { cliToolId: 'claude', instanceId: 'claude-2' });
    expect(storedTaskSession(taskId)).toBe(`${OWN_SESSION}-2`);

    machine = snapshot({
      listeners: listing(['tcp/3000']),
      'tmux-sessions': listing([`${OWN_SESSION}-2`, OWN_SESSION]),
    });
    agentDidSomeWork();

    const run = await verify(taskId);
    expect(envCleanGate(run)?.status).toBe('failed');
    expect(envCleanGate(run)?.logTail).toContain(`+ ${OWN_SESSION} [self]`);
    expect(envCleanGate(run)?.logTail).toContain(`+ ${OWN_SESSION}-2 [task session, excused]`);
    expect(run?.status).toBe('failed');
  });

  it('still fails when the worker started another session in its own worktree', async () => {
    useRepo(true);
    const taskId = await sendContract();

    machine = snapshot({
      listeners: listing(['tcp/3000']),
      'tmux-sessions': listing([OWN_SESSION, CODEX_SESSION]),
    });
    agentDidSomeWork();

    const run = await verify(taskId);
    expect(envCleanGate(run)?.status).toBe('failed');
    expect(envCleanGate(run)?.logTail).toContain(`+ ${CODEX_SESSION} [self]`);
    expect(run?.status).toBe('failed');
  });

  it('still fails when the task’s own session is gone', async () => {
    // Excusing its addition must not become excusing its removal: a session
    // that was there at send time and is gone at verification is the #1624 wipe.
    useRepo(true);
    machine = snapshot({
      listeners: listing(['tcp/3000']),
      'tmux-sessions': listing([OWN_SESSION]),
    });
    const taskId = await sendContract();
    expect(storedTaskSession(taskId)).toBe(OWN_SESSION);

    machine = snapshot({ listeners: listing(['tcp/3000']), 'tmux-sessions': listing([]) });
    agentDidSomeWork();

    const run = await verify(taskId);
    expect(envCleanGate(run)?.status).toBe('failed');
    expect(envCleanGate(run)?.logTail).toContain(`- ${OWN_SESSION}`);
    expect(run?.status).toBe('failed');
  });
});
