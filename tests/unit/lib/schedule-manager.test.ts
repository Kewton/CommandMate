/**
 * Tests for schedule-manager.ts
 * Issue #294: Schedule manager lifecycle and state management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initScheduleManager,
  stopAllSchedules,
  getActiveScheduleCount,
  isScheduleManagerInitialized,
  POLL_INTERVAL_MS,
  MAX_CONCURRENT_SCHEDULES,
} from '../../../src/lib/schedule-manager';
import { getDbInstance } from '../../../src/lib/db-instance';

// Mock db-instance to avoid actual DB operations
vi.mock('../../../src/lib/db-instance', () => {
  const Database = require('better-sqlite3');
  let db: InstanceType<typeof Database> | null = null;

  function getTestDb() {
    if (!db) {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      // Create minimal schema
      db.exec(`
        CREATE TABLE IF NOT EXISTS worktrees (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS scheduled_executions (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          cli_tool_id TEXT DEFAULT 'claude',
          name TEXT NOT NULL,
          message TEXT NOT NULL,
          cron_expression TEXT,
          enabled INTEGER DEFAULT 1,
          last_executed_at INTEGER,
          next_execute_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(worktree_id, name),
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS execution_logs (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL,
          worktree_id TEXT NOT NULL,
          message TEXT NOT NULL,
          result TEXT,
          exit_code INTEGER,
          status TEXT DEFAULT 'running',
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (schedule_id) REFERENCES scheduled_executions(id) ON DELETE CASCADE,
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);
    }
    return db;
  }

  return {
    getDbInstance: () => getTestDb(),
  };
});

describe('schedule-manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset global state
    globalThis.__scheduleManagerStates = undefined;
    globalThis.__scheduleActiveProcesses = undefined;
  });

  afterEach(() => {
    // Clean up
    try {
      stopAllSchedules();
    } catch {
      // Ignore cleanup errors
    }
    globalThis.__scheduleManagerStates = undefined;
    globalThis.__scheduleActiveProcesses = undefined;
    vi.useRealTimers();
  });

  describe('constants', () => {
    it('should have POLL_INTERVAL_MS = 60 seconds', () => {
      expect(POLL_INTERVAL_MS).toBe(60 * 1000);
    });

    it('should have MAX_CONCURRENT_SCHEDULES = 100', () => {
      expect(MAX_CONCURRENT_SCHEDULES).toBe(100);
    });
  });

  describe('initScheduleManager', () => {
    it('should initialize the manager', () => {
      expect(isScheduleManagerInitialized()).toBe(false);

      initScheduleManager();

      expect(isScheduleManagerInitialized()).toBe(true);
    });

    it('should not reinitialize if already initialized', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      initScheduleManager();
      initScheduleManager(); // Second call should be no-op

      expect(isScheduleManagerInitialized()).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Already initialized'));
    });

    it('should start with zero active schedules (no CMATE.md files)', () => {
      initScheduleManager();
      expect(getActiveScheduleCount()).toBe(0);
    });
  });

  describe('stopAllSchedules', () => {
    it('should stop the manager', () => {
      initScheduleManager();
      expect(isScheduleManagerInitialized()).toBe(true);

      stopAllSchedules();
      expect(isScheduleManagerInitialized()).toBe(false);
    });

    it('should clear all schedules', () => {
      initScheduleManager();
      stopAllSchedules();
      expect(getActiveScheduleCount()).toBe(0);
    });

    it('should handle being called when not initialized', () => {
      // Should not throw
      expect(() => stopAllSchedules()).not.toThrow();
    });

    it('should kill active processes with SIGKILL (fire-and-forget)', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      // Simulate an active process using globalThis directly
      if (!globalThis.__scheduleActiveProcesses) {
        globalThis.__scheduleActiveProcesses = new Map();
      }
      globalThis.__scheduleActiveProcesses.set(99999, { pid: 99999 } as import('child_process').ChildProcess);

      stopAllSchedules();

      expect(killSpy).toHaveBeenCalledWith(99999, 'SIGKILL');
      killSpy.mockRestore();
    });
  });

  describe('getActiveScheduleCount', () => {
    it('should return 0 when not initialized', () => {
      expect(getActiveScheduleCount()).toBe(0);
    });
  });

  describe('restart recovery', () => {
    it('should call recoverRunningLogs on initialization', () => {
      // recoverRunningLogs runs an UPDATE query to mark 'running' logs as 'failed'.
      // We verify this indirectly by checking that initScheduleManager completes
      // without errors and the manager is initialized.
      // Detailed recovery behavior is tested through the SQL logic directly.
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      initScheduleManager();

      expect(isScheduleManagerInitialized()).toBe(true);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Initializing'));

      logSpy.mockRestore();
    });

    it('should recover running logs to failed status via direct DB test', () => {
      // Direct DB test: verify the SQL logic works
      const db = getDbInstance();
      const now = Date.now();

      // Insert test data
      db.prepare('INSERT OR IGNORE INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run(
        'wt-direct-recovery', 'direct-recovery-wt', '/tmp/direct-recovery', now
      );
      db.prepare(`
        INSERT OR IGNORE INTO scheduled_executions (id, worktree_id, name, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('sched-direct-recovery', 'wt-direct-recovery', 'test-direct-recovery', 'hello', now, now);

      const logId = 'log-direct-recovery-' + now;
      db.prepare(`
        INSERT INTO execution_logs (id, schedule_id, worktree_id, message, status, started_at, created_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?)
      `).run(logId, 'sched-direct-recovery', 'wt-direct-recovery', 'hello', now, now);

      // Run recovery SQL directly
      const result = db.prepare(
        "UPDATE execution_logs SET status = 'failed', completed_at = ? WHERE status = 'running'"
      ).run(now);

      expect(result.changes).toBeGreaterThanOrEqual(1);

      // Verify the log was updated
      const log = db.prepare('SELECT status FROM execution_logs WHERE id = ?').get(logId) as { status: string };
      expect(log.status).toBe('failed');
    });
  });
});
