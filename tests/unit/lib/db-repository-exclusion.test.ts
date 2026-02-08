/**
 * Unit tests for repository exclusion functions
 * Issue #190: Deleted repositories reappear after Sync All
 * TDD Approach: Red phase - write tests first
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from '@/lib/db-migrations';
import {
  createRepository,
  getRepositoryByPath,
  getAllRepositories,
  resolveRepositoryPath,
  validateRepositoryPath,
  ensureEnvRepositoriesRegistered,
  filterExcludedPaths,
  disableRepository,
  getExcludedRepositoryPaths,
  getExcludedRepositories,
  restoreRepository,
  MAX_DISABLED_REPOSITORIES,
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
// resolveRepositoryPath()
// ============================================================

describe('resolveRepositoryPath', () => {
  it('should resolve relative path to absolute path', () => {
    const result = resolveRepositoryPath('./repos/myrepo');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve('./repos/myrepo'));
  });

  it('should remove trailing slashes', () => {
    const result = resolveRepositoryPath('/home/user/repos/myrepo/');
    expect(result).toBe('/home/user/repos/myrepo');
  });

  it('should handle already absolute paths', () => {
    const result = resolveRepositoryPath('/home/user/repos/myrepo');
    expect(result).toBe('/home/user/repos/myrepo');
  });

  it('should resolve parent directory references', () => {
    const result = resolveRepositoryPath('/home/user/repos/../repos/myrepo');
    expect(result).toBe('/home/user/repos/myrepo');
  });
});

// ============================================================
// validateRepositoryPath()
// ============================================================

describe('validateRepositoryPath', () => {
  it('should return valid=true for valid absolute path', () => {
    const result = validateRepositoryPath('/home/user/repos/myrepo');
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBe('/home/user/repos/myrepo');
    expect(result.error).toBeUndefined();
  });

  it('should return valid=false for null', () => {
    const result = validateRepositoryPath(null);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('repositoryPath is required');
  });

  it('should return valid=false for undefined', () => {
    const result = validateRepositoryPath(undefined);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('repositoryPath is required');
  });

  it('should return valid=false for empty string', () => {
    const result = validateRepositoryPath('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('repositoryPath is required');
  });

  it('should return valid=false for non-string type', () => {
    const result = validateRepositoryPath(123);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('repositoryPath is required');
  });

  it('should return valid=false for null byte in path (SEC-MF-001)', () => {
    const result = validateRepositoryPath('/path/to/repo\0malicious');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid repository path');
  });

  it('should return valid=false for system directory path', () => {
    const result = validateRepositoryPath('/etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid repository path');
  });

  it('should resolve path with trailing slash', () => {
    const result = validateRepositoryPath('/home/user/repos/myrepo/');
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toBe('/home/user/repos/myrepo');
  });
});

// ============================================================
// ensureEnvRepositoriesRegistered()
// ============================================================

describe('ensureEnvRepositoriesRegistered', () => {
  it('should register new environment variable repositories', () => {
    const paths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];
    ensureEnvRepositoriesRegistered(testDb, paths);

    const all = getAllRepositories(testDb);
    expect(all).toHaveLength(2);
    expect(all[0].isEnvManaged).toBe(true);
    expect(all[1].isEnvManaged).toBe(true);
    expect(all.every(r => r.enabled)).toBe(true);
  });

  it('should be idempotent - skip already registered repos', () => {
    const paths = ['/home/user/repos/repo1'];

    ensureEnvRepositoriesRegistered(testDb, paths);
    ensureEnvRepositoriesRegistered(testDb, paths);

    const all = getAllRepositories(testDb);
    expect(all).toHaveLength(1);
  });

  it('should not re-enable excluded repositories', () => {
    const repoPath = '/home/user/repos/repo1';

    // Register and then disable
    ensureEnvRepositoriesRegistered(testDb, [repoPath]);
    disableRepository(testDb, repoPath);

    // Register again - should NOT re-enable
    ensureEnvRepositoriesRegistered(testDb, [repoPath]);

    const repo = getRepositoryByPath(testDb, repoPath);
    expect(repo).not.toBeNull();
    expect(repo!.enabled).toBe(false);
  });

  it('should use path.resolve() for normalization', () => {
    const paths = ['/home/user/repos/repo1/'];
    ensureEnvRepositoriesRegistered(testDb, paths);

    // Should be stored without trailing slash
    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo).not.toBeNull();
  });

  it('should set repository name from path basename', () => {
    ensureEnvRepositoriesRegistered(testDb, ['/home/user/repos/my-project']);
    const repo = getRepositoryByPath(testDb, '/home/user/repos/my-project');
    expect(repo).not.toBeNull();
    expect(repo!.name).toBe('my-project');
  });

  it('should set cloneSource as local for env repos', () => {
    ensureEnvRepositoriesRegistered(testDb, ['/home/user/repos/repo1']);
    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo).not.toBeNull();
    expect(repo!.cloneSource).toBe('local');
  });

  it('should explicitly set enabled to true (MF-C01)', () => {
    ensureEnvRepositoriesRegistered(testDb, ['/home/user/repos/repo1']);
    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo).not.toBeNull();
    expect(repo!.enabled).toBe(true);
  });
});

// ============================================================
// filterExcludedPaths()
// ============================================================

describe('filterExcludedPaths', () => {
  it('should filter out excluded (enabled=0) repositories', () => {
    const repoPath = '/home/user/repos/repo1';
    createRepository(testDb, {
      name: 'repo1',
      path: repoPath,
      cloneSource: 'local',
      enabled: false,
    });

    const paths = [repoPath, '/home/user/repos/repo2'];
    const filtered = filterExcludedPaths(testDb, paths);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe('/home/user/repos/repo2');
  });

  it('should keep enabled (enabled=1) repositories', () => {
    const repoPath = '/home/user/repos/repo1';
    createRepository(testDb, {
      name: 'repo1',
      path: repoPath,
      cloneSource: 'local',
      enabled: true,
    });

    const paths = [repoPath];
    const filtered = filterExcludedPaths(testDb, paths);

    expect(filtered).toHaveLength(1);
  });

  it('should handle paths with trailing slashes via normalization', () => {
    const repoPath = '/home/user/repos/repo1';
    createRepository(testDb, {
      name: 'repo1',
      path: repoPath,
      cloneSource: 'local',
      enabled: false,
    });

    // Path with trailing slash should still be filtered
    const paths = ['/home/user/repos/repo1/'];
    const filtered = filterExcludedPaths(testDb, paths);

    expect(filtered).toHaveLength(0);
  });

  it('should return all paths when no repositories are excluded', () => {
    const paths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];
    const filtered = filterExcludedPaths(testDb, paths);

    expect(filtered).toHaveLength(2);
  });

  it('should return empty array when all paths are excluded', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: false,
    });
    createRepository(testDb, {
      name: 'repo2',
      path: '/home/user/repos/repo2',
      cloneSource: 'local',
      enabled: false,
    });

    const paths = ['/home/user/repos/repo1', '/home/user/repos/repo2'];
    const filtered = filterExcludedPaths(testDb, paths);

    expect(filtered).toHaveLength(0);
  });
});

// ============================================================
// disableRepository()
// ============================================================

describe('disableRepository', () => {
  it('should disable an existing repository', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: true,
    });

    disableRepository(testDb, '/home/user/repos/repo1');

    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo).not.toBeNull();
    expect(repo!.enabled).toBe(false);
  });

  it('should create new disabled repository if not registered', () => {
    disableRepository(testDb, '/home/user/repos/new-repo');

    const repo = getRepositoryByPath(testDb, '/home/user/repos/new-repo');
    expect(repo).not.toBeNull();
    expect(repo!.enabled).toBe(false);
    expect(repo!.name).toBe('new-repo');
  });

  it('should be idempotent - disable already disabled repo', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: false,
    });

    // Should not throw
    disableRepository(testDb, '/home/user/repos/repo1');

    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo!.enabled).toBe(false);
  });

  it('should use path normalization', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: true,
    });

    // Disable with trailing slash - should find and disable
    disableRepository(testDb, '/home/user/repos/repo1/');

    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo!.enabled).toBe(false);
  });

  it('should throw error when MAX_DISABLED_REPOSITORIES limit is exceeded (SEC-SF-004)', () => {
    // Create MAX_DISABLED_REPOSITORIES disabled repos
    for (let i = 0; i < MAX_DISABLED_REPOSITORIES; i++) {
      createRepository(testDb, {
        name: `repo-${i}`,
        path: `/home/user/repos/repo-${i}`,
        cloneSource: 'local',
        enabled: false,
      });
    }

    // Next disable of an unregistered repo should throw
    expect(() => {
      disableRepository(testDb, '/home/user/repos/new-repo');
    }).toThrow('Disabled repository limit exceeded');
  });

  it('should not enforce limit when disabling an existing registered repo', () => {
    // Create MAX_DISABLED_REPOSITORIES disabled repos
    for (let i = 0; i < MAX_DISABLED_REPOSITORIES; i++) {
      createRepository(testDb, {
        name: `repo-${i}`,
        path: `/home/user/repos/repo-${i}`,
        cloneSource: 'local',
        enabled: false,
      });
    }

    // Create one enabled repo
    createRepository(testDb, {
      name: 'enabled-repo',
      path: '/home/user/repos/enabled-repo',
      cloneSource: 'local',
      enabled: true,
    });

    // Should NOT throw - existing repo just needs update
    expect(() => {
      disableRepository(testDb, '/home/user/repos/enabled-repo');
    }).not.toThrow();
  });
});

// ============================================================
// getExcludedRepositoryPaths()
// ============================================================

describe('getExcludedRepositoryPaths', () => {
  it('should return paths of excluded repositories', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: false,
    });
    createRepository(testDb, {
      name: 'repo2',
      path: '/home/user/repos/repo2',
      cloneSource: 'local',
      enabled: true,
    });

    const paths = getExcludedRepositoryPaths(testDb);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe('/home/user/repos/repo1');
  });

  it('should return empty array when no excluded repos', () => {
    const paths = getExcludedRepositoryPaths(testDb);
    expect(paths).toHaveLength(0);
  });
});

// ============================================================
// getExcludedRepositories()
// ============================================================

describe('getExcludedRepositories', () => {
  it('should return full Repository objects for excluded repos', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: false,
      isEnvManaged: true,
    });

    const repos = getExcludedRepositories(testDb);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('repo1');
    expect(repos[0].path).toBe('/home/user/repos/repo1');
    expect(repos[0].enabled).toBe(false);
    expect(repos[0].isEnvManaged).toBe(true);
  });

  it('should return repos sorted by name', () => {
    createRepository(testDb, {
      name: 'z-repo',
      path: '/home/user/repos/z-repo',
      cloneSource: 'local',
      enabled: false,
    });
    createRepository(testDb, {
      name: 'a-repo',
      path: '/home/user/repos/a-repo',
      cloneSource: 'local',
      enabled: false,
    });

    const repos = getExcludedRepositories(testDb);
    expect(repos).toHaveLength(2);
    expect(repos[0].name).toBe('a-repo');
    expect(repos[1].name).toBe('z-repo');
  });

  it('should not include enabled repos', () => {
    createRepository(testDb, {
      name: 'enabled-repo',
      path: '/home/user/repos/enabled-repo',
      cloneSource: 'local',
      enabled: true,
    });

    const repos = getExcludedRepositories(testDb);
    expect(repos).toHaveLength(0);
  });
});

// ============================================================
// restoreRepository()
// ============================================================

describe('restoreRepository', () => {
  it('should restore a disabled repository', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: false,
    });

    const result = restoreRepository(testDb, '/home/user/repos/repo1');
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);

    // Verify in DB
    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo!.enabled).toBe(true);
  });

  it('should return null for non-existent path', () => {
    const result = restoreRepository(testDb, '/non/existent/path');
    expect(result).toBeNull();
  });

  it('should handle path normalization', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: false,
    });

    const result = restoreRepository(testDb, '/home/user/repos/repo1/');
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
  });

  it('should be idempotent - restore already enabled repo', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: true,
    });

    const result = restoreRepository(testDb, '/home/user/repos/repo1');
    expect(result).not.toBeNull();
    expect(result!.enabled).toBe(true);
  });
});

// ============================================================
// enabled default value test (MF-C01)
// ============================================================

describe('enabled default value behavior (MF-C01)', () => {
  it('should default to enabled=true when enabled is undefined', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      // enabled is not specified (undefined)
    });

    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo).not.toBeNull();
    expect(repo!.enabled).toBe(true);
  });

  it('should set enabled=false when explicitly passed', () => {
    createRepository(testDb, {
      name: 'repo1',
      path: '/home/user/repos/repo1',
      cloneSource: 'local',
      enabled: false,
    });

    const repo = getRepositoryByPath(testDb, '/home/user/repos/repo1');
    expect(repo).not.toBeNull();
    expect(repo!.enabled).toBe(false);
  });
});

// ============================================================
// Path consistency test (SF-I04)
// ============================================================

describe('path consistency (SF-I04)', () => {
  it('should normalize paths consistently across registration and filtering', () => {
    const rawPath = '/home/user/repos/repo1/';
    const expectedNormalized = '/home/user/repos/repo1';

    ensureEnvRepositoriesRegistered(testDb, [rawPath]);

    const repo = getRepositoryByPath(testDb, expectedNormalized);
    expect(repo).not.toBeNull();
    expect(repo!.path).toBe(expectedNormalized);

    // Disable using raw path (with trailing slash)
    disableRepository(testDb, rawPath);

    // Filter using raw path - should be filtered
    const filtered = filterExcludedPaths(testDb, [rawPath]);
    expect(filtered).toHaveLength(0);

    // Filter using normalized path - should also be filtered
    const filtered2 = filterExcludedPaths(testDb, [expectedNormalized]);
    expect(filtered2).toHaveLength(0);
  });
});
