/**
 * Database migration tests for Clone URL feature
 * Issue #71: Clone URL registration feature
 * TDD Approach: Test migration #14 (repositories + clone_jobs tables)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getCurrentVersion } from '@/lib/db/db-migrations';

describe('Clone URL Migrations', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb.close();
  });

  describe('Migration #14: repositories and clone_jobs tables', () => {
    beforeEach(() => {
      // Run all migrations including #14
      runMigrations(testDb);
    });

    it('should create repositories table', () => {
      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repositories'")
        .get();

      expect(tables).toBeDefined();
    });

    it('should create clone_jobs table', () => {
      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clone_jobs'")
        .get();

      expect(tables).toBeDefined();
    });

    it('should have correct columns in repositories table', () => {
      const columns = testDb
        .prepare("PRAGMA table_info(repositories)")
        .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;

      const columnNames = columns.map(c => c.name);

      // Required columns
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('name');
      expect(columnNames).toContain('path');
      expect(columnNames).toContain('enabled');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('updated_at');

      // New columns for Issue #71
      expect(columnNames).toContain('clone_url');
      expect(columnNames).toContain('normalized_clone_url');
      expect(columnNames).toContain('clone_source');
      expect(columnNames).toContain('is_env_managed');
    });

    it('should have correct columns in clone_jobs table', () => {
      const columns = testDb
        .prepare("PRAGMA table_info(clone_jobs)")
        .all() as Array<{ name: string; type: string; notnull: number }>;

      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('clone_url');
      expect(columnNames).toContain('normalized_clone_url');
      expect(columnNames).toContain('target_path');
      expect(columnNames).toContain('repository_id');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('pid');
      expect(columnNames).toContain('progress');
      expect(columnNames).toContain('error_category');
      expect(columnNames).toContain('error_code');
      expect(columnNames).toContain('error_message');
      expect(columnNames).toContain('started_at');
      expect(columnNames).toContain('completed_at');
      expect(columnNames).toContain('created_at');
    });

    it('should have unique constraint on repositories.normalized_clone_url', () => {
      // Insert first repository
      testDb.prepare(`
        INSERT INTO repositories (id, name, path, enabled, clone_url, normalized_clone_url, clone_source, is_env_managed, created_at, updated_at)
        VALUES ('repo-1', 'test-repo', '/path/to/repo', 1, 'https://github.com/user/repo.git', 'https://github.com/user/repo', 'https', 0, ?, ?)
      `).run(Date.now(), Date.now());

      // Attempt to insert with same normalized_clone_url should fail
      expect(() => {
        testDb.prepare(`
          INSERT INTO repositories (id, name, path, enabled, clone_url, normalized_clone_url, clone_source, is_env_managed, created_at, updated_at)
          VALUES ('repo-2', 'test-repo-2', '/path/to/repo2', 1, 'git@github.com:user/repo.git', 'https://github.com/user/repo', 'ssh', 0, ?, ?)
        `).run(Date.now(), Date.now());
      }).toThrow();
    });

    it('should have unique constraint on repositories.path', () => {
      // Insert first repository
      testDb.prepare(`
        INSERT INTO repositories (id, name, path, enabled, clone_url, normalized_clone_url, clone_source, is_env_managed, created_at, updated_at)
        VALUES ('repo-1', 'test-repo', '/path/to/repo', 1, 'https://github.com/user/repo1.git', 'https://github.com/user/repo1', 'https', 0, ?, ?)
      `).run(Date.now(), Date.now());

      // Attempt to insert with same path should fail
      expect(() => {
        testDb.prepare(`
          INSERT INTO repositories (id, name, path, enabled, clone_url, normalized_clone_url, clone_source, is_env_managed, created_at, updated_at)
          VALUES ('repo-2', 'test-repo-2', '/path/to/repo', 1, 'https://github.com/user/repo2.git', 'https://github.com/user/repo2', 'https', 0, ?, ?)
        `).run(Date.now(), Date.now());
      }).toThrow();
    });

    it('should have index on repositories.normalized_clone_url', () => {
      const indexes = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='repositories'")
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames.some(name => name.includes('normalized_clone_url'))).toBe(true);
    });

    it('should have index on clone_jobs.status', () => {
      const indexes = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='clone_jobs'")
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames.some(name => name.includes('status'))).toBe(true);
    });

    it('should allow NULL for normalized_clone_url (for local repos)', () => {
      // Local repositories scanned from disk don't have clone URLs
      expect(() => {
        testDb.prepare(`
          INSERT INTO repositories (id, name, path, enabled, clone_url, normalized_clone_url, clone_source, is_env_managed, created_at, updated_at)
          VALUES ('repo-local', 'local-repo', '/path/to/local/repo', 1, NULL, NULL, 'local', 0, ?, ?)
        `).run(Date.now(), Date.now());
      }).not.toThrow();
    });

    it('should enforce clone_source check constraint', () => {
      expect(() => {
        testDb.prepare(`
          INSERT INTO repositories (id, name, path, enabled, clone_url, normalized_clone_url, clone_source, is_env_managed, created_at, updated_at)
          VALUES ('repo-1', 'test-repo', '/path/to/repo', 1, 'https://github.com/user/repo.git', 'https://github.com/user/repo', 'invalid', 0, ?, ?)
        `).run(Date.now(), Date.now());
      }).toThrow();
    });

    it('should enforce clone_jobs.status check constraint', () => {
      expect(() => {
        testDb.prepare(`
          INSERT INTO clone_jobs (id, clone_url, normalized_clone_url, target_path, status, progress, created_at)
          VALUES ('job-1', 'https://github.com/user/repo.git', 'https://github.com/user/repo', '/path/to/repo', 'invalid_status', 0, ?)
        `).run(Date.now());
      }).toThrow();
    });
  });

  describe('Schema version', () => {
    it('should update schema version to 14 after migration', () => {
      runMigrations(testDb);
      const version = getCurrentVersion(testDb);
      expect(version).toBeGreaterThanOrEqual(14);
    });
  });
});
