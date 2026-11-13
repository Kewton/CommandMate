/**
 * The branches the decision screen chooses from (Issue #4355 PR2, design
 * `docs/design/mem-decisions-ux-4355.md` §3.1.2・§3.1.4・§4.1・I6).
 *
 * `GET /api/repositories/:id/mem/decisions/branches` is called as Next calls it, against a
 * migrated file database and a real git repository made under `os.tmpdir()` (removed after
 * each test). The decisions are added through mem's own service.
 *
 * - The branches are the worktrees' and those holding a decision not closed; `on` first.
 * - I6: each branch's counts are the shared count's (`summarizeDecisionCounts` and the list
 *   route answer the same numbers); `ambiguous` is null, never 0.
 * - §3.1.4: where `?item=` is — here, elsewhere (another branch or repository), gone.
 * - A read writes nothing (every row of every table, before and after).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

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
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { setMockDb } from '@/lib/db/db-instance';
import { GET as getBranches } from '@/app/api/repositories/[id]/mem/decisions/branches/route';
import { GET as getDecisions } from '@/app/api/repositories/[id]/mem/decisions/route';
import { createRepository } from '@/lib/db/db-repository';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { memAddItem, memCloseItem } from '@/lib/mem/service';
import { listDecisionBranches } from '@/lib/promote/decision-branches';
import { summarizeDecisionCounts } from '@/lib/promote/decision-summary';
import type { DecisionBranchesBody } from '@/lib/promote/decision-counts';
import type { MemBranchRule, MemWriteResponse } from '@/types/mem';

const BRANCH = 'feature/x';
const WT = 'wt-a';

let dir: string;
let db: Database.Database;
let rootA: string;
let repoA: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });

function insertWorktree(id: string, worktreePath: string, repositoryPath: string, branch: string | null): void {
  db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name, branch) VALUES (?, ?, ?, ?, 'repo', ?)`).run(
    id,
    id,
    worktreePath,
    repositoryPath,
    branch
  );
}
function setRules(repositoryId: string, rules: MemBranchRule[]): void {
  const current = getMemSettings(db, repositoryId);
  saveMemSettings(db, repositoryId, { version: current.version, features: current.features, rules });
}
const ON: MemBranchRule[] = [{ match: 'glob', pattern: '**', mode: 'on' }];

/** A real git repository on `BRANCH`, registered with mem `on`, its worktree `worktreeId`. */
function makeRepository(name: string, worktreeId: string): { root: string; id: string } {
  const root = path.join(dir, name);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  git(root, 'init', '-q', '-b', BRANCH);
  writeFileSync(path.join(root, 'docs/d.md'), '# d\n');
  git(root, 'add', 'docs/d.md');
  git(root, 'commit', '-q', '-m', 'init');
  const id = createRepository(db, { name, path: root, cloneSource: 'local' }).id;
  insertWorktree(worktreeId, root, root, BRANCH);
  setRules(id, ON);
  return { root, id };
}

async function add(worktreeId: string, kind: 'decision' | 'note' = 'decision'): Promise<{ id: string; version: number }> {
  const outcome = await memAddItem(db, worktreeId, { instanceId: 'claude', kind, text: `${kind} の本文`, ...(kind === 'decision' ? { promoteTo: 'issue:#1' } : {}) });
  expect(outcome.status).toBe(201);
  const made = (outcome.body as MemWriteResponse).item;
  return { id: made.id, version: made.version };
}

