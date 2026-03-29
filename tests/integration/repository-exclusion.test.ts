/**
 * Integration tests for repository exclusion feature
 * Issue #190: Deleted repositories reappear after Sync All
 * Tests the full flow: delete -> sync -> verify exclusion
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getWorktrees } from '@/lib/db';
import {
  createRepository,
  getRepositoryByPath,
  getExcludedRepositories,
  getExcludedRepositoryPaths,
  disableRepository,
  restoreRepository,
  ensureEnvRepositoriesRegistered,
  filterExcludedPaths,
} from '@/lib/db/db-repository';
import { GET } from '@/app/api/repositories/excluded/route';
import { PUT } from '@/app/api/repositories/restore/route';

// Mock db-instance to use test database
let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

// Mock session cleanup
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn().mockResolvedValue({
    results: [],
    warnings: [],
  }),
  killWorktreeSession: vi.fn().mockResolvedValue(false),
  syncWorktreesAndCleanup: vi.fn().mockResolvedValue({
    syncResult: { deletedIds: [], upsertedCount: 0 },
    cleanupWarnings: [],
  }),
}));

// Mock ws-server
vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  broadcastMessage: vi.fn(),
  cleanupRooms: vi.fn(),
}));

describe('Repository Exclusion Integration (Issue #190)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  // ============================================================
  // Full flow: exclude -> sync -> verify not restored
  // ============================================================

  describe('Exclusion -> Sync flow', () => {
    it('should prevent excluded repo from appearing after filtering', () => {
      const repoPath = '/home/user/repos/repo1';

      // Register and disable
      ensureEnvRepositoriesRegistered(testDb, [repoPath]);
      disableRepository(testDb, repoPath);

      // Simulate sync: filter excluded paths
      const paths = [repoPath, '/home/user/repos/repo2'];
      const filtered = filterExcludedPaths(testDb, paths);

      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toBe('/home/user/repos/repo2');
    });

    it('should handle un-synced repository deletion (SF-C01)', () => {
      const repoPath = '/home/user/repos/never-synced';

      // Disable without prior sync (no worktrees exist)
      disableRepository(testDb, repoPath);

      // Verify it's excluded from future syncs
      const filtered = filterExcludedPaths(testDb, [repoPath]);
      expect(filtered).toHaveLength(0);

      // Verify excluded repo exists in DB
      const repo = getRepositoryByPath(testDb, repoPath);
      expect(repo).not.toBeNull();
      expect(repo!.enabled).toBe(false);
    });

    it('should allow non-excluded repos to sync normally', () => {
      const repoPath1 = '/home/user/repos/repo1';
      const repoPath2 = '/home/user/repos/repo2';

      // Register both, disable only repo1
      ensureEnvRepositoriesRegistered(testDb, [repoPath1, repoPath2]);
      disableRepository(testDb, repoPath1);

      // Filter
      const filtered = filterExcludedPaths(testDb, [repoPath1, repoPath2]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]).toBe(repoPath2);
    });
  });

  // ============================================================
  // GET /api/repositories/excluded
  // ============================================================

  describe('GET /api/repositories/excluded', () => {
    it('should return excluded repositories', async () => {
      createRepository(testDb, {
        name: 'excluded-repo',
        path: '/home/user/repos/excluded',
        cloneSource: 'local',
        enabled: false,
      });

      const response = await GET();
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.repositories).toHaveLength(1);
      expect(data.repositories[0].name).toBe('excluded-repo');
      expect(data.repositories[0].enabled).toBe(false);
    });

    it('should return empty array when no excluded repos', async () => {
      const response = await GET();
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.repositories).toHaveLength(0);
    });

    it('should not include enabled repos', async () => {
      createRepository(testDb, {
        name: 'enabled-repo',
        path: '/home/user/repos/enabled',
        cloneSource: 'local',
        enabled: true,
      });

      const response = await GET();
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.repositories).toHaveLength(0);
    });
  });

  // ============================================================
  // PUT /api/repositories/restore
  // ============================================================

  describe('PUT /api/repositories/restore', () => {
    it('should return 400 for missing repositoryPath', async () => {
      const request = new NextRequest('http://localhost:3000/api/repositories/restore', {
        method: 'PUT',
        body: JSON.stringify({}),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('repositoryPath');
    });

    it('should return 404 for non-existent repository', async () => {
      const request = new NextRequest('http://localhost:3000/api/repositories/restore', {
        method: 'PUT',
        body: JSON.stringify({ repositoryPath: '/non/existent/path' }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Repository not found in exclusion list');
    });

    it('should restore excluded repository with warning when path not on disk', async () => {
      createRepository(testDb, {
        name: 'excluded-repo',
        path: '/non/existent/repo/path',
        cloneSource: 'local',
        enabled: false,
      });

      const request = new NextRequest('http://localhost:3000/api/repositories/restore', {
        method: 'PUT',
        body: JSON.stringify({ repositoryPath: '/non/existent/repo/path' }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.worktreeCount).toBe(0);
      expect(data.warning).toBeDefined();

      // Verify repo is now enabled in DB
      const repo = getRepositoryByPath(testDb, '/non/existent/repo/path');
      expect(repo).not.toBeNull();
      expect(repo!.enabled).toBe(true);
    });

    it('should return 400 for null byte in repositoryPath (SEC-MF-001)', async () => {
      const request = new NextRequest('http://localhost:3000/api/repositories/restore', {
        method: 'PUT',
        body: JSON.stringify({ repositoryPath: '/path/to/repo\0malicious' }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid repository path');
    });

    it('should return 400 for system directory path (SEC-MF-001)', async () => {
      const request = new NextRequest('http://localhost:3000/api/repositories/restore', {
        method: 'PUT',
        body: JSON.stringify({ repositoryPath: '/etc/passwd' }),
      });

      const response = await PUT(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid repository path');
    });
  });

  // ============================================================
  // Full round-trip: exclude -> check exclusion list -> restore -> check restored
  // ============================================================

  describe('Full round-trip flow', () => {
    it('should complete exclude -> list -> restore cycle', async () => {
      const repoPath = '/home/user/repos/roundtrip-repo';

      // Step 1: Register and disable
      ensureEnvRepositoriesRegistered(testDb, [repoPath]);
      disableRepository(testDb, repoPath);

      // Step 2: Verify in exclusion list
      const excluded = getExcludedRepositories(testDb);
      expect(excluded).toHaveLength(1);
      expect(excluded[0].path).toBe(repoPath);

      // Step 3: Verify filtered from sync paths
      const filtered = filterExcludedPaths(testDb, [repoPath]);
      expect(filtered).toHaveLength(0);

      // Step 4: Restore
      const restored = restoreRepository(testDb, repoPath);
      expect(restored).not.toBeNull();
      expect(restored!.enabled).toBe(true);

      // Step 5: Verify no longer in exclusion list
      const excludedAfter = getExcludedRepositories(testDb);
      expect(excludedAfter).toHaveLength(0);

      // Step 6: Verify no longer filtered from sync paths
      const filteredAfter = filterExcludedPaths(testDb, [repoPath]);
      expect(filteredAfter).toHaveLength(1);
      expect(filteredAfter[0]).toBe(repoPath);
    });
  });
});
