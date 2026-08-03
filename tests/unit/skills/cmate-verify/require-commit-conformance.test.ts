/**
 * `options.requireCommit` must mean the same thing in both implementations
 * (Issue #1639).
 *
 * There are two runners for one `.commandmate/verify.yaml`: the product engine
 * (`src/lib/verification/gate-runner.ts`) and the Phase 0 bash reference runner
 * shipped with the cmate-verify skill, which exists so a repository with no
 * CommandMate server — and no Node — can still run its gates. They read the same
 * file, so a repository that declares `requireCommit: true` and gets different
 * verdicts depending on which runner it happened to invoke is back to the defect
 * #1544 onwards has been closing: reporting a pass over something nobody looked
 * at.
 *
 * The test therefore runs BOTH against the same git sandbox and compares
 * verdicts, rather than asserting each one against a hand-written expectation.
 * A shared misunderstanding is the failure a per-implementation test cannot see.
 * (Same shape as the #1623 squeeze filter, which is pinned across its awk / TS /
 * Web UI implementations and did catch a real drift.)
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import {
  startVerification,
  waitForVerification,
  WORK_EVIDENCE_GATE_ID,
} from '@/lib/verification/gate-runner';
import { loadVerifyConfig } from '@/lib/verification/verify-config';

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

const RUNNER = join(process.cwd(), '.claude/skills/cmate-verify/scripts/verify-run.sh');
const BASE_REF = 'main';

/** verify.yaml exit codes the bash runner uses; see its header comment. */
const BASH_EXIT = { passed: 0, config: 2, failed: 20, notStarted: 21, skipped: 22 } as const;

let db: Database.Database;
const tempDirs: string[] = [];
let worktreeSeq = 0;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/**
 * A repo whose `work` branch starts level with `main`.
 *
 * `main` must stay a fixed point: with HEAD on the base branch, `merge-base`
 * follows every new commit and the commit count is 0 no matter what was done.
 *
 * `skipInPrimaryCheckout: false` because both runners would otherwise skip the
 * command gate here — the sandbox is a primary checkout by both definitions
 * (bash: git-dir === git-common-dir; TS: realpath === process.cwd(), which is
 * false here, and that asymmetry is not what this test is about).
 */
