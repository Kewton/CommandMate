/**
 * API integration tests: GET /api/repositories
 * Issue #644: Repository list display
 *
 * These tests verify:
 * - GET returns all repositories (enabled AND disabled)
 * - Each entry includes worktreeCount aggregated via repository_path
 * - The response shape matches the documented RepositoryListItem
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { GET } from '@/app/api/repositories/route';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import {
  createRepository,
  updateRepository,
} from '@/lib/db/db-repository';

let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

// The GET handler does not touch ws-server or session-cleanup, but the route
// module imports them. Stub them out for a clean test environment.
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn().mockResolvedValue({ results: [], warnings: [] }),
  killWorktreeSession: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  broadcastMessage: vi.fn(),
  cleanupRooms: vi.fn(),
}));

describe('GET /api/repositories (Issue #644)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  it('returns an empty list when no repositories are registered', async () => {
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.repositories)).toBe(true);
    expect(data.repositories).toHaveLength(0);
  });

  it('returns registered repositories with worktreeCount = 0 when no worktrees', async () => {
    createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.repositories).toHaveLength(1);

    const [repoA] = data.repositories;
    expect(repoA.name).toBe('repo-a');
    expect(repoA.path).toBe('/path/to/repo-a');
    expect(repoA.enabled).toBe(true);
    expect(repoA.displayName).toBeNull();
    expect(repoA.worktreeCount).toBe(0);
    expect(typeof repoA.id).toBe('string');
  });

  it('aggregates worktreeCount using repository_path (NOT repository_id)', async () => {
    // Create two repositories
    createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });
    createRepository(testDb, {
      name: 'repo-b',
      path: '/path/to/repo-b',
      cloneSource: 'local',
    });

    // Create worktrees for each repository
    upsertWorktree(testDb, {
      id: 'wt-a-1',
      name: 'main',
      path: '/path/to/repo-a/main',
      repositoryPath: '/path/to/repo-a',
      repositoryName: 'repo-a',
    });
    upsertWorktree(testDb, {
      id: 'wt-a-2',
      name: 'feature',
      path: '/path/to/repo-a/feature',
      repositoryPath: '/path/to/repo-a',
      repositoryName: 'repo-a',
    });
    upsertWorktree(testDb, {
      id: 'wt-b-1',
      name: 'main',
      path: '/path/to/repo-b/main',
      repositoryPath: '/path/to/repo-b',
      repositoryName: 'repo-b',
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    const byName = Object.fromEntries(
      (data.repositories as Array<{ name: string; worktreeCount: number }>).map((r) => [r.name, r])
    );
    expect(byName['repo-a'].worktreeCount).toBe(2);
    expect(byName['repo-b'].worktreeCount).toBe(1);
  });

  it('includes disabled repositories in the list', async () => {
    const repoA = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
      enabled: true,
    });
    const repoB = createRepository(testDb, {
      name: 'repo-b',
      path: '/path/to/repo-b',
      cloneSource: 'local',
      enabled: false,
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.repositories).toHaveLength(2);

    const names = data.repositories.map((r: { name: string }) => r.name).sort();
    expect(names).toEqual(['repo-a', 'repo-b']);

    const repoBData = data.repositories.find((r: { id: string }) => r.id === repoB.id);
    expect(repoBData.enabled).toBe(false);

    const repoAData = data.repositories.find((r: { id: string }) => r.id === repoA.id);
    expect(repoAData.enabled).toBe(true);
  });

  it('returns displayName as a string when set and null otherwise', async () => {
    const repoA = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });
    createRepository(testDb, {
      name: 'repo-b',
      path: '/path/to/repo-b',
      cloneSource: 'local',
    });

    updateRepository(testDb, repoA.id, { displayName: 'My Project A' });

    const response = await GET();
    const data = await response.json();

    const repoAData = data.repositories.find((r: { name: string }) => r.name === 'repo-a');
    const repoBData = data.repositories.find((r: { name: string }) => r.name === 'repo-b');

    expect(repoAData.displayName).toBe('My Project A');
    expect(repoBData.displayName).toBeNull();
  });

  it('orders repositories by name ASC', async () => {
    createRepository(testDb, {
      name: 'zeta',
      path: '/path/to/zeta',
      cloneSource: 'local',
    });
    createRepository(testDb, {
      name: 'alpha',
      path: '/path/to/alpha',
      cloneSource: 'local',
    });
    createRepository(testDb, {
      name: 'mega',
      path: '/path/to/mega',
      cloneSource: 'local',
    });

    const response = await GET();
    const data = await response.json();

    const names = data.repositories.map((r: { name: string }) => r.name);
    expect(names).toEqual(['alpha', 'mega', 'zeta']);
  });

  it('each returned item has the expected field shape', async () => {
    createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    const response = await GET();
    const data = await response.json();

    expect(data.repositories).toHaveLength(1);
    const repo = data.repositories[0];

    // Whitelist of expected fields (Issue #690: `visible` added)
    const expectedFields = new Set([
      'id',
      'name',
      'displayName',
      'path',
      'enabled',
      'visible',
      'worktreeCount',
    ]);

    for (const key of Object.keys(repo)) {
      expect(expectedFields.has(key)).toBe(true);
    }

    // Ensure types are correct
    expect(typeof repo.id).toBe('string');
    expect(typeof repo.name).toBe('string');
    expect(repo.displayName === null || typeof repo.displayName === 'string').toBe(true);
    expect(typeof repo.path).toBe('string');
    expect(typeof repo.enabled).toBe('boolean');
    expect(typeof repo.worktreeCount).toBe('number');
  });
});
