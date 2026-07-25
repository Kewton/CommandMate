/**
 * Integration tests for the shared repository-path scope (Issue #1517).
 *
 * The failure this file exists to prevent: the picker offers a folder, the user
 * selects it, and `Scan & Add` answers 400. That happens the moment browse, scan
 * and validate-path each carry their own copy of the allowed-root check, so the
 * tests assert both the observable agreement between the three routes *and*
 * that all three call the one `resolveAllowedPath()`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';

let sandbox: string;
let managedRoot: string;
let extraRoot: string;
let foreignDir: string;
let db: Database.Database;
let authenticated = true;

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  getEnv: () => ({ CM_ROOT_DIR: managedRoot }),
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => db,
}));

// Authentication itself is covered against the real guard in
// tests/integration/api-fs-browse.test.ts; here it is a switch so the scope
// assertions are not entangled with token handling.
vi.mock('@/lib/api/api-auth', () => ({
  isApiRequestAuthenticated: () => authenticated,
}));

// Spy on the shared resolver while keeping its real behaviour, so "all three
// routes go through the same function" is an assertion, not a convention.
vi.mock('@/lib/fs/browse-roots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fs/browse-roots')>();
  return { ...actual, resolveAllowedPath: vi.fn(actual.resolveAllowedPath) };
});

vi.mock('@/lib/git/worktrees', () => ({ scanWorktrees: vi.fn() }));
vi.mock('@/lib/session-cleanup', () => ({ syncWorktreesAndCleanup: vi.fn() }));
vi.mock('@/lib/db/db-repository', () => ({
  getRepositoryByPath: vi.fn(),
  createRepository: vi.fn(),
}));

import { resolveAllowedPath } from '@/lib/fs/browse-roots';
import { GET as browse } from '@/app/api/fs/browse/route';
import { POST as validatePath } from '@/app/api/repositories/validate-path/route';
import { POST as scan } from '@/app/api/repositories/scan/route';
import { POST as recordRecentPath } from '@/app/api/fs/recent-paths/route';
import { scanWorktrees } from '@/lib/git/worktrees';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import { runMigrations } from '@/lib/db/db-migrations';
import { getRecentBrowsePaths } from '@/lib/db/app-settings-db';

function postRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function browseRequest(browsePath?: string): NextRequest {
  const url = new URL('http://localhost:3000/api/fs/browse');
  if (browsePath) url.searchParams.set('path', browsePath);
  return new NextRequest(url);
}

/** Make `scan` succeed for `repositoryPath` so only the scope check can fail it. */
function stubSuccessfulScan(repositoryPath: string): void {
  vi.mocked(scanWorktrees).mockResolvedValue([
    {
      id: 'wt-main',
      repositoryPath,
      repositoryName: path.basename(repositoryPath),
    },
  ] as never);
  vi.mocked(syncWorktreesAndCleanup).mockResolvedValue({
    syncResult: { deletedIds: [], upsertedCount: 1 },
    cleanupWarnings: [],
  } as never);
}

beforeAll(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'cm-1517-scope-'));
  managedRoot = path.join(sandbox, 'repos');
  extraRoot = path.join(sandbox, 'work');
  foreignDir = path.join(sandbox, 'elsewhere');

  mkdirSync(path.join(managedRoot, 'repo-a', '.git'), { recursive: true });
  mkdirSync(path.join(extraRoot, 'repo-b', '.git'), { recursive: true });
  mkdirSync(path.join(extraRoot, 'not-a-repo'), { recursive: true });
  mkdirSync(path.join(foreignDir, 'repo-c', '.git'), { recursive: true });
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  authenticated = true;
  delete process.env.CM_BROWSE_ROOTS;
});

afterEach(() => {
  db.close();
});

describe('allowed-root evaluation is shared', () => {
  it('routes browse, validate-path and scan through resolveAllowedPath', async () => {
    const target = path.join(managedRoot, 'repo-a');
    stubSuccessfulScan(target);

    await browse(browseRequest(target));
    await validatePath(postRequest('/api/repositories/validate-path', { repositoryPath: target }));
    await scan(postRequest('/api/repositories/scan', { repositoryPath: target }));

    const calledWith = vi
      .mocked(resolveAllowedPath)
      .mock.calls.map(([candidate]) => candidate);

    expect(calledWith.filter((candidate) => candidate === target)).toHaveLength(3);
  });
});

