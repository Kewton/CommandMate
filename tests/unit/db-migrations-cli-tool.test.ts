/**
 * Database migration tests for CLI tool support
 * Tests migration 7: add cli_tool_id column
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getCurrentVersion } from '@/lib/db-migrations';

describe('Database Migration: CLI Tool Support', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb.close();
  });

  describe('Migration 7: add-cli-tool-id', () => {
    it('should add cli_tool_id column to worktrees table', () => {
      // Run all migrations
      runMigrations(testDb);

      // Check that cli_tool_id column exists
      const columns = testDb.pragma(`table_info(worktrees)`) as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;

      const cliToolIdColumn = columns.find(col => col.name === 'cli_tool_id');

      expect(cliToolIdColumn).toBeDefined();
      expect(cliToolIdColumn?.type).toBe('TEXT');
    });

    it('should set default value to claude for cli_tool_id', () => {
      // Run all migrations
      runMigrations(testDb);

      // Insert a worktree without specifying cli_tool_id
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, updated_at)
        VALUES (?, ?, ?, ?)
      `).run('test-worktree', 'Test', '/path/to/test', Date.now());

      // Check that cli_tool_id is set to 'claude' by default
      const worktree = testDb.prepare(`
        SELECT cli_tool_id FROM worktrees WHERE id = ?
      `).get('test-worktree') as { cli_tool_id: string };

      expect(worktree.cli_tool_id).toBe('claude');
    });

    it('should allow setting cli_tool_id to codex', () => {
      // Run all migrations
      runMigrations(testDb);

      // Insert a worktree with cli_tool_id = 'codex'
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-worktree', 'Test', '/path/to/test', 'codex', Date.now());

      // Check that cli_tool_id is set to 'codex'
      const worktree = testDb.prepare(`
        SELECT cli_tool_id FROM worktrees WHERE id = ?
      `).get('test-worktree') as { cli_tool_id: string };

      expect(worktree.cli_tool_id).toBe('codex');
    });

    it('should allow setting cli_tool_id to gemini', () => {
      // Run all migrations
      runMigrations(testDb);

      // Insert a worktree with cli_tool_id = 'gemini'
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-worktree', 'Test', '/path/to/test', 'gemini', Date.now());

      // Check that cli_tool_id is set to 'gemini'
      const worktree = testDb.prepare(`
        SELECT cli_tool_id FROM worktrees WHERE id = ?
      `).get('test-worktree') as { cli_tool_id: string };

      expect(worktree.cli_tool_id).toBe('gemini');
    });

    it('should create index on cli_tool_id', () => {
      // Run all migrations
      runMigrations(testDb);

      // Check that index exists
      const indexes = testDb.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND tbl_name='worktrees' AND name LIKE '%cli_tool%'
      `).all() as Array<{ name: string }>;

      const cliToolIndex = indexes.find(idx => idx.name === 'idx_worktrees_cli_tool');

      expect(cliToolIndex).toBeDefined();
    });

    it('should migrate to version 7', () => {
      // Run all migrations
      runMigrations(testDb);

      // Check current version
      const currentVersion = getCurrentVersion(testDb);

      expect(currentVersion).toBeGreaterThanOrEqual(7);
    });

    it('should migrate existing worktrees to use claude by default', () => {
      // Run all migrations
      runMigrations(testDb);

      // Insert a test worktree and verify it gets cli_tool_id = 'claude'
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, updated_at)
        VALUES (?, ?, ?, ?)
      `).run('test-wt-1', 'Test 1', '/path/to/test1', Date.now());

      // Check that the worktree has cli_tool_id set to 'claude'
      const worktree = testDb.prepare(`
        SELECT cli_tool_id FROM worktrees WHERE id = ?
      `).get('test-wt-1') as { cli_tool_id: string };

      expect(worktree.cli_tool_id).toBe('claude');

      // Insert another worktree with explicit cli_tool_id
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-wt-2', 'Test 2', '/path/to/test2', 'codex', Date.now());

      // Check that all worktrees have valid cli_tool_id
      const allWorktrees = testDb.prepare(`
        SELECT id, cli_tool_id FROM worktrees
      `).all() as Array<{ id: string; cli_tool_id: string }>;

      // All worktrees should have a cli_tool_id value
      allWorktrees.forEach(wt => {
        expect(wt.cli_tool_id).toBeDefined();
        expect(['claude', 'codex', 'gemini']).toContain(wt.cli_tool_id);
      });
    });
  });
});
