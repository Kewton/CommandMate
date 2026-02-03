/**
 * Database Migration Tests
 * Issue #136: Phase 2 - Task 2.2
 * Tests for Migration #16: issue_no column for external_apps
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  CURRENT_SCHEMA_VERSION,
  runMigrations,
  getCurrentVersion,
  getMigrationHistory,
  validateSchema,
  rollbackMigrations,
} from '../../../src/lib/db-migrations';

describe('db-migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(':memory:');
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('CURRENT_SCHEMA_VERSION', () => {
    it('should be 16 after Migration #16', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(16);
    });
  });

  describe('runMigrations', () => {
    it('should apply all migrations to an empty database', () => {
      runMigrations(db);

      const version = getCurrentVersion(db);
      expect(version).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('should create schema_version table', () => {
      runMigrations(db);

      const result = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
      ).get() as { name: string } | undefined;

      expect(result?.name).toBe('schema_version');
    });

    it('should record migration history', () => {
      runMigrations(db);

      const history = getMigrationHistory(db);
      expect(history.length).toBe(CURRENT_SCHEMA_VERSION);
      expect(history.find(m => m.version === 16)?.name).toBe('add-issue-no-to-external-apps');
    });
  });

  describe('Migration #16: add-issue-no-to-external-apps', () => {
    beforeEach(() => {
      // Run all migrations
      runMigrations(db);
    });

    it('should add issue_no column to external_apps table', () => {
      // Check if issue_no column exists
      const columns = db.prepare("PRAGMA table_info('external_apps')").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;

      const issueNoColumn = columns.find(col => col.name === 'issue_no');
      expect(issueNoColumn).toBeDefined();
      expect(issueNoColumn?.type).toBe('INTEGER');
      expect(issueNoColumn?.notnull).toBe(0); // Nullable
    });

    it('should create index on issue_no column', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='external_apps'"
      ).all() as Array<{ name: string }>;

      const issueNoIndex = indexes.find(idx => idx.name === 'idx_external_apps_issue_no');
      expect(issueNoIndex).toBeDefined();
    });

    it('should preserve existing external_apps data with issue_no = NULL', () => {
      // Insert test data before migration (simulating existing data)
      const insertStmt = db.prepare(`
        INSERT INTO external_apps (id, name, display_name, description, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        'test-app-id',
        'test-app',
        'Test App',
        'A test application',
        '/test',
        3001,
        'localhost',
        'other',
        1,
        Date.now(),
        Date.now()
      );

      // Check that existing data has issue_no = NULL
      const app = db.prepare('SELECT * FROM external_apps WHERE id = ?').get('test-app-id') as {
        id: string;
        issue_no: number | null;
      };

      expect(app.id).toBe('test-app-id');
      expect(app.issue_no).toBeNull();
    });

    it('should allow inserting external_apps with issue_no', () => {
      const insertStmt = db.prepare(`
        INSERT INTO external_apps (id, name, display_name, description, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at, issue_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        'worktree-app-id',
        'worktree-135',
        'Worktree #135',
        'Worktree for Issue #135',
        'commandmate_issue/135',
        3002,
        'localhost',
        'other',
        1,
        Date.now(),
        Date.now(),
        135
      );

      const app = db.prepare('SELECT * FROM external_apps WHERE id = ?').get('worktree-app-id') as {
        id: string;
        issue_no: number;
      };

      expect(app.issue_no).toBe(135);
    });

    it('should support querying by issue_no', () => {
      // Insert main app (issue_no = NULL)
      db.prepare(`
        INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at)
        VALUES ('main-app', 'main', 'Main App', '/main', 3000, 'localhost', 'other', 1, ?, ?)
      `).run(Date.now(), Date.now());

      // Insert worktree app (issue_no = 135)
      db.prepare(`
        INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at, issue_no)
        VALUES ('worktree-135', 'wt-135', 'Worktree 135', '/wt135', 3001, 'localhost', 'other', 1, ?, ?, 135)
      `).run(Date.now(), Date.now());

      // Insert worktree app (issue_no = 200)
      db.prepare(`
        INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at, issue_no)
        VALUES ('worktree-200', 'wt-200', 'Worktree 200', '/wt200', 3002, 'localhost', 'other', 1, ?, ?, 200)
      `).run(Date.now(), Date.now());

      // Query main apps (issue_no IS NULL)
      const mainApps = db.prepare(
        'SELECT * FROM external_apps WHERE enabled = 1 AND issue_no IS NULL'
      ).all() as Array<{ id: string }>;
      expect(mainApps).toHaveLength(1);
      expect(mainApps[0].id).toBe('main-app');

      // Query worktree 135
      const wt135Apps = db.prepare(
        'SELECT * FROM external_apps WHERE enabled = 1 AND issue_no = ?'
      ).all(135) as Array<{ id: string }>;
      expect(wt135Apps).toHaveLength(1);
      expect(wt135Apps[0].id).toBe('worktree-135');

      // Query all enabled apps
      const allApps = db.prepare(
        'SELECT * FROM external_apps WHERE enabled = 1'
      ).all() as Array<{ id: string }>;
      expect(allApps).toHaveLength(3);
    });

    it('should maintain existing table structure', () => {
      // Verify all original columns still exist
      const columns = db.prepare("PRAGMA table_info('external_apps')").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map(c => c.name);

      // Original columns from Migration #12
      const expectedColumns = [
        'id',
        'name',
        'display_name',
        'description',
        'path_prefix',
        'target_port',
        'target_host',
        'app_type',
        'websocket_enabled',
        'websocket_path_pattern',
        'enabled',
        'created_at',
        'updated_at',
        'issue_no', // Added in Migration #16
      ];

      for (const col of expectedColumns) {
        expect(columnNames).toContain(col);
      }
    });
  });

  describe('rollbackMigrations', () => {
    it('should rollback Migration #16 and remove issue_no column', () => {
      // Apply all migrations
      runMigrations(db);
      expect(getCurrentVersion(db)).toBe(16);

      // Rollback to version 15
      rollbackMigrations(db, 15);
      expect(getCurrentVersion(db)).toBe(15);

      // Check that issue_no column no longer exists
      const columns = db.prepare("PRAGMA table_info('external_apps')").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map(c => c.name);

      expect(columnNames).not.toContain('issue_no');
    });

    it('should remove idx_external_apps_issue_no index on rollback', () => {
      runMigrations(db);
      rollbackMigrations(db, 15);

      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_external_apps_issue_no'"
      ).all();

      expect(indexes).toHaveLength(0);
    });
  });

  describe('validateSchema', () => {
    it('should return true after all migrations', () => {
      runMigrations(db);
      expect(validateSchema(db)).toBe(true);
    });

    it('should validate that external_apps table exists', () => {
      runMigrations(db);

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='external_apps'"
      ).all();

      expect(tables).toHaveLength(1);
    });
  });

  describe('Migration #16 idempotency', () => {
    it('should not fail if run multiple times', () => {
      // Run migrations twice - should not throw
      runMigrations(db);
      expect(() => runMigrations(db)).not.toThrow();

      expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    });
  });
});