function createRepo(options: { requireCommit?: boolean }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'require-commit-conf-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'conformance@example.test'], dir);
  git(['config', 'user.name', 'Conformance'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(
    join(dir, '.commandmate', 'verify.yaml'),
    `version: 1
gates:
  - id: quick
    command: "sh -c 'exit 0'"
options:
  baseRef: ${BASE_REF}
  skipInPrimaryCheckout: false
${options.requireCommit === undefined ? '' : `  requireCommit: ${options.requireCommit}\n`}`
  );
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

function addUncommittedWork(dir: string): void {
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
}

function commitWork(dir: string, message = 'work'): void {
  git(['add', '-A'], dir);
  git(['commit', '-m', message], dir);
}

/** What both runners are compared on: did work-evidence pass, and did the run. */
interface Verdict {
  workEvidence: 'passed' | 'failed';
  run: 'passed' | 'not_started';
}

function runBash(repo: string): Verdict {
  const result = spawnSync('bash', [RUNNER, '--cwd', repo, '--base-ref', BASE_REF], {
    encoding: 'utf8',
  });
  const stdout = result.stdout ?? '';
  const detail = `exit=${result.status}\nstdout:\n${stdout}\nstderr:\n${result.stderr ?? ''}`;

  const gate = stdout.match(/^GATE work-evidence (PASS|FAIL) /m);
  expect(gate, `bash runner printed no work-evidence line.\n${detail}`).not.toBeNull();
  const verdict = stdout.match(/^RESULT (\w+)$/m);
  expect(verdict, `bash runner printed no verdict.\n${detail}`).not.toBeNull();

  // The exit code is the runner's real contract; a verdict line that disagreed
  // with it would make every assertion below meaningless.
  const expectedExit =
    verdict![1] === 'passed' ? BASH_EXIT.passed : (BASH_EXIT as Record<string, number>)[
      verdict![1] === 'not_started' ? 'notStarted' : verdict![1]
    ];
  expect(result.status, `exit code disagrees with RESULT.\n${detail}`).toBe(expectedExit);

  return {
    workEvidence: gate![1] === 'PASS' ? 'passed' : 'failed',
    run: verdict![1] as Verdict['run'],
  };
}

async function runTs(repo: string): Promise<Verdict> {
  worktreeSeq += 1;
  const worktreeId = `wt-conformance-${worktreeSeq}`;
  upsertWorktree(db, {
    id: worktreeId,
    name: `feature/${worktreeId}`,
    path: repo,
    repositoryPath: repo,
    repositoryName: 'conformance',
  });

  const { runId } = await startVerification({
    worktreeId,
    worktreePath: repo,
    trigger: 'manual',
  });
  await waitForVerification(runId);

  const run = getVerificationRun(db, runId);
  const gate = run?.gates.find((g) => g.gateId === WORK_EVIDENCE_GATE_ID);
  const detail = JSON.stringify(run?.gates.map((g) => [g.gateId, g.status, g.logTail]), null, 2);
  expect(gate, `TS runner recorded no work-evidence gate.\n${detail}`).toBeDefined();

  return {
    workEvidence: gate!.status as Verdict['workEvidence'],
    run: run!.status as Verdict['run'],
  };
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Each row is one repository state. `requireCommit: undefined` means the key is
 * absent from verify.yaml entirely, which is a distinct case from `false`: the
 * bash runner rejected the key outright before #1639, so "absent" was the only
 * shape it had ever seen.
 */
const MATRIX: Array<{
  name: string;
  requireCommit?: boolean;
  prepare: (repo: string) => void;
  expected: Verdict;
}> = [
  {
    name: 'key absent, uncommitted change only',
    prepare: addUncommittedWork,
    expected: { workEvidence: 'passed', run: 'passed' },
  },
  {
    name: 'requireCommit: false, uncommitted change only',
    requireCommit: false,
    prepare: addUncommittedWork,
    expected: { workEvidence: 'passed', run: 'passed' },
  },
  {
    name: 'requireCommit: true, uncommitted change only',
    requireCommit: true,
    prepare: addUncommittedWork,
    expected: { workEvidence: 'failed', run: 'not_started' },
  },
  {
    name: 'requireCommit: true, one commit and a clean tree',
    requireCommit: true,
    prepare: (repo) => {
      addUncommittedWork(repo);
      commitWork(repo);
    },
    expected: { workEvidence: 'passed', run: 'passed' },
  },
  {
    name: 'requireCommit: true, one commit plus further uncommitted work',
    requireCommit: true,
    prepare: (repo) => {
      addUncommittedWork(repo);
      commitWork(repo);
      writeFileSync(join(repo, 'more.txt'), 'still going\n');
    },
    expected: { workEvidence: 'passed', run: 'passed' },
  },
  {
    name: 'requireCommit: true, nothing at all',
    requireCommit: true,
    prepare: () => {},
    expected: { workEvidence: 'failed', run: 'not_started' },
  },
  {
    name: 'key absent, nothing at all',
    prepare: () => {},
    expected: { workEvidence: 'failed', run: 'not_started' },
  },
];

describe('options.requireCommit: the TS engine and the bash reference runner agree', () => {
  it.each(MATRIX)('$name', async ({ requireCommit, prepare, expected }) => {
    // One repository per cell, read by both runners, so the comparison cannot be
    // an artefact of two differently-prepared fixtures.
    const repo = createRepo({ requireCommit });
    prepare(repo);

    const bash = runBash(repo);
    const ts = await runTs(repo);

    expect(bash, 'bash runner disagrees with the expected verdict').toEqual(expected);
    expect(ts, 'TS runner disagrees with the expected verdict').toEqual(expected);
    expect(ts, 'the two implementations disagree with each other').toEqual(bash);
  });

  it('covers both verdicts and both settings, so the comparison is not trivially green', () => {
    expect(MATRIX.some((row) => row.expected.run === 'passed')).toBe(true);
    expect(MATRIX.some((row) => row.expected.run === 'not_started')).toBe(true);
    expect(MATRIX.some((row) => row.requireCommit === true)).toBe(true);
    expect(MATRIX.some((row) => row.requireCommit === undefined)).toBe(true);
  });

  it('rejects a non-boolean value in both implementations', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'require-commit-bad-')));
    tempDirs.push(repo);
    git(['init', '-b', 'main'], repo);
    mkdirSync(join(repo, '.commandmate'), { recursive: true });
    writeFileSync(
      join(repo, '.commandmate', 'verify.yaml'),
      `version: 1
gates:
  - id: quick
    command: "sh -c 'exit 0'"
options:
  requireCommit: maybe
`
    );

    const bash = spawnSync('bash', [RUNNER, '--cwd', repo, '--base-ref', BASE_REF], {
      encoding: 'utf8',
    });
    expect(bash.status).toBe(BASH_EXIT.config);
    expect(bash.stderr).toContain('options.requireCommit must be true or false');
    // Neither runner may emit a verdict for a config it could not read.
    expect(bash.stdout).not.toContain('RESULT');

    // The TS loader is a general YAML parser, so it reports the same violation
    // through VerifyConfigError rather than through an exit code.
    expect(() => loadVerifyConfig(repo)).toThrow(/options\.requireCommit: must be true or false/);
  });
});

