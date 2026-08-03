/**
 * Duplicate scan-root detection, end to end over both halves (Issue #1662).
 *
 * The failure this guards against is a PAIR: warning at registration time is
 * useless to someone whose duplicate is already registered, and flagging the
 * existing rows is useless to someone about to create the next one. So both
 * routes are exercised here against the same real git sandbox and the same real
 * database:
 *
 *   - `POST /api/repositories/validate-path` — "you are about to add a second
 *     scan root for a repository you already scan"
 *   - `GET /api/repositories` — "these two rows are the same repository"
 *
 * Nothing about git is mocked. The sandbox holds a repository with a linked
 * worktree (the #1659 shape: `CommandAgent` and `CommandAgent-develop`) plus an
 * unrelated repository with its own worktree, which is the configuration that
 * must NOT be flagged.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

let testDb: Database.Database;
/** Assigned in beforeAll; read lazily by the getEnv mock. */
let CM_ROOT_DIR = '';

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  getEnv: () => ({ CM_ROOT_DIR }),
}));

// The GET handler does not touch either module, but the route file imports them.
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn().mockResolvedValue({ results: [], warnings: [] }),
  killWorktreeSession: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  broadcastMessage: vi.fn(),
  cleanupRooms: vi.fn(),
}));

import { GET } from '@/app/api/repositories/route';
import { POST as VALIDATE_PATH } from '@/app/api/repositories/validate-path/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository, setRepositoryEnabled } from '@/lib/db/db-repository';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function initRepository(repoPath: string): string {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '--quiet', '-m', 'init');
  return repoPath;
}

function validatePathRequest(repositoryPath: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/repositories/validate-path', {
    method: 'POST',
    body: JSON.stringify({ repositoryPath }),
    headers: { 'content-type': 'application/json' },
  });
}

let sandbox: string;
/** Main checkout — stands in for `CommandAgent`. */
let repoMain: string;
/** Linked worktree of the SAME repository — stands in for `CommandAgent-develop`. */
let repoDevelop: string;
/** A different repository entirely. */
let otherRepo: string;
/** A linked worktree of that different repository. */
let otherDevelop: string;
/** A directory that is not a git repository. */
let plainDir: string;

async function readRepositories(): Promise<
  { name: string; path: string; enabled: boolean; duplicateOf: string[] }[]
> {
  const response = await GET();
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.success).toBe(true);
  return data.repositories;
}

function byName(
  repositories: { name: string; duplicateOf: string[] }[],
  name: string
): { name: string; duplicateOf: string[] } {
  const found = repositories.find((r) => r.name === name);
  expect(found, `expected a row named ${name}`).toBeDefined();
  return found!;
}

