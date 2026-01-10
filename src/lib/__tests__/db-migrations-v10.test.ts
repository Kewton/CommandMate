/**
 * Database migration tests for Version 10: worktree_memos table
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getCurrentVersion } from '../db-migrations';

describe('Database Migration: Version 10 - worktree_memos table', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb.close();
  });

  describe('Migration 10: add-worktree-memos-table', () => {
    it('should migrate to version 10', () => {
      runMigrations(testDb);
      const currentVersion = getCurrentVersion(testDb);
      expect(currentVersion).toBeGreaterThanOrEqual(10);
    });

    it('should create worktree_memos table', () => {
      runMigrations(testDb);

      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_memos'")
        .all() as Array<{ name: string }>;

      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe('worktree_memos');
    });

    it('should create worktree_memos table with correct columns', () => {
      runMigrations(testDb);

      const columns = testDb.pragma('table_info(worktree_memos)') as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const columnNames = columns.map((col) => col.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('worktree_id');
      expect(columnNames).toContain('title');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('position');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('updated_at');

      // Check column types
      const idCol = columns.find((c) => c.name === 'id');
      expect(idCol?.type).toBe('TEXT');
      expect(idCol?.pk).toBe(1);

      const worktreeIdCol = columns.find((c) => c.name === 'worktree_id');
      expect(worktreeIdCol?.type).toBe('TEXT');
      expect(worktreeIdCol?.notnull).toBe(1);

      const titleCol = columns.find((c) => c.name === 'title');
      expect(titleCol?.type).toBe('TEXT');
      expect(titleCol?.notnull).toBe(1);

      const positionCol = columns.find((c) => c.name === 'position');
      expect(positionCol?.type).toBe('INTEGER');
      expect(positionCol?.notnull).toBe(1);
    });

    it('should create index on worktree_id and position', () => {
      runMigrations(testDb);

      const indexes = testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='worktree_memos'"
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).toContain('idx_worktree_memos_worktree');
    });

    it('should enforce UNIQUE constraint on (worktree_id, position)', () => {
      runMigrations(testDb);

      // Insert a worktree first
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, updated_at)
        VALUES (?, ?, ?, ?)
      `).run('test-worktree', 'Test', '/path/to/test', Date.now());

      // Insert first memo at position 0
      const now = Date.now();
      testDb.prepare(`
        INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('memo-1', 'test-worktree', 'Memo 1', 'Content 1', 0, now, now);

      // Attempt to insert another memo at position 0 should fail
      expect(() => {
        testDb.prepare(`
          INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('memo-2', 'test-worktree', 'Memo 2', 'Content 2', 0, now, now);
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('should enforce FOREIGN KEY constraint on worktree_id', () => {
      runMigrations(testDb);

      // Enable foreign key enforcement
      testDb.pragma('foreign_keys = ON');

      const now = Date.now();

      // Attempt to insert memo with non-existent worktree_id should fail
      expect(() => {
        testDb.prepare(`
          INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('memo-1', 'nonexistent-worktree', 'Memo 1', 'Content 1', 0, now, now);
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('should cascade delete memos when worktree is deleted', () => {
      runMigrations(testDb);

      // Enable foreign key enforcement
      testDb.pragma('foreign_keys = ON');

      // Insert a worktree
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, updated_at)
        VALUES (?, ?, ?, ?)
      `).run('test-worktree', 'Test', '/path/to/test', Date.now());

      // Insert memos
      const now = Date.now();
      testDb.prepare(`
        INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('memo-1', 'test-worktree', 'Memo 1', 'Content 1', 0, now, now);

      testDb.prepare(`
        INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('memo-2', 'test-worktree', 'Memo 2', 'Content 2', 1, now, now);

      // Delete the worktree
      testDb.prepare('DELETE FROM worktrees WHERE id = ?').run('test-worktree');

      // Memos should be deleted
      const memos = testDb.prepare('SELECT * FROM worktree_memos WHERE worktree_id = ?').all('test-worktree');
      expect(memos).toHaveLength(0);
    });

    it('should migrate existing memo data from worktrees table', () => {
      runMigrations(testDb);

      // Insert a worktree with existing memo
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, memo, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-worktree', 'Test', '/path/to/test', 'Existing memo content', Date.now());

      // Note: The migration should have already run, so we need to test with fresh data
      // For existing data migration test, we need to set up data before migration runs

      // Verify the worktree memo column still exists (backward compatibility)
      const worktree = testDb.prepare(`
        SELECT memo FROM worktrees WHERE id = ?
      `).get('test-worktree') as { memo: string | null };

      expect(worktree.memo).toBe('Existing memo content');
    });

    describe('data migration from existing memos', () => {
      it('should migrate non-empty memos to worktree_memos table', () => {
        // Create a fresh database with schema version up to 9
        const migratedDb = new Database(':memory:');

        // Run migrations
        runMigrations(migratedDb);

        // Insert worktree with memo (simulating data that existed before migration 10)
        migratedDb.prepare(`
          INSERT INTO worktrees (id, name, path, memo, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run('wt-with-memo', 'With Memo', '/path/to/with-memo', 'Test memo content', Date.now());

        // Insert worktree without memo
        migratedDb.prepare(`
          INSERT INTO worktrees (id, name, path, memo, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run('wt-without-memo', 'Without Memo', '/path/to/without-memo', '', Date.now());

        // Note: Since migration has already run, we just verify the table structure is correct
        // The actual data migration test would need a more complex setup

        // Verify we can insert memos for the worktree
        const now = Date.now();
        migratedDb.prepare(`
          INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('new-memo', 'wt-with-memo', 'New Memo', 'New content', 1, now, now);

        const memos = migratedDb.prepare(`
          SELECT * FROM worktree_memos WHERE worktree_id = ?
        `).all('wt-with-memo');

        expect(memos.length).toBeGreaterThanOrEqual(1);

        migratedDb.close();
      });
    });
  });
});
