/**
 * Database Migration Tests
 * Issue #136: Phase 2 - Task 2.2
 * Tests for Migration #16: issue_no column for external_apps
 * Issue #294: Migration #17: scheduled_executions and execution_logs
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
    // Enable foreign keys for CASCADE tests
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  describe('CURRENT_SCHEMA_VERSION', () => {
    it('should be 17 after Migration #17', () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(17);
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
      expect(history.find(m => m.version === 17)?.name).toBe('add-scheduled-executions-and-execution-logs');
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
      db.prepare(`
        INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at)
        VALUES ('main-app', 'main', 'Main App', '/main', 3000, 'localhost', 'other', 1, ?, ?)
      `).run(Date.now(), Date.now());

      db.prepare(`
        INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at, issue_no)
        VALUES ('worktree-135', 'wt-135', 'Worktree 135', '/wt135', 3001, 'localhost', 'other', 1, ?, ?, 135)
      `).run(Date.now(), Date.now());

      db.prepare(`
        INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at, issue_no)
        VALUES ('worktree-200', 'wt-200', 'Worktree 200', '/wt200', 3002, 'localhost', 'other', 1, ?, ?, 200)
      `).run(Date.now(), Date.now());

      const mainApps = db.prepare(
        'SELECT * FROM external_apps WHERE enabled = 1 AND issue_no IS NULL'
      ).all() as Array<{ id: string }>;
      expect(mainApps).toHaveLength(1);
      expect(mainApps[0].id).toBe('main-app');

      const wt135Apps = db.prepare(
        'SELECT * FROM external_apps WHERE enabled = 1 AND issue_no = ?'
      ).all(135) as Array<{ id: string }>;
      expect(wt135Apps).toHaveLength(1);
      expect(wt135Apps[0].id).toBe('worktree-135');

      const allApps = db.prepare(
        'SELECT * FROM external_apps WHERE enabled = 1'
      ).all() as Array<{ id: string }>;
      expect(allApps).toHaveLength(3);
    });

    it('should maintain existing table structure', () => {
      const columns = db.prepare("PRAGMA table_info('external_apps')").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map(c => c.name);

      const expectedColumns = [
        'id', 'name', 'display_name', 'description', 'path_prefix',
        'target_port', 'target_host', 'app_type', 'websocket_enabled',
        'websocket_path_pattern', 'enabled', 'created_at', 'updated_at',
        'issue_no',
      ];

      for (const col of expectedColumns) {
        expect(columnNames).toContain(col);
      }
    });
  });

  describe('Migration #17: scheduled_executions and execution_logs', () => {
    beforeEach(() => {
      runMigrations(db);
    });

    it('should create scheduled_executions table', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_executions'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('should create execution_logs table', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='execution_logs'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('should have correct columns in scheduled_executions', () => {
      const columns = db.prepare("PRAGMA table_info('scheduled_executions')").all() as Array<{
        name: string;
        type: string;
      }>;
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('worktree_id');
      expect(columnNames).toContain('cli_tool_id');
      expect(columnNames).toContain('name');
      expect(columnNames).toContain('message');
      expect(columnNames).toContain('cron_expression');
      expect(columnNames).toContain('enabled');
      expect(columnNames).toContain('last_executed_at');
      expect(columnNames).toContain('next_execute_at');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('updated_at');
    });

    it('should have correct columns in execution_logs', () => {
      const columns = db.prepare("PRAGMA table_info('execution_logs')").all() as Array<{
        name: string;
        type: string;
      }>;
      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('schedule_id');
      expect(columnNames).toContain('worktree_id');
      expect(columnNames).toContain('message');
      expect(columnNames).toContain('result');
      expect(columnNames).toContain('exit_code');
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('started_at');
      expect(columnNames).toContain('completed_at');
      expect(columnNames).toContain('created_at');
    });

    it('should have UNIQUE constraint on (worktree_id, name) in scheduled_executions', () => {
      const now = Date.now();
      // Insert a worktree first
      db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(
        'wt-1', 'test-wt', '/tmp/test', now
      );

      // Insert first schedule
      db.prepare(`
        INSERT INTO scheduled_executions (id, worktree_id, name, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('sched-1', 'wt-1', 'daily', 'hello', now, now);

      // Inserting duplicate (worktree_id, name) should fail
      expect(() => {
        db.prepare(`
          INSERT INTO scheduled_executions (id, worktree_id, name, message, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('sched-2', 'wt-1', 'daily', 'hello2', now, now);
      }).toThrow();
    });

    it('should enforce status CHECK constraint on execution_logs', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(
        'wt-1', 'test-wt', '/tmp/test', now
      );
      db.prepare(`
        INSERT INTO scheduled_executions (id, worktree_id, name, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('sched-1', 'wt-1', 'daily', 'hello', now, now);

      // Valid status should work
      expect(() => {
        db.prepare(`
          INSERT INTO execution_logs (id, schedule_id, worktree_id, message, status, started_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('log-1', 'sched-1', 'wt-1', 'hello', 'running', now, now);
      }).not.toThrow();

      // Invalid status should fail
      expect(() => {
        db.prepare(`
          INSERT INTO execution_logs (id, schedule_id, worktree_id, message, status, started_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('log-2', 'sched-1', 'wt-1', 'hello', 'invalid_status', now, now);
      }).toThrow();
    });

    it('should CREATE indexes for schedule tables', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND (tbl_name='scheduled_executions' OR tbl_name='execution_logs')"
      ).all() as Array<{ name: string }>;
      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_scheduled_executions_worktree');
      expect(indexNames).toContain('idx_scheduled_executions_enabled');
      expect(indexNames).toContain('idx_execution_logs_schedule');
      expect(indexNames).toContain('idx_execution_logs_worktree');
      expect(indexNames).toContain('idx_execution_logs_status');
    });
  });

  describe('CASCADE delete tests (with PRAGMA foreign_keys = ON)', () => {
    beforeEach(() => {
      runMigrations(db);
    });

    it('should CASCADE delete scheduled_executions when worktree is deleted', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(
        'wt-cascade', 'cascade-wt', '/tmp/cascade', now
      );
      db.prepare(`
        INSERT INTO scheduled_executions (id, worktree_id, name, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('sched-cascade', 'wt-cascade', 'daily', 'hello', now, now);

      // Verify schedule exists
      const before = db.prepare('SELECT COUNT(*) as count FROM scheduled_executions WHERE worktree_id = ?').get('wt-cascade') as { count: number };
      expect(before.count).toBe(1);

      // Delete worktree
      db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-cascade');

      // Verify schedule was CASCADE deleted
      const after = db.prepare('SELECT COUNT(*) as count FROM scheduled_executions WHERE worktree_id = ?').get('wt-cascade') as { count: number };
      expect(after.count).toBe(0);
    });

    it('should CASCADE delete execution_logs when worktree is deleted (double CASCADE path)', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(
        'wt-double', 'double-wt', '/tmp/double', now
      );
      db.prepare(`
        INSERT INTO scheduled_executions (id, worktree_id, name, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('sched-double', 'wt-double', 'daily', 'hello', now, now);
      db.prepare(`
        INSERT INTO execution_logs (id, schedule_id, worktree_id, message, status, started_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('log-double', 'sched-double', 'wt-double', 'hello', 'running', now, now);

      // Verify log exists
      const before = db.prepare('SELECT COUNT(*) as count FROM execution_logs WHERE worktree_id = ?').get('wt-double') as { count: number };
      expect(before.count).toBe(1);

      // Delete worktree - should CASCADE through both paths
      db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-double');

      // Verify execution log was CASCADE deleted
      const after = db.prepare('SELECT COUNT(*) as count FROM execution_logs WHERE worktree_id = ?').get('wt-double') as { count: number };
      expect(after.count).toBe(0);
    });

    it('should CASCADE delete execution_logs when schedule is deleted', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(
        'wt-sched-del', 'sched-del-wt', '/tmp/sched-del', now
      );
      db.prepare(`
        INSERT INTO scheduled_executions (id, worktree_id, name, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('sched-del', 'wt-sched-del', 'daily', 'hello', now, now);
      db.prepare(`
        INSERT INTO execution_logs (id, schedule_id, worktree_id, message, status, started_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('log-sched-del', 'sched-del', 'wt-sched-del', 'hello', 'completed', now, now);

      // Delete schedule
      db.prepare('DELETE FROM scheduled_executions WHERE id = ?').run('sched-del');

      // Verify execution log was CASCADE deleted
      const after = db.prepare('SELECT COUNT(*) as count FROM execution_logs WHERE schedule_id = ?').get('sched-del') as { count: number };
      expect(after.count).toBe(0);

      // Worktree should still exist
      const wt = db.prepare('SELECT COUNT(*) as count FROM worktrees WHERE id = ?').get('wt-sched-del') as { count: number };
      expect(wt.count).toBe(1);
    });

    it('should CASCADE delete chat_messages when worktree is deleted', () => {
      const now = Date.now();
      db.prepare(`INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)`).run(
        'wt-chat', 'chat-wt', '/tmp/chat', now
      );
      db.prepare(`
        INSERT INTO chat_messages (id, worktree_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run('msg-1', 'wt-chat', 'user', 'hello', now);

      db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-chat');

      const after = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE worktree_id = ?').get('wt-chat') as { count: number };
      expect(after.count).toBe(0);
    });
  });

  describe('rollbackMigrations', () => {
    it('should rollback Migration #17 and remove schedule tables', () => {
      runMigrations(db);
      expect(getCurrentVersion(db)).toBe(17);

      rollbackMigrations(db, 16);
      expect(getCurrentVersion(db)).toBe(16);

      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('scheduled_executions', 'execution_logs')"
      ).all();
      expect(tables).toHaveLength(0);
    });

    it('should rollback Migration #16 and remove issue_no column', () => {
      runMigrations(db);
      expect(getCurrentVersion(db)).toBe(17);

      rollbackMigrations(db, 15);
      expect(getCurrentVersion(db)).toBe(15);

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

    it('should validate that all required tables exist', () => {
      runMigrations(db);

      const requiredTables = [
        'worktrees', 'chat_messages', 'session_states', 'schema_version',
        'worktree_memos', 'external_apps', 'repositories', 'clone_jobs',
        'scheduled_executions', 'execution_logs',
      ];

      for (const tableName of requiredTables) {
        const tables = db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`
        ).all();
        expect(tables).toHaveLength(1);
      }
    });
  });

  describe('Migration idempotency', () => {
    it('should not fail if run multiple times', () => {
      runMigrations(db);
      expect(() => runMigrations(db)).not.toThrow();

      expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    });
  });
});
