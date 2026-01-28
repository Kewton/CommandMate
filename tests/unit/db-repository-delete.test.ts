/**
 * Database repository delete operations unit tests
 * Issue #69: Repository delete feature
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initDatabase,
  upsertWorktree,
  createMessage,
  getWorktrees,
  getWorktreeById,
  getWorktreeIdsByRepository,
  deleteRepositoryWorktrees,
} from '@/lib/db';
import { runMigrations } from '@/lib/db-migrations';
import type { Worktree } from '@/types/models';

describe('Database Repository Delete Operations', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    // Run migrations to set up latest schema
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('getWorktreeIdsByRepository', () => {
    it('should return empty array for non-existent repository', () => {
      const ids = getWorktreeIdsByRepository(testDb, '/non/existent/repo');
      expect(ids).toEqual([]);
    });

    it('should return all worktree IDs for a repository', () => {
      // Setup: Create multiple worktrees for same repository
      const repoPath = '/path/to/repo';
      const worktrees: Worktree[] = [
        {
          id: 'wt-1',
          name: 'main',
          path: '/path/to/repo/main',
          repositoryPath: repoPath,
          repositoryName: 'repo',
        },
        {
          id: 'wt-2',
          name: 'feature-foo',
          path: '/path/to/repo/feature-foo',
          repositoryPath: repoPath,
          repositoryName: 'repo',
        },
        {
          id: 'wt-3',
          name: 'feature-bar',
          path: '/path/to/repo/feature-bar',
          repositoryPath: repoPath,
          repositoryName: 'repo',
        },
      ];

      for (const wt of worktrees) {
        upsertWorktree(testDb, wt);
      }

      const ids = getWorktreeIdsByRepository(testDb, repoPath);

      expect(ids).toHaveLength(3);
      expect(ids).toContain('wt-1');
      expect(ids).toContain('wt-2');
      expect(ids).toContain('wt-3');
    });

    it('should not return worktrees from other repositories', () => {
      const repoPath1 = '/path/to/repo1';
      const repoPath2 = '/path/to/repo2';

      upsertWorktree(testDb, {
        id: 'wt-repo1',
        name: 'main',
        path: '/path/to/repo1/main',
        repositoryPath: repoPath1,
        repositoryName: 'repo1',
      });

      upsertWorktree(testDb, {
        id: 'wt-repo2',
        name: 'main',
        path: '/path/to/repo2/main',
        repositoryPath: repoPath2,
        repositoryName: 'repo2',
      });

      const ids = getWorktreeIdsByRepository(testDb, repoPath1);

      expect(ids).toHaveLength(1);
      expect(ids).toContain('wt-repo1');
      expect(ids).not.toContain('wt-repo2');
    });
  });

  describe('deleteRepositoryWorktrees', () => {
    it('should return 0 for non-existent repository', () => {
      const result = deleteRepositoryWorktrees(testDb, '/non/existent/repo');
      expect(result.deletedCount).toBe(0);
    });

    it('should delete all worktrees for a repository and return count', () => {
      const repoPath = '/path/to/repo';

      // Create worktrees
      upsertWorktree(testDb, {
        id: 'wt-1',
        name: 'main',
        path: '/path/to/repo/main',
        repositoryPath: repoPath,
        repositoryName: 'repo',
      });
      upsertWorktree(testDb, {
        id: 'wt-2',
        name: 'feature',
        path: '/path/to/repo/feature',
        repositoryPath: repoPath,
        repositoryName: 'repo',
      });

      const result = deleteRepositoryWorktrees(testDb, repoPath);

      expect(result.deletedCount).toBe(2);

      // Verify worktrees are deleted
      const remaining = getWorktrees(testDb);
      expect(remaining).toHaveLength(0);
    });

    it('should not delete worktrees from other repositories', () => {
      const repoPath1 = '/path/to/repo1';
      const repoPath2 = '/path/to/repo2';

      upsertWorktree(testDb, {
        id: 'wt-repo1',
        name: 'main',
        path: '/path/to/repo1/main',
        repositoryPath: repoPath1,
        repositoryName: 'repo1',
      });

      upsertWorktree(testDb, {
        id: 'wt-repo2',
        name: 'main',
        path: '/path/to/repo2/main',
        repositoryPath: repoPath2,
        repositoryName: 'repo2',
      });

      deleteRepositoryWorktrees(testDb, repoPath1);

      // repo2 worktree should still exist
      const remaining = getWorktrees(testDb);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('wt-repo2');
    });

    it('should cascade delete related chat messages', () => {
      const repoPath = '/path/to/repo';

      upsertWorktree(testDb, {
        id: 'wt-1',
        name: 'main',
        path: '/path/to/repo/main',
        repositoryPath: repoPath,
        repositoryName: 'repo',
      });

      // Create chat messages for the worktree
      createMessage(testDb, {
        worktreeId: 'wt-1',
        role: 'user',
        content: 'Test message',
        messageType: 'normal',
        timestamp: new Date(),
      });

      // Delete the repository
      deleteRepositoryWorktrees(testDb, repoPath);

      // Verify chat messages are also deleted via CASCADE
      const messages = testDb.prepare(
        'SELECT * FROM chat_messages WHERE worktree_id = ?'
      ).all('wt-1');
      expect(messages).toHaveLength(0);
    });

    it('should cascade delete related session states', () => {
      const repoPath = '/path/to/repo';

      upsertWorktree(testDb, {
        id: 'wt-1',
        name: 'main',
        path: '/path/to/repo/main',
        repositoryPath: repoPath,
        repositoryName: 'repo',
      });

      // Create session state
      testDb.prepare(
        'INSERT INTO session_states (worktree_id, cli_tool_id, last_captured_line) VALUES (?, ?, ?)'
      ).run('wt-1', 'claude', 100);

      // Delete the repository
      deleteRepositoryWorktrees(testDb, repoPath);

      // Verify session states are also deleted via CASCADE
      const states = testDb.prepare(
        'SELECT * FROM session_states WHERE worktree_id = ?'
      ).all('wt-1');
      expect(states).toHaveLength(0);
    });

    it('should cascade delete related worktree memos', () => {
      const repoPath = '/path/to/repo';

      upsertWorktree(testDb, {
        id: 'wt-1',
        name: 'main',
        path: '/path/to/repo/main',
        repositoryPath: repoPath,
        repositoryName: 'repo',
      });

      // Create memo
      testDb.prepare(
        'INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('memo-1', 'wt-1', 'Test Memo', 'Test content', 0, Date.now(), Date.now());

      // Delete the repository
      deleteRepositoryWorktrees(testDb, repoPath);

      // Verify memos are also deleted via CASCADE
      const memos = testDb.prepare(
        'SELECT * FROM worktree_memos WHERE worktree_id = ?'
      ).all('wt-1');
      expect(memos).toHaveLength(0);
    });
  });
});
