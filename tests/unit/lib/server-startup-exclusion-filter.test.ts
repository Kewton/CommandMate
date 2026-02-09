/**
 * Unit tests for server startup exclusion filter pattern
 * Issue #202: Deleted repositories reappear after server restart
 *
 * Validates the exact filtering pattern used in server.ts initializeWorktrees():
 *   registerAndFilterRepositories(db, repositoryPaths) -- Combined register + filter
 *
 * Also validates the individual functions and their ordering constraint:
 *   ensureEnvRepositoriesRegistered(db, repositoryPaths)  -- Step 1: Register
 *   filterExcludedPaths(db, repositoryPaths)               -- Step 2: Filter
 *
 * These tests ensure that the ordering constraint (register before filter)
 * produces correct results and that the server restart scenario does not
 * revive deleted repositories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import {
  ensureEnvRepositoriesRegistered,
  filterExcludedPaths,
  registerAndFilterRepositories,
  disableRepository,
  getRepositoryByPath,
} from '@/lib/db-repository';

let testDb: Database.Database;

beforeEach(() => {
  testDb = new Database(':memory:');
  runMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

// ============================================================
// Server Startup Exclusion Filter Pattern (Issue #202)
// ============================================================

describe('Server startup exclusion filter (Issue #202)', () => {
  describe('initializeWorktrees pattern: register then filter', () => {
    it('should not include deleted repos after register + filter sequence', () => {
      const allPaths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];

      // Simulate: first server startup registered the repos
      ensureEnvRepositoriesRegistered(testDb, allPaths);

      // Simulate: user deletes repo1 via UI
      disableRepository(testDb, allPaths[0]);

      // Simulate: server restart - same pattern as server.ts initializeWorktrees()
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      const filteredPaths = filterExcludedPaths(testDb, allPaths);

      // repo1 should be excluded, only repo2 remains
      expect(filteredPaths).toHaveLength(1);
      expect(filteredPaths[0]).toBe('/home/user/repos/repo2');
    });

    it('should include all repos when none are excluded', () => {
      const allPaths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];

      // Simulate server startup
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      const filteredPaths = filterExcludedPaths(testDb, allPaths);

      expect(filteredPaths).toHaveLength(2);
      expect(filteredPaths).toEqual(allPaths);
    });

    it('should return empty array when all repos are excluded', () => {
      const allPaths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];

      // Register then disable all
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      disableRepository(testDb, allPaths[0]);
      disableRepository(testDb, allPaths[1]);

      // Simulate server restart
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      const filteredPaths = filterExcludedPaths(testDb, allPaths);

      expect(filteredPaths).toHaveLength(0);
    });

    it('should correctly compute excluded count for logging', () => {
      const allPaths = [
        '/home/user/repos/repo1',
        '/home/user/repos/repo2',
        '/home/user/repos/repo3',
      ];

      // Register then disable repo1 and repo3
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      disableRepository(testDb, allPaths[0]);
      disableRepository(testDb, allPaths[2]);

      // Simulate server restart
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      const filteredPaths = filterExcludedPaths(testDb, allPaths);

      const excludedCount = allPaths.length - filteredPaths.length;
      expect(excludedCount).toBe(2);
      expect(filteredPaths).toHaveLength(1);
      expect(filteredPaths[0]).toBe('/home/user/repos/repo2');
    });

    it('should correctly identify excluded paths for audit logging (SF-SEC-003)', () => {
      const allPaths = [
        '/home/user/repos/repo1',
        '/home/user/repos/repo2',
        '/home/user/repos/repo3',
      ];

      // Register then disable repo1
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      disableRepository(testDb, allPaths[0]);

      // Simulate server restart
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      const filteredPaths = filterExcludedPaths(testDb, allPaths);

      // Compute excluded paths (same logic as server.ts)
      const excludedPaths = allPaths.filter(p => !filteredPaths.includes(p));

      expect(excludedPaths).toHaveLength(1);
      expect(excludedPaths[0]).toBe('/home/user/repos/repo1');
    });
  });

  describe('ordering constraint: register BEFORE filter', () => {
    it('should register new repos before filtering so they are not lost', () => {
      // First startup: no repos exist in DB yet
      const allPaths = ['/home/user/repos/repo1'];

      // Correct order: register first, then filter
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      const filteredPaths = filterExcludedPaths(testDb, allPaths);

      // New repos should not be filtered out
      expect(filteredPaths).toHaveLength(1);

      // Verify repo exists in DB
      const repo = getRepositoryByPath(testDb, allPaths[0]);
      expect(repo).not.toBeNull();
      expect(repo!.enabled).toBe(true);
    });

    it('should not re-enable a disabled repo during registration', () => {
      const repoPath = '/home/user/repos/repo1';

      // Initial setup: register and disable
      ensureEnvRepositoriesRegistered(testDb, [repoPath]);
      disableRepository(testDb, repoPath);

      // Simulate restart: register again (should NOT re-enable)
      ensureEnvRepositoriesRegistered(testDb, [repoPath]);

      const repo = getRepositoryByPath(testDb, repoPath);
      expect(repo).not.toBeNull();
      expect(repo!.enabled).toBe(false);

      // Filter should exclude it
      const filteredPaths = filterExcludedPaths(testDb, [repoPath]);
      expect(filteredPaths).toHaveLength(0);
    });
  });

  describe('multiple restart cycles', () => {
    it('should maintain exclusion across multiple restart cycles', () => {
      const allPaths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];

      // First startup
      ensureEnvRepositoriesRegistered(testDb, allPaths);

      // User deletes repo1
      disableRepository(testDb, allPaths[0]);

      // Second startup (restart)
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      let filteredPaths = filterExcludedPaths(testDb, allPaths);
      expect(filteredPaths).toEqual(['/home/user/repos/repo2']);

      // Third startup (another restart)
      ensureEnvRepositoriesRegistered(testDb, allPaths);
      filteredPaths = filterExcludedPaths(testDb, allPaths);
      expect(filteredPaths).toEqual(['/home/user/repos/repo2']);

      // repo1 should still be disabled
      const repo1 = getRepositoryByPath(testDb, allPaths[0]);
      expect(repo1!.enabled).toBe(false);
    });
  });

  // ============================================================
  // Edge cases for ensureEnvRepositoriesRegistered
  // ============================================================

  describe('ensureEnvRepositoriesRegistered edge cases', () => {
    it('should handle empty array input without error', () => {
      expect(() => {
        ensureEnvRepositoriesRegistered(testDb, []);
      }).not.toThrow();
    });

    it('should handle single path input', () => {
      const paths = ['/home/user/repos/single'];
      ensureEnvRepositoriesRegistered(testDb, paths);

      const repo = getRepositoryByPath(testDb, paths[0]);
      expect(repo).not.toBeNull();
      expect(repo!.enabled).toBe(true);
    });
  });

  // ============================================================
  // Edge cases for filterExcludedPaths
  // ============================================================

  describe('filterExcludedPaths edge cases', () => {
    it('should handle empty array input without error', () => {
      const result = filterExcludedPaths(testDb, []);
      expect(result).toEqual([]);
    });

    it('should handle paths not present in DB (unregistered paths pass through)', () => {
      // Paths that are not in the DB should not be excluded
      const paths = ['/home/user/repos/unregistered'];
      const result = filterExcludedPaths(testDb, paths);
      expect(result).toEqual(paths);
    });
  });
});

// ============================================================
// registerAndFilterRepositories() - Combined function (Issue #202 refactoring)
// ============================================================

describe('registerAndFilterRepositories (Issue #202)', () => {
  it('should return correct ExclusionSummary when no repos are excluded', () => {
    const allPaths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];

    const summary = registerAndFilterRepositories(testDb, allPaths);

    expect(summary.filteredPaths).toEqual(allPaths);
    expect(summary.excludedPaths).toEqual([]);
    expect(summary.excludedCount).toBe(0);
  });

  it('should return correct ExclusionSummary when some repos are excluded', () => {
    const allPaths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];

    // Register and disable repo1
    ensureEnvRepositoriesRegistered(testDb, allPaths);
    disableRepository(testDb, allPaths[0]);

    // Simulate server restart using combined function
    const summary = registerAndFilterRepositories(testDb, allPaths);

    expect(summary.filteredPaths).toEqual(['/home/user/repos/repo2']);
    expect(summary.excludedPaths).toEqual(['/home/user/repos/repo1']);
    expect(summary.excludedCount).toBe(1);
  });

  it('should return correct ExclusionSummary when all repos are excluded', () => {
    const allPaths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];

    // Register and disable all
    ensureEnvRepositoriesRegistered(testDb, allPaths);
    disableRepository(testDb, allPaths[0]);
    disableRepository(testDb, allPaths[1]);

    const summary = registerAndFilterRepositories(testDb, allPaths);

    expect(summary.filteredPaths).toEqual([]);
    expect(summary.excludedPaths).toEqual(allPaths);
    expect(summary.excludedCount).toBe(2);
  });

  it('should handle empty array input', () => {
    const summary = registerAndFilterRepositories(testDb, []);

    expect(summary.filteredPaths).toEqual([]);
    expect(summary.excludedPaths).toEqual([]);
    expect(summary.excludedCount).toBe(0);
  });

  it('should maintain exclusion across multiple restart cycles', () => {
    const allPaths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];

    // First startup
    registerAndFilterRepositories(testDb, allPaths);

    // User deletes repo1
    disableRepository(testDb, allPaths[0]);

    // Second startup (restart)
    const summary2 = registerAndFilterRepositories(testDb, allPaths);
    expect(summary2.filteredPaths).toEqual(['/home/user/repos/repo2']);
    expect(summary2.excludedCount).toBe(1);

    // Third startup (another restart)
    const summary3 = registerAndFilterRepositories(testDb, allPaths);
    expect(summary3.filteredPaths).toEqual(['/home/user/repos/repo2']);
    expect(summary3.excludedCount).toBe(1);

    // repo1 should still be disabled
    const repo1 = getRepositoryByPath(testDb, allPaths[0]);
    expect(repo1!.enabled).toBe(false);
  });

  it('should not re-enable a disabled repo', () => {
    const repoPath = '/home/user/repos/repo1';

    // Register and disable
    registerAndFilterRepositories(testDb, [repoPath]);
    disableRepository(testDb, repoPath);

    // Call again - should NOT re-enable
    const summary = registerAndFilterRepositories(testDb, [repoPath]);
    expect(summary.filteredPaths).toEqual([]);
    expect(summary.excludedPaths).toEqual([repoPath]);

    const repo = getRepositoryByPath(testDb, repoPath);
    expect(repo!.enabled).toBe(false);
  });

  it('should register new repos on first call', () => {
    const allPaths = ['/home/user/repos/new-repo'];

    const summary = registerAndFilterRepositories(testDb, allPaths);

    // New repo should be registered and not excluded
    expect(summary.filteredPaths).toEqual(allPaths);
    expect(summary.excludedCount).toBe(0);

    const repo = getRepositoryByPath(testDb, allPaths[0]);
    expect(repo).not.toBeNull();
    expect(repo!.enabled).toBe(true);
    expect(repo!.isEnvManaged).toBe(true);
  });

  it('should provide excludedPaths suitable for audit logging (SF-SEC-003)', () => {
    const allPaths = [
      '/home/user/repos/repo1',
      '/home/user/repos/repo2',
      '/home/user/repos/repo3',
    ];

    // Register then disable repo1 and repo3
    ensureEnvRepositoriesRegistered(testDb, allPaths);
    disableRepository(testDb, allPaths[0]);
    disableRepository(testDb, allPaths[2]);

    // Simulate server restart
    const summary = registerAndFilterRepositories(testDb, allPaths);

    // excludedPaths should contain exactly the disabled repos
    expect(summary.excludedPaths).toContain('/home/user/repos/repo1');
    expect(summary.excludedPaths).toContain('/home/user/repos/repo3');
    expect(summary.excludedPaths).not.toContain('/home/user/repos/repo2');
    expect(summary.excludedPaths).toHaveLength(2);
  });
});
