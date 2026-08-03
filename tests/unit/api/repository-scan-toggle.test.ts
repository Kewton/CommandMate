/**
 * Repository scan toggle API (Issue #1658)
 *
 * `PUT /api/repositories/[id] { enabled }` is the non-destructive counterpart to
 * `DELETE /api/repositories`. These tests pin the difference at the route
 * boundary:
 *
 *   - it validates and persists `enabled` without touching `visible`;
 *   - it deletes no worktree row and calls NOTHING in `session-cleanup`, so a
 *     tmux session running under the repository is never killed;
 *   - `POST /api/repositories/sync` then leaves the disabled path out of the
 *     scan — the flag is read, not just written.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getWorktrees } from '@/lib/db';
import {
  createRepository,
  getRepositoryById,
  MAX_DISABLED_REPOSITORIES,
} from '@/lib/db/db-repository';

let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Every session-touching entry point the repository routes could reach. The
// assertion below is that the scan toggle calls none of them.
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn().mockResolvedValue({ results: [], warnings: [] }),
  killWorktreeSession: vi.fn().mockResolvedValue(false),
  syncWorktreesAndCleanup: vi.fn().mockResolvedValue({
    syncResult: { deletedIds: [], upsertedCount: 0 },
    cleanupWarnings: [],
  }),
}));

vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  broadcastMessage: vi.fn(),
  cleanupRooms: vi.fn(),
}));

vi.mock('@/lib/git/worktrees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/git/worktrees')>();
  return {
    ...actual,
    getRepositoryPaths: vi.fn(() => [] as string[]),
    scanMultipleRepositories: vi.fn(async () => []),
    pruneStaleRepositoryWorktrees: vi.fn(() => [] as string[]),
  };
});

import { PUT } from '@/app/api/repositories/[id]/route';
import { GET } from '@/app/api/repositories/route';
import { POST as SYNC } from '@/app/api/repositories/sync/route';
import { cleanupMultipleWorktrees, killWorktreeSession } from '@/lib/session-cleanup';
import { scanMultipleRepositories, getRepositoryPaths } from '@/lib/git/worktrees';

function buildPutRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/repositories/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function buildParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('PUT /api/repositories/[id] { enabled } (Issue #1658)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  it('persists enabled=false and echoes the new state', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
    });

    const response = await PUT(
      buildPutRequest(repo.id, { enabled: false }),
      buildParams(repo.id)
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.repository.enabled).toBe(false);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(false);
  });

  it('persists enabled=true again', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
      enabled: false,
    });

    const response = await PUT(
      buildPutRequest(repo.id, { enabled: true }),
      buildParams(repo.id)
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.repository.enabled).toBe(true);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  it('does not touch visible (Issue #690 concept independence)', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
      visible: false,
    });

    await PUT(buildPutRequest(repo.id, { enabled: false }), buildParams(repo.id));

    expect(getRepositoryById(testDb, repo.id)!.visible).toBe(false);
  });

  it('updates enabled and visible together when both are supplied', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
    });

    const response = await PUT(
      buildPutRequest(repo.id, { enabled: false, visible: false }),
      buildParams(repo.id)
    );
    const data = await response.json();

    expect(data.repository).toMatchObject({ enabled: false, visible: false });
  });

  it('returns 400 when enabled is not a boolean', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
    });

    const response = await PUT(
      buildPutRequest(repo.id, { enabled: 'false' }),
      buildParams(repo.id)
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('enabled must be a boolean');
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  it('returns 404 for an unknown repository id', async () => {
    const response = await PUT(
      buildPutRequest('nope', { enabled: false }),
      buildParams('nope')
    );

    expect(response.status).toBe(404);
  });

  it('returns 409 once MAX_DISABLED_REPOSITORIES is reached (SEC-SF-004)', async () => {
    const insert = testDb.prepare(`
      INSERT INTO repositories (
        id, name, path, enabled, visible, clone_url, normalized_clone_url,
        clone_source, is_env_managed, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 1, NULL, NULL, 'local', 0, 0, 0)
    `);
    const fill = testDb.transaction(() => {
      for (let i = 0; i < MAX_DISABLED_REPOSITORIES; i++) {
        insert.run(`filler-${i}`, `filler-${i}`, `/repos/filler-${i}`);
      }
    });
    fill();

    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
    });

    const response = await PUT(
      buildPutRequest(repo.id, { enabled: false }),
      buildParams(repo.id)
    );

    expect(response.status).toBe(409);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  // --------------------------------------------------------
  // The acceptance criteria that separate this from DELETE
  // --------------------------------------------------------

  it('deletes no worktree row', async () => {
    const repoPath = '/repos/repo-a';
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: repoPath,
      cloneSource: 'local',
    });
    upsertWorktree(testDb, {
      id: 'wt-a',
      name: 'main',
      branch: 'main',
      path: `${repoPath}/main`,
      repositoryPath: repoPath,
      repositoryName: 'repo-a',
    });

    await PUT(buildPutRequest(repo.id, { enabled: false }), buildParams(repo.id));

    expect(getWorktrees(testDb, repoPath).map((w) => w.id)).toEqual(['wt-a']);
  });

  it('kills no tmux session', async () => {
    const repoPath = '/repos/repo-a';
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: repoPath,
      cloneSource: 'local',
    });
    upsertWorktree(testDb, {
      id: 'wt-a',
      name: 'main',
      branch: 'main',
      path: `${repoPath}/main`,
      repositoryPath: repoPath,
      repositoryName: 'repo-a',
    });

    await PUT(buildPutRequest(repo.id, { enabled: false }), buildParams(repo.id));

    expect(cleanupMultipleWorktrees).not.toHaveBeenCalled();
    expect(killWorktreeSession).not.toHaveBeenCalled();
  });

  it('leaves a DB-registered disabled repository out of the next sync scan', async () => {
    const keepPath = '/repos/keep';
    const dropPath = '/repos/drop';
    createRepository(testDb, { name: 'keep', path: keepPath, cloneSource: 'local' });
    const drop = createRepository(testDb, {
      name: 'drop',
      path: dropPath,
      cloneSource: 'local',
    });

    await PUT(buildPutRequest(drop.id, { enabled: false }), buildParams(drop.id));

    const syncResponse = await SYNC();
    expect(syncResponse.status).toBe(200);

    expect(scanMultipleRepositories).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scanMultipleRepositories).mock.calls[0][0]).toEqual([keepPath]);
  });

  it('leaves a WORKTREE_REPOS-listed disabled repository out of the next sync scan', async () => {
    // The motivating case of the Issue: both scan roots come from the
    // environment, so they are in the sync's path set no matter what the
    // repositories table says. Only registerAndFilterRepositories' exclusion
    // step can drop the disabled one here — the `enabled` filter over
    // DB-registered rows never sees these paths.
    const keepPath = '/repos/env-keep';
    const dropPath = '/repos/env-drop';
    vi.mocked(getRepositoryPaths).mockReturnValue([keepPath, dropPath]);

    const drop = createRepository(testDb, {
      name: 'env-drop',
      path: dropPath,
      cloneSource: 'local',
    });

    await PUT(buildPutRequest(drop.id, { enabled: false }), buildParams(drop.id));

    const syncResponse = await SYNC();
    expect(syncResponse.status).toBe(200);

    expect(vi.mocked(scanMultipleRepositories).mock.calls[0][0]).toEqual([keepPath]);
  });

  it('keeps a WORKTREE_REPOS-listed repository disabled across syncs', async () => {
    // Registration runs before filtering on every sync; an env path that is
    // absent from the repositories table gets created enabled. The disabled row
    // must survive that pass, or the exclusion would last exactly one sync.
    const dropPath = '/repos/env-drop';
    vi.mocked(getRepositoryPaths).mockReturnValue([dropPath]);

    const drop = createRepository(testDb, {
      name: 'env-drop',
      path: dropPath,
      cloneSource: 'local',
    });
    await PUT(buildPutRequest(drop.id, { enabled: false }), buildParams(drop.id));

    await SYNC();
    await SYNC();

    expect(getRepositoryById(testDb, drop.id)!.enabled).toBe(false);
    expect(vi.mocked(scanMultipleRepositories).mock.calls.every((call) => call[0].length === 0)).toBe(
      true
    );
  });

  it('still lists the disabled repository via GET /api/repositories', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
    });

    await PUT(buildPutRequest(repo.id, { enabled: false }), buildParams(repo.id));

    const response = await GET();
    const data = await response.json();

    expect(data.repositories).toEqual([
      expect.objectContaining({ id: repo.id, enabled: false, visible: true }),
    ]);
  });
});
