/**
 * Unit tests for the verification gate runner (Issue #1543).
 *
 * These tests spawn real processes against real git repositories on purpose.
 * The two properties the runner exists to guarantee — *the verdict is the real
 * exit code* and *a skipped gate never reads as a pass* — are properties of
 * process handling, and a mocked `spawn` would assert only that the mock was
 * called the way the test author expected.
 *
 * Where a gate is expected NOT to run, the assertion is a sentinel file the
 * gate would have created. A status of `skipped` is a label the runner writes
 * about itself; the absent file is evidence.
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
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, listVerificationRuns, upsertWorktree } from '@/lib/db';
import type { VerificationGateResult } from '@/lib/db';
import {
  CONFIG_GATE_ID,
  MAX_CONCURRENT_VERIFICATIONS,
  startVerification,
  VerificationConflictError,
  waitForVerification,
  WORK_EVIDENCE_GATE_ID,
} from '@/lib/verification/gate-runner';

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

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/**
 * A repository whose `work` branch starts level with `main`.
 *
 * The base branch has to be a branch HEAD does not advance: with baseRef=main
 * and HEAD on main, `merge-base main HEAD` follows every new commit and the
 * commit count stays 0 forever, so a "commits ahead" test would pass for the
 * wrong reason.
 */
function createRepo(verifyYaml?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-runner-')));
  tempDirs.push(dir);

  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'gate-runner@example.test'], dir);
  git(['config', 'user.name', 'Gate Runner'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);

  writeFileSync(join(dir, 'README.md'), 'base\n');
  if (verifyYaml !== undefined) {
    mkdirSync(join(dir, '.commandmate'), { recursive: true });
    writeFileSync(join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
  }
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);

  return dir;
}

/** Give the worktree something to verify, so work-evidence passes. */
function addUncommittedWork(dir: string): void {
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
}

function registerWorktree(id: string, path: string): void {
  upsertWorktree(db, {
    id,
    name: `feature/${id}`,
    path,
    repositoryPath: path,
    repositoryName: 'fixture',
  });
}

function gatesById(runId: number): Map<string, VerificationGateResult> {
  const run = getVerificationRun(db, runId);
  return new Map((run?.gates ?? []).map((gate) => [gate.gateId, gate]));
}

/** Start a run and wait for its background execution to finish. */
async function runToCompletion(
  worktreeId: string,
  worktreePath: string,
  gateIds?: string[]
): Promise<number> {
  const { runId } = await startVerification({
    worktreeId,
    worktreePath,
    trigger: 'api',
    gateIds,
  });
  await waitForVerification(runId);
  return runId;
}

const PASSING_CONFIG = `
version: 1
gates:
  - id: first
    command: "sh -c 'exit 0'"
    timeoutSec: 30
  - id: second
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
`;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('startVerification — passing gates', () => {
  it('records every gate as passed and the run as passed', async () => {
    const repo = createRepo(PASSING_CONFIG);
    addUncommittedWork(repo);
    registerWorktree('wt-pass', repo);

    const runId = await runToCompletion('wt-pass', repo);

    const run = getVerificationRun(db, runId);
    expect(run?.status).toBe('passed');
    expect(run?.baseRef).toBe('main');
    expect(run?.trigger).toBe('api');
    expect(run?.finishedAt).not.toBeNull();

    const gates = gatesById(runId);
    expect([...gates.keys()]).toEqual([WORK_EVIDENCE_GATE_ID, 'first', 'second']);
    expect(gates.get('first')?.status).toBe('passed');
    expect(gates.get('first')?.exitCode).toBe(0);
    expect(gates.get('second')?.status).toBe('passed');
  });

  it('runs only the requested gates when gateIds is given', async () => {
    const repo = createRepo(PASSING_CONFIG);
    addUncommittedWork(repo);
    registerWorktree('wt-subset', repo);

    const runId = await runToCompletion('wt-subset', repo, [WORK_EVIDENCE_GATE_ID, 'second']);

    expect([...gatesById(runId).keys()]).toEqual([WORK_EVIDENCE_GATE_ID, 'second']);
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
  });
});