function req(url: string): NextRequest {
  const request = new Request(url) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: new URL(url), configurable: true });
  return request;
}
async function branchesRoute(repositoryId = repoA, query = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await getBranches(req(`http://localhost:3000/api/repositories/${repositoryId}/mem/decisions/branches${query}`), {
    params: Promise.resolve({ id: repositoryId }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const branchesOf = async (repositoryId = repoA) => ((await branchesRoute(repositoryId)).body as unknown as DecisionBranchesBody).branches;

/** Every row of every table (the content and the version, not only the count). */
function snapshot(): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  return JSON.stringify(tables.map((table) => [table, (db.prepare(`SELECT * FROM "${table}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort()]));
}

beforeEach(() => {
  dir = makeTempDir('decision-branches-4355-');
  db = openMigratedFileDb(path.join(dir, 'cm.db'), { foreignKeys: true });
  setMockDb(db);
  ({ root: rootA, id: repoA } = makeRepository('root-a', WT));
});

afterEach(() => {
  db.close();
  removeTempDir(dir);
});

describe('§3.1.2: the branches to choose from', () => {
  it('(positive control) the route answers the branches with their counts (there was no such route before PR2)', async () => {
    await add(WT);
    const { status, body } = await branchesRoute();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, branches: [{ branch: BRANCH, mode: 'on', approvable: true, open: 1, recorded: 0 }] });
  });

  it('the union of the worktrees’ branches and the branches holding a decision; `on` first, then by name', async () => {
    await add(WT);
    insertWorktree('wt-y', path.join(dir, 'wt-y'), rootA, 'feature/y');
    insertWorktree('wt-detached', path.join(dir, 'wt-d'), rootA, null);
    // A decision whose worktree is gone: still waiting for a person, so still listed.
    const orphan = await add(WT);
    db.prepare('UPDATE mem_items SET branch = ? WHERE id = ?').run('gone/branch', orphan.id);
    setRules(repoA, [{ match: 'glob', pattern: 'feature/y', mode: 'off' }, ...ON]);

    expect(await branchesOf()).toEqual([
      { branch: BRANCH, mode: 'on', approvable: true, open: 1, recorded: 0 },
      { branch: 'gone/branch', mode: 'on', approvable: true, open: 1, recorded: 0 },
      { branch: 'feature/y', mode: 'off', approvable: false, open: 0, recorded: 0 },
    ]);
  });

  it('(negative control) a branch whose decisions are all closed and that has no worktree, or that holds notes only, is not listed', async () => {
    const closed = await add(WT);
    expect((await memCloseItem(db, WT, closed.id, { instanceId: 'claude', ifVersion: closed.version, reason: 'done' })).status).toBe(201);
    db.prepare('UPDATE mem_items SET branch = ? WHERE id = ?').run('closed/only', closed.id);
    const note = await add(WT, 'note');
    db.prepare('UPDATE mem_items SET branch = ? WHERE id = ?').run('notes/only', note.id);
    expect((await branchesOf()).map((entry) => entry.branch)).toEqual([BRANCH]);
  });

  it('I6: the counts are the shared count’s — the same as summarizeDecisionCounts and the list route', async () => {
    await add(WT);
    await add(WT);
    const [entry] = await branchesOf();
    const shared = await summarizeDecisionCounts(db, repoA, BRANCH);
    const listResponse = await getDecisions(req(`http://localhost:3000/api/repositories/${repoA}/mem/decisions?branch=${encodeURIComponent(BRANCH)}`), {
      params: Promise.resolve({ id: repoA }),
    });
    const listed = ((await listResponse.json()) as { counts: unknown }).counts;
    expect(entry).toEqual({ branch: BRANCH, ...shared });
    expect(listed).toEqual(shared);
    expect(entry.open).toBe(2);
  });

  it('I6: when the roots of the same git disagree on the mode, the counts are unknown (null), never 0', async () => {
    await add(WT);
    const rootB = path.join(dir, 'root-b');
    mkdirSync(rootB);
    const repoB = createRepository(db, { name: 'root-b', path: rootB, cloneSource: 'local' }).id;
    setRules(repoB, [{ match: 'glob', pattern: '**', mode: 'off' }]);
    const outcome = await listDecisionBranches(db, repoA, {}, { resolveCommonDir: async () => '/common/.git' });
    expect(outcome.status).toBe(200);
    expect((outcome.body as DecisionBranchesBody).branches).toEqual([{ branch: BRANCH, mode: 'ambiguous', approvable: false, open: null, recorded: null }]);
  });

  it('§4.1: a repository that is not there is 404', async () => {
    const { status, body } = await branchesRoute('no-such-repository');
    expect(status).toBe(404);
    expect(body).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('I2: a read writes nothing (every row of every table is the same)', async () => {
    await add(WT);
    const before = snapshot();
    await branchesRoute();
    await branchesRoute(repoA, `?item=x&branch=${encodeURIComponent(BRANCH)}`);
    await branchesRoute('no-such-repository');
    expect(snapshot()).toBe(before);
  });
});

describe('§3.1.4: where `?item=` is, as seen from the branch the screen shows', () => {
  const whereOf = async (item: string, branch = BRANCH, repositoryId = repoA) =>
    (await branchesRoute(repositoryId, `?item=${encodeURIComponent(item)}&branch=${encodeURIComponent(branch)}`)).body.item;

  it('here, on another branch, closed, and unknown', async () => {
    const open = await add(WT);
    const closed = await add(WT);
    expect((await memCloseItem(db, WT, closed.id, { instanceId: 'claude', ifVersion: closed.version, reason: 'done' })).status).toBe(201);
    expect(await whereOf(open.id)).toEqual({ id: open.id, where: 'here' });
    expect(await whereOf(open.id, 'feature/other')).toEqual({ id: open.id, where: 'elsewhere' });
    expect(await whereOf(closed.id)).toEqual({ id: closed.id, where: 'gone' });
    expect(await whereOf('no-such-item')).toEqual({ id: 'no-such-item', where: 'gone' });
  });

  it('another repository’s item is elsewhere (nothing of it is answered)', async () => {
    const other = makeRepository('root-c', 'wt-c');
    const theirs = await add('wt-c');
    const answer = await branchesRoute(repoA, `?item=${theirs.id}&branch=${encodeURIComponent(BRANCH)}`);
    expect(answer.body.item).toEqual({ id: theirs.id, where: 'elsewhere' });
    expect(JSON.stringify(answer.body)).not.toContain('decision の本文');
    expect(other.id).not.toBe(repoA);
  });

  it('(negative control) without `?item=` the answer has no item', async () => {
    expect((await branchesRoute()).body).not.toHaveProperty('item');
  });
});