/**
 * Known divergences, pinned rather than fixed here.
 *
 * A drift gate that only asserts agreement would go red the moment anyone looked
 * at these, and be cleared by deleting the case. Asserting the difference itself
 * keeps it a recorded decision: it cannot grow, and it cannot be forgotten.
 *
 * Neither is in scope for Issue #1639 (`options.requireCommit`); both predate it.
 */
describe('known work-evidence divergences between the two runners', () => {
  it('counts contract files as work in bash, and excludes them in TS (#1580, unported)', async () => {
    // TS excludes `.commandmate/tasks/` from both counters, so a worktree whose
    // only change is the orchestrator's own contract file reads as "the agent did
    // nothing". The bash runner has no such exclusion, so it reports work.
    //
    // This is the more permissive direction — bash says "there is work here" when
    // there is not — and it is the same class of defect requireCommit closes.
    // Porting it means reproducing the `-z -uall` entry-wise parse and the
    // `:(exclude,top)` pathspec in bash; that is a change to what work-evidence
    // counts, not to how requireCommit is read, so it is left for a follow-up.
    const repo = createRepo({});
    mkdirSync(join(repo, '.commandmate', 'tasks'), { recursive: true });
    writeFileSync(
      join(repo, '.commandmate', 'tasks', 'delegated.yaml'),
      'version: 1\ntitle: t\ngoal: g\n'
    );

    expect(runBash(repo)).toEqual({ workEvidence: 'passed', run: 'passed' });
    expect(await runTs(repo)).toEqual({ workEvidence: 'failed', run: 'not_started' });
  });

  it('counts an untracked directory once in bash and per file in TS (`-uall`)', async () => {
    // Only the reported number differs — both are > 0, so the verdict is the
    // same. Pinned because a future reader comparing the two summary lines will
    // otherwise read the mismatch as a bug in one of them.
    const repo = createRepo({});
    mkdirSync(join(repo, 'generated'), { recursive: true });
    writeFileSync(join(repo, 'generated', 'a.txt'), 'a\n');
    writeFileSync(join(repo, 'generated', 'b.txt'), 'b\n');

    const bash = spawnSync('bash', [RUNNER, '--cwd', repo, '--base-ref', BASE_REF], {
      encoding: 'utf8',
    });
    expect(bash.stdout).toContain('GATE work-evidence PASS commits=0 uncommitted=1');

    const worktreeId = 'wt-uall';
    upsertWorktree(db, {
      id: worktreeId,
      name: 'feature/uall',
      path: repo,
      repositoryPath: repo,
      repositoryName: 'conformance',
    });
    const { runId } = await startVerification({
      worktreeId,
      worktreePath: repo,
      trigger: 'manual',
    });
    await waitForVerification(runId);
    const gate = getVerificationRun(db, runId)?.gates.find(
      (g) => g.gateId === WORK_EVIDENCE_GATE_ID
    );
    expect(gate?.logTail).toContain('uncommitted=2');
    expect(gate?.status).toBe('passed');
  });
});
