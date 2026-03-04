/**
 * Schedule Manager cleanup function tests
 * Issue #404: Resource leak prevention - stopScheduleForWorktree
 *
 * Note: stopScheduleForWorktree() uses getLazyDbInstance() (CJS require) for
 * worktreeId->path resolution. In vitest, CJS require is not intercepted by
 * vi.mock, so the DB lookup falls through to the error fallback path.
 * The cmateFileCache test verifies the fallback behavior.
 * Full DB integration is tested in schedule-manager.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock croner
vi.mock('croner', () => ({
  Cron: vi.fn().mockImplementation(() => ({
    stop: vi.fn(),
    schedule: vi.fn(),
  })),
}));

// Mock db-instance
vi.mock('../../../src/lib/db-instance', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  let db: InstanceType<typeof Database> | null = null;

  function getTestDb() {
    if (!db) {
      db = new Database(':memory:');
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

// Mock cmate-parser
vi.mock('../../../src/lib/cmate-parser', () => ({
  readCmateFile: vi.fn().mockResolvedValue(null),
  parseSchedulesSection: vi.fn().mockReturnValue([]),
}));

// Mock claude-executor
vi.mock('../../../src/lib/claude-executor', () => ({
  executeClaudeCommand: vi.fn(),
  getActiveProcesses: vi.fn().mockReturnValue(new Map()),
}));

// Mock cmate-constants
vi.mock('../../../src/config/cmate-constants', () => ({
  CMATE_FILENAME: 'CMATE.md',
}));

import { stopScheduleForWorktree, getScheduleWorktreeIds } from '../../../src/lib/schedule-manager';

describe('Schedule Manager Cleanup Functions (Issue #404)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.__scheduleManagerStates = undefined;
  });

  afterEach(() => {
    globalThis.__scheduleManagerStates = undefined;
  });

  describe('stopScheduleForWorktree', () => {
    it('should stop cron jobs only for the target worktree', () => {
      const cronJobA = { stop: vi.fn(), schedule: vi.fn() };
      const cronJobB = { stop: vi.fn(), schedule: vi.fn() };
      const cronJobC = { stop: vi.fn(), schedule: vi.fn() };

      globalThis.__scheduleManagerStates = {
        timerId: null,
        schedules: new Map([
          ['sched-1', {
            scheduleId: 'sched-1',
            worktreeId: 'wt-target',
            cronJob: cronJobA as unknown as import('croner').Cron,
            isExecuting: false,
            entry: { name: 'task-1', message: 'msg', cronExpression: '* * * * *', cliToolId: 'claude', enabled: true, permission: 'default' },
          }],
          ['sched-2', {
            scheduleId: 'sched-2',
            worktreeId: 'wt-other',
            cronJob: cronJobB as unknown as import('croner').Cron,
            isExecuting: false,
            entry: { name: 'task-2', message: 'msg', cronExpression: '* * * * *', cliToolId: 'claude', enabled: true, permission: 'default' },
          }],
          ['sched-3', {
            scheduleId: 'sched-3',
            worktreeId: 'wt-target',
            cronJob: cronJobC as unknown as import('croner').Cron,
            isExecuting: false,
            entry: { name: 'task-3', message: 'msg', cronExpression: '* * * * *', cliToolId: 'claude', enabled: true, permission: 'default' },
          }],
        ]),
        initialized: true,
        isSyncing: false,
        cmateFileCache: new Map(),
      };

      stopScheduleForWorktree('wt-target');

      // Only target worktree's cron jobs stopped
      expect(cronJobA.stop).toHaveBeenCalled();
      expect(cronJobC.stop).toHaveBeenCalled();
      expect(cronJobB.stop).not.toHaveBeenCalled();

      // Target worktree schedules removed, other remains
      const schedules = globalThis.__scheduleManagerStates!.schedules;
      expect(schedules.has('sched-1')).toBe(false);
      expect(schedules.has('sched-3')).toBe(false);
      expect(schedules.has('sched-2')).toBe(true);
    });

    it('should not affect other worktree schedules', () => {
      const cronJobOther = { stop: vi.fn(), schedule: vi.fn() };

      globalThis.__scheduleManagerStates = {
        timerId: null,
        schedules: new Map([
          ['sched-other', {
            scheduleId: 'sched-other',
            worktreeId: 'wt-other',
            cronJob: cronJobOther as unknown as import('croner').Cron,
            isExecuting: false,
            entry: { name: 'other-task', message: 'msg', cronExpression: '* * * * *', cliToolId: 'claude', enabled: true, permission: 'default' },
          }],
        ]),
        initialized: true,
        isSyncing: false,
        cmateFileCache: new Map(),
      };

      stopScheduleForWorktree('wt-nonexistent');

      expect(cronJobOther.stop).not.toHaveBeenCalled();
      expect(globalThis.__scheduleManagerStates!.schedules.size).toBe(1);
    });

    it('should gracefully handle DB lookup failure and still stop schedules', () => {
      // This test verifies the fallback behavior: when getLazyDbInstance fails
      // (which happens in unit tests due to CJS require limitations),
      // schedules are still stopped, only cmateFileCache cleanup is skipped.
      const cronJob = { stop: vi.fn(), schedule: vi.fn() };

      globalThis.__scheduleManagerStates = {
        timerId: null,
        schedules: new Map([
          ['sched-1', {
            scheduleId: 'sched-1',
            worktreeId: 'wt-target',
            cronJob: cronJob as unknown as import('croner').Cron,
            isExecuting: false,
            entry: { name: 'task', message: 'msg', cronExpression: '* * * * *', cliToolId: 'claude', enabled: true, permission: 'default' },
          }],
        ]),
        initialized: true,
        isSyncing: false,
        cmateFileCache: new Map([
          ['/path/to/wt-target', 12345],
        ]),
      };

      // stopScheduleForWorktree should not throw even when DB access fails
      expect(() => stopScheduleForWorktree('wt-target')).not.toThrow();

      // Schedule still stopped
      expect(cronJob.stop).toHaveBeenCalled();
      expect(globalThis.__scheduleManagerStates!.schedules.size).toBe(0);

      // cmateFileCache entry preserved (DB lookup failed, so path unknown)
      // This is the expected fallback behavior per design
      expect(globalThis.__scheduleManagerStates!.cmateFileCache.has('/path/to/wt-target')).toBe(true);
    });

    it('should handle empty schedules map gracefully', () => {
      globalThis.__scheduleManagerStates = {
        timerId: null,
        schedules: new Map(),
        initialized: true,
        isSyncing: false,
        cmateFileCache: new Map(),
      };

      expect(() => stopScheduleForWorktree('wt-target')).not.toThrow();
    });

    it('should handle uninitialized manager state gracefully', () => {
      // getManagerState() will create a fresh state
      expect(() => stopScheduleForWorktree('wt-target')).not.toThrow();
    });
  });

  describe('getScheduleWorktreeIds', () => {
    it('should return unique worktree IDs from schedules', () => {
      const cronJob = { stop: vi.fn(), schedule: vi.fn() };

      globalThis.__scheduleManagerStates = {
        timerId: null,
        schedules: new Map([
          ['sched-1', {
            scheduleId: 'sched-1',
            worktreeId: 'wt-a',
            cronJob: cronJob as unknown as import('croner').Cron,
            isExecuting: false,
            entry: { name: 'task-1', message: 'msg', cronExpression: '* * * * *', cliToolId: 'claude', enabled: true, permission: 'default' },
          }],
          ['sched-2', {
            scheduleId: 'sched-2',
            worktreeId: 'wt-b',
            cronJob: cronJob as unknown as import('croner').Cron,
            isExecuting: false,
            entry: { name: 'task-2', message: 'msg', cronExpression: '* * * * *', cliToolId: 'claude', enabled: true, permission: 'default' },
          }],
          ['sched-3', {
            scheduleId: 'sched-3',
            worktreeId: 'wt-a',
            cronJob: cronJob as unknown as import('croner').Cron,
            isExecuting: false,
            entry: { name: 'task-3', message: 'msg', cronExpression: '* * * * *', cliToolId: 'claude', enabled: true, permission: 'default' },
          }],
        ]),
        initialized: true,
        isSyncing: false,
        cmateFileCache: new Map(),
      };

      const ids = getScheduleWorktreeIds();

      expect(ids).toHaveLength(2);
      expect(ids).toContain('wt-a');
      expect(ids).toContain('wt-b');
    });

    it('should return empty array when no schedules exist', () => {
      globalThis.__scheduleManagerStates = {
        timerId: null,
        schedules: new Map(),
        initialized: true,
        isSyncing: false,
        cmateFileCache: new Map(),
      };

      const ids = getScheduleWorktreeIds();

      expect(ids).toHaveLength(0);
    });

    it('should return empty array when manager state is uninitialized', () => {
      const ids = getScheduleWorktreeIds();

      expect(ids).toHaveLength(0);
    });
  });
});
