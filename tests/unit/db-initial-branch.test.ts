/**
 * Unit tests for initial_branch database operations
 * Issue #111: Branch visualization feature
 * TDD Approach: Test Migration #15 and DB functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from '@/lib/db-migrations';
import { saveInitialBranch, getInitialBranch } from '@/lib/db';

describe('Initial Branch Database Operations', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = new Database(':memory:');
    // Run all migrations including #15
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('Migration #15: add-initial-branch-column', () => {
    it('should have schema version 15 or higher', () => {
      const version = getCurrentVersion(testDb);
      expect(version).toBeGreaterThanOrEqual(15);
    });

    it('should have CURRENT_SCHEMA_VERSION set to 15 or higher', () => {
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
    });

    it('should add initial_branch column to worktrees table', () => {
      const columns = testDb
        .prepare("PRAGMA table_info(worktrees)")
        .all() as Array<{ name: string; type: string; notnull: number }>;

      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('initial_branch');
    });

    it('should have initial_branch as TEXT type', () => {
      const columns = testDb
        .prepare("PRAGMA table_info(worktrees)")
        .all() as Array<{ name: string; type: string; notnull: number }>;

      const initialBranchColumn = columns.find(c => c.name === 'initial_branch');
      expect(initialBranchColumn).toBeDefined();
      expect(initialBranchColumn?.type).toBe('TEXT');
    });

    it('should allow NULL for initial_branch (for backward compatibility)', () => {
      // Create a worktree without initial_branch
      const now = Date.now();
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
        VALUES ('test-id', 'test-worktree', '/path/to/worktree', '/path/to/repo', 'test-repo', ?)
      `).run(now);

      // Verify initial_branch is NULL
      const row = testDb.prepare(`
        SELECT initial_branch FROM worktrees WHERE id = 'test-id'
      `).get() as { initial_branch: string | null };

      expect(row.initial_branch).toBeNull();
    });
  });

  describe('saveInitialBranch', () => {
    beforeEach(() => {
      // Create test worktree
      const now = Date.now();
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
        VALUES ('test-worktree-id', 'test-worktree', '/path/to/worktree', '/path/to/repo', 'test-repo', ?)
      `).run(now);
    });

    it('should save initial branch for a worktree', () => {
      saveInitialBranch(testDb, 'test-worktree-id', 'main');

      const row = testDb.prepare(`
        SELECT initial_branch FROM worktrees WHERE id = 'test-worktree-id'
      `).get() as { initial_branch: string | null };

      expect(row.initial_branch).toBe('main');
    });

    it('should update existing initial branch', () => {
      saveInitialBranch(testDb, 'test-worktree-id', 'main');
      saveInitialBranch(testDb, 'test-worktree-id', 'feature/new-branch');

      const row = testDb.prepare(`
        SELECT initial_branch FROM worktrees WHERE id = 'test-worktree-id'
      `).get() as { initial_branch: string | null };

      expect(row.initial_branch).toBe('feature/new-branch');
    });

    it('should handle special characters in branch names', () => {
      saveInitialBranch(testDb, 'test-worktree-id', 'feature/branch-with-special_chars.v1');

      const row = testDb.prepare(`
        SELECT initial_branch FROM worktrees WHERE id = 'test-worktree-id'
      `).get() as { initial_branch: string | null };

      expect(row.initial_branch).toBe('feature/branch-with-special_chars.v1');
    });

    it('should not throw for non-existent worktree', () => {
      // Should not throw, just no rows affected
      expect(() => {
        saveInitialBranch(testDb, 'non-existent-id', 'main');
      }).not.toThrow();
    });
  });

  describe('getInitialBranch', () => {
    beforeEach(() => {
      // Create test worktree with initial_branch
      const now = Date.now();
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, repository_path, repository_name, initial_branch, updated_at)
        VALUES ('test-worktree-id', 'test-worktree', '/path/to/worktree', '/path/to/repo', 'test-repo', 'main', ?)
      `).run(now);
    });

    it('should return initial branch for a worktree', () => {
      const result = getInitialBranch(testDb, 'test-worktree-id');
      expect(result).toBe('main');
    });

    it('should return null for worktree without initial_branch', () => {
      // Create worktree without initial_branch
      const now = Date.now();
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
        VALUES ('no-branch-id', 'no-branch', '/path/to/no-branch', '/path/to/repo', 'test-repo', ?)
      `).run(now);

      const result = getInitialBranch(testDb, 'no-branch-id');
      expect(result).toBeNull();
    });

    it('should return null for non-existent worktree', () => {
      const result = getInitialBranch(testDb, 'non-existent-id');
      expect(result).toBeNull();
    });
  });
});