describe('duplicate scan roots (Issue #1662)', () => {
  beforeAll(() => {
    // realpath so the paths stored in the DB match what the routes compute on
    // macOS, where os.tmpdir() is reached through /var -> /private/var.
    sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'cm-1662-api-')));
    CM_ROOT_DIR = sandbox;

    repoMain = initRepository(path.join(sandbox, 'CommandAgent'));
    repoDevelop = path.join(sandbox, 'CommandAgent-develop');
    git(repoMain, 'worktree', 'add', '--quiet', '-b', 'develop', repoDevelop);

    otherRepo = initRepository(path.join(sandbox, 'OtherRepo'));
    otherDevelop = path.join(sandbox, 'OtherRepo-develop');
    git(otherRepo, 'worktree', 'add', '--quiet', '-b', 'develop', otherDevelop);

    plainDir = path.join(sandbox, 'not-a-repo');
    mkdirSync(plainDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    vi.clearAllMocks();
  });

  describe('GET /api/repositories — already registered', () => {
    it('flags two scan roots that are the same git repository, naming each other', async () => {
      createRepository(testDb, { name: 'CommandAgent', path: repoMain, cloneSource: 'local' });
      createRepository(testDb, {
        name: 'CommandAgent-develop',
        path: repoDevelop,
        cloneSource: 'local',
      });

      const repositories = await readRepositories();

      expect(byName(repositories, 'CommandAgent').duplicateOf).toEqual([repoDevelop]);
      expect(byName(repositories, 'CommandAgent-develop').duplicateOf).toEqual([repoMain]);
    });

    it('does not flag worktrees of DIFFERENT repositories', async () => {
      createRepository(testDb, { name: 'CommandAgent', path: repoMain, cloneSource: 'local' });
      createRepository(testDb, { name: 'OtherRepo', path: otherRepo, cloneSource: 'local' });
      createRepository(testDb, {
        name: 'OtherRepo-develop',
        path: otherDevelop,
        cloneSource: 'local',
      });

      const repositories = await readRepositories();

      // OtherRepo and OtherRepo-develop ARE the same repository as each other…
      expect(byName(repositories, 'OtherRepo').duplicateOf).toEqual([otherDevelop]);
      // …but neither of them is CommandAgent, which stays clean.
      expect(byName(repositories, 'CommandAgent').duplicateOf).toEqual([]);
    });

    it('leaves every row clean when each root is its own repository', async () => {
      createRepository(testDb, { name: 'CommandAgent', path: repoMain, cloneSource: 'local' });
      createRepository(testDb, { name: 'OtherRepo', path: otherRepo, cloneSource: 'local' });

      const repositories = await readRepositories();

      expect(repositories.map((r) => r.duplicateOf)).toEqual([[], []]);
    });

    it('excluding one of the pair clears the warning from the other (Issue #1658 toggle)', async () => {
      // The documented remedy has to actually work, and the row that remains
      // has to stop claiming a conflict that no longer exists.
      const main = createRepository(testDb, {
        name: 'CommandAgent',
        path: repoMain,
        cloneSource: 'local',
      });
      createRepository(testDb, {
        name: 'CommandAgent-develop',
        path: repoDevelop,
        cloneSource: 'local',
      });

      expect(byName(await readRepositories(), 'CommandAgent-develop').duplicateOf).toEqual([
        repoMain,
      ]);

      setRepositoryEnabled(testDb, main.id, false);

      const after = await readRepositories();
      expect(byName(after, 'CommandAgent-develop').duplicateOf).toEqual([]);
      expect(byName(after, 'CommandAgent').duplicateOf).toEqual([]);
      // The disabled row is still listed — nothing was hidden or deleted.
      expect(after).toHaveLength(2);
    });

    it('reports a three-way duplicate as two partners per row', async () => {
      const third = path.join(sandbox, 'CommandAgent-feature');
      git(repoMain, 'worktree', 'add', '--quiet', '-b', 'feature', third);

      createRepository(testDb, { name: 'a', path: repoMain, cloneSource: 'local' });
      createRepository(testDb, { name: 'b', path: repoDevelop, cloneSource: 'local' });
      createRepository(testDb, { name: 'c', path: third, cloneSource: 'local' });

      const repositories = await readRepositories();
      expect(byName(repositories, 'a').duplicateOf.sort()).toEqual([repoDevelop, third].sort());
      expect(byName(repositories, 'b').duplicateOf).toHaveLength(2);
      expect(byName(repositories, 'c').duplicateOf).toHaveLength(2);
    });

    it('survives rows whose directory is not a git repository or is gone', async () => {
      createRepository(testDb, { name: 'plain', path: plainDir, cloneSource: 'local' });
      createRepository(testDb, {
        name: 'vanished',
        path: path.join(sandbox, 'deleted-long-ago'),
        cloneSource: 'local',
      });
      createRepository(testDb, { name: 'CommandAgent', path: repoMain, cloneSource: 'local' });

      const repositories = await readRepositories();
      expect(repositories).toHaveLength(3);
      expect(repositories.every((r) => r.duplicateOf.length === 0)).toBe(true);
    });
  });

  describe('POST /api/repositories/validate-path — about to register', () => {
    it('warns that a sibling worktree duplicates an existing scan root', async () => {
      createRepository(testDb, { name: 'CommandAgent', path: repoMain, cloneSource: 'local' });

      const response = await VALIDATE_PATH(validatePathRequest(repoDevelop));
      const data = await response.json();

      expect(data.duplicateScanRoots).toEqual([repoMain]);
      // A warning, not a rejection: registration must stay reachable.
      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.isGitRepo).toBe(true);
    });

    it('does not warn for a worktree of a different repository', async () => {
      createRepository(testDb, { name: 'CommandAgent', path: repoMain, cloneSource: 'local' });

      const response = await VALIDATE_PATH(validatePathRequest(otherDevelop));
      const data = await response.json();

      expect(data.valid).toBe(true);
      expect(data.duplicateScanRoots).toEqual([]);
    });

    it('does not warn when re-checking a path that is already the scan root', async () => {
      createRepository(testDb, { name: 'CommandAgent', path: repoMain, cloneSource: 'local' });

      const response = await VALIDATE_PATH(validatePathRequest(repoMain));
      const data = await response.json();

      expect(data.duplicateScanRoots).toEqual([]);
    });

    it('ignores scan roots the user has already excluded', async () => {
      const main = createRepository(testDb, {
        name: 'CommandAgent',
        path: repoMain,
        cloneSource: 'local',
      });
      setRepositoryEnabled(testDb, main.id, false);

      const response = await VALIDATE_PATH(validatePathRequest(repoDevelop));
      const data = await response.json();

      // An excluded root is not scanned, so adding a sibling of it creates no
      // double-scan and warning about it would be a false positive.
      expect(data.duplicateScanRoots).toEqual([]);
    });

    it('reports no duplicates for a directory that is not a git repository', async () => {
      createRepository(testDb, { name: 'CommandAgent', path: repoMain, cloneSource: 'local' });

      const response = await VALIDATE_PATH(validatePathRequest(plainDir));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.isGitRepo).toBe(false);
      expect(data.duplicateScanRoots).toEqual([]);
    });

    it('still answers for a path outside the allowed roots, without a duplicate verdict', async () => {
      const response = await VALIDATE_PATH(validatePathRequest('/etc'));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      expect(data.duplicateScanRoots ?? []).toEqual([]);
    });
  });
});