describe('startVerification — failure is recorded as failure', () => {
  it('stores the command exit code verbatim and still runs the later gates', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: failing
    command: "sh -c 'exit 3'"
    timeoutSec: 30
  - id: after-failure
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-fail', repo);

    const runId = await runToCompletion('wt-fail', repo);

    const gates = gatesById(runId);
    expect(gates.get('failing')?.status).toBe('failed');
    // 3, not 1 and not null: a runner that inferred failure from output rather
    // than reading $? would lose the distinction.
    expect(gates.get('failing')?.exitCode).toBe(3);
    // A failing gate must not end the run — one report should list every
    // problem instead of revealing them one round-trip at a time.
    expect(gates.get('after-failure')?.status).toBe('passed');
    expect(getVerificationRun(db, runId)?.status).toBe('failed');
  });

  it('does not let a passing gate after a failing one make the run passed', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: failing
    command: "sh -c 'exit 1'"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-fail-only', repo);

    const runId = await runToCompletion('wt-fail-only', repo);
    expect(getVerificationRun(db, runId)?.status).toBe('failed');
  });
});

describe('startVerification — command output handling', () => {
  it('merges stdout and stderr into log_tail', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: chatty
    command: "sh -c 'echo TO-STDOUT; echo TO-STDERR >&2'"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-log', repo);

    const runId = await runToCompletion('wt-log', repo);
    const logTail = gatesById(runId).get('chatty')?.logTail ?? '';
    expect(logTail).toContain('TO-STDOUT');
    expect(logTail).toContain('TO-STDERR');
  });

  it('exports CI=true to gate commands', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: env-probe
    command: "sh -c 'echo CI_SEEN=$CI'"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-env', repo);

    const runId = await runToCompletion('wt-env', repo);
    expect(gatesById(runId).get('env-probe')?.logTail).toContain('CI_SEEN=true');
  });

  it('keeps only the tail of the output, bounded by maxLogTailBytes', async () => {
    // Three writes of very different sizes, the middle one far larger than the
    // window. The retained tail therefore has to straddle a write boundary,
    // which is what distinguishes a byte-exact tail from an implementation that
    // merely evicts whole chunks (that one would keep only the last 11 bytes).
    const repo = createRepo(`
version: 1
gates:
  - id: verbose
    command: "sh -c 'printf HEAD-MARKER; printf %04000d 0; printf TAIL-MARKER'"
    timeoutSec: 30
options:
  baseRef: main
  maxLogTailBytes: 64
`);
    addUncommittedWork(repo);
    registerWorktree('wt-tail', repo);

    const runId = await runToCompletion('wt-tail', repo);
    const logTail = gatesById(runId).get('verbose')?.logTail ?? '';

    // Exactly the window, not merely within it: total output is ~4KB, so any
    // shortfall means legitimate tail bytes were thrown away.
    expect(Buffer.byteLength(logTail, 'utf8')).toBe(64);
    // The tail, not the head: a failing suite's useful part is its summary.
    expect(logTail.endsWith('TAIL-MARKER')).toBe(true);
    expect(logTail).not.toContain('HEAD-MARKER');
  });
});

describe('startVerification — timeout', () => {
  it('terminates a gate that outlives timeoutSec and records it as timeout', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: slow
    command: "sleep 30"
    timeoutSec: 1
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-timeout', repo);

    const runId = await runToCompletion('wt-timeout', repo);

    const gate = gatesById(runId).get('slow');
    expect(gate?.status).toBe('timeout');
    // A terminated gate reached no verdict of its own; recording the shell's
    // signal-derived code would look like the command decided something.
    expect(gate?.exitCode).toBeNull();
    // Proves the process was killed rather than waited out: `sleep 30` would
    // have taken 30s, and this test's own 5s budget would have expired first.
    expect(gate?.durationMs ?? Number.MAX_SAFE_INTEGER).toBeLessThan(4000);
    expect(getVerificationRun(db, runId)?.status).toBe('failed');
  });
});

