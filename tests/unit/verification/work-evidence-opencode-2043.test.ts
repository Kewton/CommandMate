/**
 * work-evidence's opencode second witness (Issue #2043).
 *
 * The change under test is deliberately narrow: **the only branch that behaves
 * differently is the one that used to report `not_started` unconditionally.**
 * The first block below is the regression guard for that — every non-opencode
 * shape must reach exactly the verdict it reached before #2043 — and the second
 * is the new behaviour.
 *
 * Why the second witness is worth having: the revert button #2043 adds can put
 * the working tree back to where git says nothing happened, while opencode still
 * holds the whole turn's file list.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { addAgentInstance, getVerificationRun, upsertWorktree } from '@/lib/db';
import type { VerificationGateResult } from '@/lib/db';
import {
  startVerification,
  waitForVerification,
  WORK_EVIDENCE_GATE_ID,
} from '@/lib/verification/gate-runner';
import {
  recordOpencodeRevertResult,
  resetOpencodeSessionDiff,
} from '@/lib/hooks/sources/opencode/diff';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
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

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repository with `work` level with `main`, so "commits ahead" stays 0. */
function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'we-2043-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'we@example.test'], dir);
  git(['config', 'user.name', 'We'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(
    join(dir, '.commandmate', 'verify.yaml'),
    "version: 1\ngates:\n  - id: noop\n    command: \"sh -c 'exit 0'\"\n    timeoutSec: 30\noptions:\n  baseRef: main\n"
  );
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
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

async function runToCompletion(
  worktreeId: string,
  worktreePath: string,
  instanceId?: string
): Promise<number> {
  const { runId } = await startVerification({
    worktreeId,
    worktreePath,
    instanceId,
    trigger: 'api',
    gateIds: [WORK_EVIDENCE_GATE_ID],
  });
  await waitForVerification(runId);
  return runId;
}

function evidenceOf(runId: number): VerificationGateResult | undefined {
  return (getVerificationRun(db, runId)?.gates ?? []).find(
    (gate) => gate.gateId === WORK_EVIDENCE_GATE_ID
  );
}

/** Put three files into the store as work a revert is holding back. */
function holdBackThreeFiles(target: AgentInstanceRef): void {
  recordOpencodeRevertResult(target, 'msg_held0000000000000000000', [
    { file: 'a.ts', patch: 'p', additions: 1, deletions: 0, status: 'modified' },
    { file: 'b.ts', patch: 'p', additions: 2, deletions: 1, status: 'modified' },
    { file: 'c.ts', patch: 'p', additions: 3, deletions: 0, status: 'added' },
  ]);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const dbInstance = await import('@/lib/db/db-instance');
  (dbInstance as unknown as { setMockDb: (d: Database.Database) => void }).setMockDb(db);
  resetOpencodeSessionDiff();
});

afterEach(() => {
  resetOpencodeSessionDiff();
  db.close();
  while (tempDirs.length > 0) removeTempDir(tempDirs.pop()!);
});

describe('no other tool’s verdict moves (the #2043 contract)', () => {
  it('still reports not_started on an empty worktree with no instance named', async () => {
    const repo = createRepo();
    registerWorktree('wt-plain', repo);

    const runId = await runToCompletion('wt-plain', repo);

    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
    expect(evidenceOf(runId)?.status).toBe('failed');
    expect(evidenceOf(runId)?.exitCode).toBe(1);
  });

  it('still reports not_started for a claude instance, even with an opencode record present', async () => {
    // Two independent things keep this true and both are worth pinning: the
    // roster check refuses a non-opencode instance, and the composite key an
    // opencode record is filed under could not be reached by this id anyway.
    // Mutation-checked: removing the roster check alone does NOT turn this red,
    // so it is defence in depth rather than the load-bearing rule. The rule that
    // IS load-bearing is the unnamed-instance one, below.
    holdBackThreeFiles({ worktreeId: 'wt-claude', cliToolId: 'opencode' });
    const repo = createRepo();
    registerWorktree('wt-claude', repo);

    const runId = await runToCompletion('wt-claude', repo, 'claude');

    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
    expect(evidenceOf(runId)?.logTail).toContain('nothing to verify');
  });

  it('still reports not_started when the run names no instance at all', async () => {
    // The load-bearing case. work-evidence's git counts are worktree-wide, so a
    // bare `wait --verify` on a worktree that also happens to run an opencode
    // pane would otherwise read that pane's diff into a verdict about whichever
    // session the operator was actually waiting on.
    holdBackThreeFiles({ worktreeId: 'wt-unnamed', cliToolId: 'opencode' });
    const repo = createRepo();
    registerWorktree('wt-unnamed', repo);

    const runId = await runToCompletion('wt-unnamed', repo);

    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
  });

  it('still passes on git evidence alone, without consulting opencode', async () => {
    const repo = createRepo();
    writeFileSync(join(repo, 'work.txt'), 'agent output\n');
    registerWorktree('wt-dirty', repo);

    const runId = await runToCompletion('wt-dirty', repo, 'opencode');

    const evidence = evidenceOf(runId);
    expect(evidence?.status).toBe('passed');
    expect(evidence?.logTail).toContain('uncommitted=1');
    // The git summary is the whole verdict; the second witness never spoke.
    expect(evidence?.logTail).not.toContain('opencode session diff');
  });
});

describe('the opencode second witness', () => {
  it('passes an otherwise-empty worktree when opencode names files', async () => {
    holdBackThreeFiles({ worktreeId: 'wt-oc', cliToolId: 'opencode' });
    const repo = createRepo();
    registerWorktree('wt-oc', repo);

    const runId = await runToCompletion('wt-oc', repo, 'opencode');

    const evidence = evidenceOf(runId);
    expect(evidence?.status).toBe('passed');
    expect(evidence?.exitCode).toBe(0);
    // The verdict says where the count came from, so a reader of stored history
    // can tell this apart from a pass on git evidence.
    expect(evidence?.logTail).toContain('opencode session diff: 3 file(s) changed');
    expect(getVerificationRun(db, runId)?.status).not.toBe('not_started');
  });

  it('consults a named secondary opencode instance from the roster', async () => {
    holdBackThreeFiles({ worktreeId: 'wt-oc2', cliToolId: 'opencode', instanceId: 'opencode-2' });
    const repo = createRepo();
    registerWorktree('wt-oc2', repo);
    addAgentInstance(db, 'wt-oc2', { id: 'opencode-2', cliTool: 'opencode', alias: '', order: 0 });

    const runId = await runToCompletion('wt-oc2', repo, 'opencode-2');

    expect(evidenceOf(runId)?.status).toBe('passed');
    expect(evidenceOf(runId)?.logTail).toContain('opencode session diff: 3 file(s) changed');
  });

  it('does not rescue a worktree opencode also reports nothing for', async () => {
    recordOpencodeRevertResult({ worktreeId: 'wt-oc-empty', cliToolId: 'opencode' }, null, []);
    const repo = createRepo();
    registerWorktree('wt-oc-empty', repo);

    const runId = await runToCompletion('wt-oc-empty', repo, 'opencode');

    expect(getVerificationRun(db, runId)?.status).toBe('not_started');
    expect(evidenceOf(runId)?.status).toBe('failed');
  });
});
