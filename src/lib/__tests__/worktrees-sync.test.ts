/**
 * @file worktrees-sync.test.ts
 * @description Tests for worktree sync functionality
 * Bug fix: syncWorktreesToDB should remove deleted worktrees from DB
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db-migrations';
import { getWorktrees } from '../db';
import { syncWorktreesToDB } from '../worktrees';
import type { Worktree } from '@/types/models';

describe('syncWorktreesToDB', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('should add new worktrees to DB', () => {
    const worktrees: Worktree[] = [
      {
        id: 'repo-main',
        name: 'main',
        path: '/path/to/repo',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
      {
        id: 'repo-feature-1',
        name: 'feature/1',
        path: '/path/to/repo-worktrees/feature-1',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
    ];

    syncWorktreesToDB(testDb, worktrees);

    const dbWorktrees = getWorktrees(testDb);
    expect(dbWorktrees).toHaveLength(2);
    expect(dbWorktrees.map(w => w.id).sort()).toEqual(['repo-feature-1', 'repo-main']);
  });

  it('should update existing worktrees in DB', () => {
    // First sync
    const initialWorktrees: Worktree[] = [
      {
        id: 'repo-main',
        name: 'main',
        path: '/path/to/repo',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
    ];
    syncWorktreesToDB(testDb, initialWorktrees);

    // Second sync with updated data
    const updatedWorktrees: Worktree[] = [
      {
        id: 'repo-main',
        name: 'main',
        path: '/path/to/repo',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
        description: 'Updated description',
      },
    ];
    syncWorktreesToDB(testDb, updatedWorktrees);

    const dbWorktrees = getWorktrees(testDb);
    expect(dbWorktrees).toHaveLength(1);
    expect(dbWorktrees[0].description).toBe('Updated description');
  });

  it('should remove deleted worktrees from DB', () => {
    // Initial state: 3 worktrees
    const initialWorktrees: Worktree[] = [
      {
        id: 'repo-main',
        name: 'main',
        path: '/path/to/repo',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
      {
        id: 'repo-feature-1',
        name: 'feature/1',
        path: '/path/to/repo-worktrees/feature-1',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
      {
        id: 'repo-feature-2',
        name: 'feature/2',
        path: '/path/to/repo-worktrees/feature-2',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
    ];
    syncWorktreesToDB(testDb, initialWorktrees);

    // Verify initial state
    let dbWorktrees = getWorktrees(testDb);
    expect(dbWorktrees).toHaveLength(3);

    // After cleanup: only 2 worktrees remain (feature-2 was deleted)
    const afterCleanup: Worktree[] = [
      {
        id: 'repo-main',
        name: 'main',
        path: '/path/to/repo',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
      {
        id: 'repo-feature-1',
        name: 'feature/1',
        path: '/path/to/repo-worktrees/feature-1',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
    ];
    syncWorktreesToDB(testDb, afterCleanup);

    // Verify deleted worktree is removed
    dbWorktrees = getWorktrees(testDb);
    expect(dbWorktrees).toHaveLength(2);
    expect(dbWorktrees.map(w => w.id).sort()).toEqual(['repo-feature-1', 'repo-main']);
  });

  it('should only remove worktrees from the same repository', () => {
    // Setup: 2 repositories with worktrees
    const allWorktrees: Worktree[] = [
      {
        id: 'repo1-main',
        name: 'main',
        path: '/path/to/repo1',
        repositoryPath: '/path/to/repo1',
        repositoryName: 'repo1',
      },
      {
        id: 'repo1-feature',
        name: 'feature',
        path: '/path/to/repo1-worktrees/feature',
        repositoryPath: '/path/to/repo1',
        repositoryName: 'repo1',
      },
      {
        id: 'repo2-main',
        name: 'main',
        path: '/path/to/repo2',
        repositoryPath: '/path/to/repo2',
        repositoryName: 'repo2',
      },
    ];
    syncWorktreesToDB(testDb, allWorktrees);

    // Verify initial state
    let dbWorktrees = getWorktrees(testDb);
    expect(dbWorktrees).toHaveLength(3);

    // Sync only repo1 worktrees (simulating scanning only repo1)
    // repo1's feature branch was deleted
    const repo1OnlyWorktrees: Worktree[] = [
      {
        id: 'repo1-main',
        name: 'main',
        path: '/path/to/repo1',
        repositoryPath: '/path/to/repo1',
        repositoryName: 'repo1',
      },
    ];
    syncWorktreesToDB(testDb, repo1OnlyWorktrees);

    // repo2's worktree should NOT be affected
    dbWorktrees = getWorktrees(testDb);
    expect(dbWorktrees).toHaveLength(2);
    expect(dbWorktrees.map(w => w.id).sort()).toEqual(['repo1-main', 'repo2-main']);
  });

  it('should handle empty worktree list gracefully', () => {
    // Initial state: 2 worktrees
    const initialWorktrees: Worktree[] = [
      {
        id: 'repo-main',
        name: 'main',
        path: '/path/to/repo',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
      {
        id: 'repo-feature',
        name: 'feature',
        path: '/path/to/repo-worktrees/feature',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      },
    ];
    syncWorktreesToDB(testDb, initialWorktrees);

    // Sync with empty list
    syncWorktreesToDB(testDb, []);

    // DB should remain unchanged (no repository to clean up)
    const dbWorktrees = getWorktrees(testDb);
    expect(dbWorktrees).toHaveLength(2);
  });
});