describe('startVerification — work-evidence gate', () => {
  it('reports not_started and does not execute command gates when nothing changed', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: leaves-a-trace
    command: "sh -c 'echo ran > gate-marker.txt'"
    timeoutSec: 30
options:
  baseRef: main
`);
    registerWorktree('wt-empty', repo);

    const runId = await runToCompletion('wt-empty', repo);

    const run = getVerificationRun(db, runId);
    expect(run?.status).toBe('not_started');

    const gates = gatesById(runId);
    expect(gates.get(WORK_EVIDENCE_GATE_ID)?.status).toBe('failed');
    expect(gates.get(WORK_EVIDENCE_GATE_ID)?.exitCode).toBe(1);
    expect(gates.get('leaves-a-trace')?.status).toBe('skipped');
    // The skip is real, not just a label the runner wrote about itself.
    expect(existsSync(join(repo, 'gate-marker.txt'))).toBe(false);
  });

  it('passes on an uncommitted change alone', async () => {
    const repo = createRepo(PASSING_CONFIG);
    addUncommittedWork(repo);
    registerWorktree('wt-dirty', repo);

    const runId = await runToCompletion('wt-dirty', repo);

    const evidence = gatesById(runId).get(WORK_EVIDENCE_GATE_ID);
    expect(evidence?.status).toBe('passed');
    expect(evidence?.logTail).toContain('uncommitted=1');
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
  });

  it('passes on a commit ahead of baseRef with a clean tree', async () => {
    const repo = createRepo(PASSING_CONFIG);
    writeFileSync(join(repo, 'feature.txt'), 'done\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'feature'], repo);
    registerWorktree('wt-committed', repo);

    const runId = await runToCompletion('wt-committed', repo);

    const evidence = gatesById(runId).get(WORK_EVIDENCE_GATE_ID);
    expect(evidence?.status).toBe('passed');
    expect(evidence?.logTail).toContain('commits=1');
    expect(evidence?.logTail).toContain('uncommitted=0');
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
  });

  it('errors when no base ref can be resolved', async () => {
    // No options.baseRef and no origin remote, so origin/HEAD resolves nothing.
    const repo = createRepo(`
version: 1
gates:
  - id: never-runs
    command: "sh -c 'echo ran > gate-marker.txt'"
    timeoutSec: 30
`);
    addUncommittedWork(repo);
    registerWorktree('wt-no-base', repo);

    const runId = await runToCompletion('wt-no-base', repo);

    expect(getVerificationRun(db, runId)?.status).toBe('error');
    expect(gatesById(runId).get(WORK_EVIDENCE_GATE_ID)?.status).toBe('error');
    expect(existsSync(join(repo, 'gate-marker.txt'))).toBe(false);
  });
});

describe('startVerification — unusable configuration', () => {
  it('records error with the reason when verify.yaml is missing', async () => {
    const repo = createRepo();
    addUncommittedWork(repo);
    registerWorktree('wt-noconfig', repo);

    const runId = await runToCompletion('wt-noconfig', repo);

    expect(getVerificationRun(db, runId)?.status).toBe('error');
    const configGate = gatesById(runId).get(CONFIG_GATE_ID);
    expect(configGate?.status).toBe('error');
    expect(configGate?.logTail).toContain('.commandmate/verify.yaml');
  });

  it('records error with the validation issues when verify.yaml is invalid', async () => {
    const repo = createRepo(`
version: 2
gates:
  - id: whatever
    command: "true"
`);
    addUncommittedWork(repo);
    registerWorktree('wt-badconfig', repo);

    const runId = await runToCompletion('wt-badconfig', repo);

    expect(getVerificationRun(db, runId)?.status).toBe('error');
    expect(gatesById(runId).get(CONFIG_GATE_ID)?.logTail).toContain('version');
  });

  it('rejects unknown gate ids instead of silently running nothing', async () => {
    const repo = createRepo(PASSING_CONFIG);
    addUncommittedWork(repo);
    registerWorktree('wt-badgate', repo);

    const runId = await runToCompletion('wt-badgate', repo, ['no-such-gate']);

    // A run that checked nothing must never come back green.
    expect(getVerificationRun(db, runId)?.status).toBe('error');
    expect(gatesById(runId).get(CONFIG_GATE_ID)?.logTail).toContain('no-such-gate');
  });
});

describe('startVerification — primary checkout guard', () => {
  it('skips command gates when the worktree is the server working directory', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: destructive
    command: "sh -c 'echo ran > gate-marker.txt'"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-primary', repo);
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    const runId = await runToCompletion('wt-primary', repo);

    const gate = gatesById(runId).get('destructive');
    expect(gate?.status).toBe('skipped');
    expect(gate?.logTail).toContain('skipInPrimaryCheckout');
    expect(existsSync(join(repo, 'gate-marker.txt'))).toBe(false);
    // A skip is not a pass: reporting `passed` here would turn "we declined to
    // check" into "we checked and it was fine".
    expect(getVerificationRun(db, runId)?.status).toBe('error');
  });

  it('compares real paths, so a symlink to the working directory is still recognised', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: destructive
    command: "sh -c 'echo ran > gate-marker.txt'"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-symlink', repo);

    // macOS already serves /var as a symlink to /private/var, so a raw string
    // compare between cwd and worktreePath misses the guard exactly where the
    // guard matters most.
    const link = `${repo}-link`;
    symlinkSync(repo, link, 'dir');
    tempDirs.push(link);
    vi.spyOn(process, 'cwd').mockReturnValue(link);

    const runId = await runToCompletion('wt-symlink', repo);

    expect(gatesById(runId).get('destructive')?.status).toBe('skipped');
    expect(existsSync(join(repo, 'gate-marker.txt'))).toBe(false);
  });

  it('runs command gates in the primary checkout when the option is disabled', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: allowed
    command: "sh -c 'echo ran > gate-marker.txt'"
    timeoutSec: 30
options:
  baseRef: main
  skipInPrimaryCheckout: false
`);
    addUncommittedWork(repo);
    registerWorktree('wt-primary-off', repo);
    vi.spyOn(process, 'cwd').mockReturnValue(repo);

    const runId = await runToCompletion('wt-primary-off', repo);

    expect(gatesById(runId).get('allowed')?.status).toBe('passed');
    expect(existsSync(join(repo, 'gate-marker.txt'))).toBe(true);
    expect(getVerificationRun(db, runId)?.status).toBe('passed');
  });
});