describe('whatever the picker can offer must register', () => {
  it('accepts a CM_BROWSE_ROOTS repository in browse, validate-path and scan alike', async () => {
    process.env.CM_BROWSE_ROOTS = extraRoot;
    const target = path.join(extraRoot, 'repo-b');
    stubSuccessfulScan(target);

    const browsed = await browse(browseRequest(extraRoot));
    const browsedBody = await browsed.json();
    expect(browsed.status).toBe(200);
    expect(browsedBody.entries.map((e: { path: string }) => e.path)).toContain(target);

    const validated = await validatePath(
      postRequest('/api/repositories/validate-path', { repositoryPath: target })
    );
    await expect(validated.json()).resolves.toMatchObject({ valid: true, isGitRepo: true });

    // The regression that matters: before Issue #1517 this was a 400 because
    // scan only knew about CM_ROOT_DIR.
    const scanned = await scan(postRequest('/api/repositories/scan', { repositoryPath: target }));
    expect(scanned.status).toBe(200);
  });

  it('rejects the same out-of-scope path in all three routes', async () => {
    const target = path.join(foreignDir, 'repo-c');

    expect((await browse(browseRequest(target))).status).toBe(400);
    await expect(
      (
        await validatePath(
          postRequest('/api/repositories/validate-path', { repositoryPath: target })
        )
      ).json()
    ).resolves.toMatchObject({ valid: false, reason: 'outside-roots' });
    expect(
      (await scan(postRequest('/api/repositories/scan', { repositoryPath: target }))).status
    ).toBe(400);
    expect(scanWorktrees).not.toHaveBeenCalled();
  });

  it('names the allowed roots in the scan rejection', async () => {
    process.env.CM_BROWSE_ROOTS = extraRoot;

    const response = await scan(
      postRequest('/api/repositories/scan', { repositoryPath: '/etc' })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain(managedRoot);
    expect(body.error).toContain(extraRoot);
  });
});

describe('POST /api/repositories/validate-path', () => {
  it('reports a git repository with its worktree count', async () => {
    const response = await validatePath(
      postRequest('/api/repositories/validate-path', {
        repositoryPath: path.join(managedRoot, 'repo-a'),
      })
    );

    await expect(response.json()).resolves.toMatchObject({
      valid: true,
      isGitRepo: true,
      worktreeCount: 1,
    });
  });

  it('reports a directory that is not a git repository', async () => {
    process.env.CM_BROWSE_ROOTS = extraRoot;

    const response = await validatePath(
      postRequest('/api/repositories/validate-path', {
        repositoryPath: path.join(extraRoot, 'not-a-repo'),
      })
    );

    await expect(response.json()).resolves.toMatchObject({
      valid: true,
      isGitRepo: false,
      worktreeCount: null,
    });
  });

  it('reports a missing directory inside an allowed root', async () => {
    const response = await validatePath(
      postRequest('/api/repositories/validate-path', {
        repositoryPath: path.join(managedRoot, 'typo-repo'),
      })
    );

    await expect(response.json()).resolves.toMatchObject({
      valid: false,
      reason: 'not-found',
    });
  });

  it('requires authentication', async () => {
    authenticated = false;

    const response = await validatePath(
      postRequest('/api/repositories/validate-path', {
        repositoryPath: path.join(managedRoot, 'repo-a'),
      })
    );

    expect(response.status).toBe(401);
  });
});

describe('POST /api/fs/recent-paths', () => {
  it('stores a path inside the allowed roots', async () => {
    const target = path.join(managedRoot, 'repo-a');

    const response = await recordRecentPath(postRequest('/api/fs/recent-paths', { path: target }));

    expect(response.status).toBe(200);
    expect(getRecentBrowsePaths(db)).toEqual([target]);
  });

  it('refuses to store a path outside the allowed roots', async () => {
    const response = await recordRecentPath(
      postRequest('/api/fs/recent-paths', { path: path.join(foreignDir, 'repo-c') })
    );

    expect(response.status).toBe(400);
    expect(getRecentBrowsePaths(db)).toEqual([]);
  });

  it('requires authentication', async () => {
    authenticated = false;

    const response = await recordRecentPath(
      postRequest('/api/fs/recent-paths', { path: path.join(managedRoot, 'repo-a') })
    );

    expect(response.status).toBe(401);
    expect(getRecentBrowsePaths(db)).toEqual([]);
  });
});
