/**
 * Issue #3633: the orchestrator's module-reference fold commit (orchestrate
 * 6-4, trailer `Orchestrator-Fold: module-reference`) is not the worker's work.
 *
 * The scope gate already drops what only folds touched (#3588); work-evidence
 * counted the fold as a commit, so a branch holding nothing but a fold passed
 * as "work done". Each exclusion is paired with a negative control that must
 * still count as the worker's.
 *
 * Real temporary git repositories, as in skill-receipt-exclusion-3092.test.ts:
 * the fold is recognised from git's own trailer and diff output.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { getVerificationRun, upsertWorktree } from '@/lib/db';
import {
  startVerification,
  waitForVerification,
  WORK_EVIDENCE_GATE_ID,
} from '@/lib/verification/gate-runner';
import {
  collectBranchCommitChanges,
  ORCHESTRATOR_FOLD_TRAILER_KEY,
  ORCHESTRATOR_FOLD_TRAILER_VALUE,
} from '@/lib/verification/scope-gate';
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
const tempDirs: string[] = [];

const MODULE_REFERENCE = 'docs/module-reference.md';
const FOLD_TRAILER = `${ORCHESTRATOR_FOLD_TRAILER_KEY}: ${ORCHESTRATOR_FOLD_TRAILER_VALUE}`;

const VERIFY_CONFIG = `
version: 1
gates:
  - id: first
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
`;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(repo: string, relativePath: string, contents: string): void {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function commitAll(repo: string, message: string): void {
  git(['add', '-A'], repo);
  git(['commit', '-m', message], repo);
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'work-evidence-fold-3633-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'fold@example.test'], dir);
  git(['config', 'user.name', 'Fold'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  write(dir, 'README.md', 'base\n');
  write(dir, MODULE_REFERENCE, 'reference\n');
  write(dir, '.commandmate/verify.yaml', VERIFY_CONFIG);
  commitAll(dir, 'base');
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

/** The orchestrate 6-4 fold: only docs/module-reference.md, with the trailer. */
function commitFold(repo: string, contents: string): void {
  write(repo, MODULE_REFERENCE, contents);
  commitAll(repo, `docs(module-reference): fold\n\n${FOLD_TRAILER}`);
}

async function runWorkEvidence(id: string, repo: string): Promise<number> {
  upsertWorktree(db, {
    id,
    name: `feature/${id}`,
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
  const { runId } = await startVerification({ worktreeId: id, worktreePath: repo, trigger: 'api' });
  await waitForVerification(runId);
  return runId;
}

function workEvidenceGate(runId: number) {
  return getVerificationRun(db, runId)?.gates.find((gate) => gate.gateId === WORK_EVIDENCE_GATE_ID);
}

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
    if (dir) removeTempDir(dir);
  }
});

describe('collectBranchCommitChanges (#3633)', () => {
  it('marks the fold commit by its sha, and the worker commit as not a fold', async () => {
    const repo = createRepo();
    write(repo, 'src/a.ts', 'export const a = 1;\n');
    commitAll(repo, 'worker');
    const worker = git(['rev-parse', 'HEAD'], repo).trim();
    commitFold(repo, 'folded\n');
    const fold = git(['rev-parse', 'HEAD'], repo).trim();

    const result = await collectBranchCommitChanges(repo, git(['merge-base', 'main', 'HEAD'], repo).trim());
    if ('error' in result) throw new Error(result.error);
    expect(result.changes.filter((c) => c.fold).map((c) => c.sha)).toEqual([fold]);
    expect(result.changes.find((c) => c.sha === worker)?.fold).toBe(false);
  });
});

describe('work-evidence with the orchestrator fold commit (#3633)', () => {
  it('reports not_started when the branch holds only the fold commit', async () => {
    const repo = createRepo();
    commitFold(repo, 'folded\n');

    const runId = await runWorkEvidence('wt-fold-only', repo);

    const gate = workEvidenceGate(runId);
    expect(gate?.status).toBe('failed');
    expect(gate?.logTail).toContain('commits=0 uncommitted=0 (contract files excluded)');
    expect(gate?.logTail).toContain('(1 orchestrator fold commit(s) excluded)');
    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
  });

  it('passes when the worker committed besides the fold (negative control)', async () => {
    const repo = createRepo();
    write(repo, 'src/a.ts', 'export const a = 1;\n');
    commitAll(repo, 'worker');
    commitFold(repo, 'folded\n');

    const runId = await runWorkEvidence('wt-fold-and-work', repo);

    const gate = workEvidenceGate(runId);
    expect(gate?.status).toBe('passed');
    expect(gate?.logTail).toContain('commits=1 uncommitted=0');
    expect(gate?.logTail).toContain('(1 orchestrator fold commit(s) excluded)');
  });

  it('counts a worker commit of module-reference without the trailer (negative control)', async () => {
    const repo = createRepo();
    write(repo, MODULE_REFERENCE, 'edited by the worker\n');
    commitAll(repo, 'docs: worker edits module-reference');

    const runId = await runWorkEvidence('wt-worker-reference', repo);

    const gate = workEvidenceGate(runId);
    expect(gate?.status).toBe('passed');
    expect(gate?.logTail).toContain('commits=1 uncommitted=0');
    expect(gate?.logTail).not.toContain('orchestrator fold commit(s) excluded');
  });

  it('counts a commit with the trailer that also changes other files (negative control)', async () => {
    const repo = createRepo();
    write(repo, MODULE_REFERENCE, 'folded\n');
    write(repo, 'src/a.ts', 'export const a = 1;\n');
    commitAll(repo, `docs: not only the fold\n\n${FOLD_TRAILER}`);

    const runId = await runWorkEvidence('wt-trailer-with-work', repo);

    const gate = workEvidenceGate(runId);
    expect(gate?.status).toBe('passed');
    expect(gate?.logTail).toContain('commits=1 uncommitted=0');
  });
});