describe('startVerification — concurrency', () => {
  it('rejects a second run while one is in flight for the same worktree', async () => {
    const repo = createRepo(`
version: 1
gates:
  - id: slow
    command: "sleep 1"
    timeoutSec: 30
options:
  baseRef: main
`);
    addUncommittedWork(repo);
    registerWorktree('wt-busy', repo);

    const { runId } = await startVerification({
      worktreeId: 'wt-busy',
      worktreePath: repo,
      trigger: 'api',
    });

    await expect(
      startVerification({ worktreeId: 'wt-busy', worktreePath: repo, trigger: 'manual' })
    ).rejects.toBeInstanceOf(VerificationConflictError);

    await expect(
      startVerification({ worktreeId: 'wt-busy', worktreePath: repo, trigger: 'manual' })
    ).rejects.toMatchObject({ runningRunId: runId });

    await waitForVerification(runId);

    // The conflict is transient, not a permanent lock on the worktree.
    const second = await startVerification({
      worktreeId: 'wt-busy',
      worktreePath: repo,
      trigger: 'manual',
    });
    await waitForVerification(second.runId);
    expect(listVerificationRuns(db, 'wt-busy')).toHaveLength(2);
  });

  it(`never runs more than ${MAX_CONCURRENT_VERIFICATIONS} runs at once`, async () => {
    const repo = createRepo();
    addUncommittedWork(repo);
    const eventLog = join(repo, 'events.log');

    // Three separate worktrees so the per-worktree conflict guard is not what
    // limits concurrency here — only the global semaphore is under test.
    const ids = ['wt-c1', 'wt-c2', 'wt-c3'];
    mkdirSync(join(repo, '.commandmate'), { recursive: true });
    writeFileSync(
      join(repo, '.commandmate', 'verify.yaml'),
      `
version: 1
gates:
  - id: marker
    command: "sh -c 'echo start >> ${eventLog}; sleep 0.4; echo end >> ${eventLog}'"
    timeoutSec: 30
options:
  baseRef: main
`
    );
    for (const id of ids) registerWorktree(id, repo);

    const runIds = await Promise.all(
      ids.map(async (id) => (await startVerification({ worktreeId: id, worktreePath: repo, trigger: 'api' })).runId)
    );
    await Promise.all(runIds.map((runId) => waitForVerification(runId)));

    for (const runId of runIds) {
      expect(gatesById(runId).get('marker')?.status).toBe('passed');
    }

    let depth = 0;
    let maxDepth = 0;
    for (const line of readFileSync(eventLog, 'utf8').split('\n')) {
      if (line === 'start') maxDepth = Math.max(maxDepth, ++depth);
      else if (line === 'end') depth -= 1;
    }
    // Literal 2, not MAX_CONCURRENT_VERIFICATIONS: asserting against the same
    // constant the runner reads makes the test agree with any value the
    // constant is changed to, including one that removes the limit.
    expect(MAX_CONCURRENT_VERIFICATIONS).toBe(2);
    expect(maxDepth).toBe(2);
  });
});
