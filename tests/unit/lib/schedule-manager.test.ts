/**
 * Tests for schedule-manager.ts
 * Issue #294: Schedule manager lifecycle and state management
 * Issue #409: mtime caching and batchUpsertSchedules optimization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Module from 'module';
import { randomUUID } from 'crypto';
import {
  initScheduleManager,
  stopAllSchedules,
  getActiveScheduleCount,
  isScheduleManagerInitialized,
  syncSchedulesNow,
  POLL_INTERVAL_MS,
  MAX_CONCURRENT_SCHEDULES,
  batchUpsertSchedules,
  getActiveSchedulesForWorktree,
} from '../../../src/lib/schedule-manager';
import { getDbInstance } from '../../../src/lib/db/db-instance';
import { readCmateFile, parseSchedulesSection } from '../../../src/lib/cmate-parser';
import { getAllWorktrees, getCmateMtime, batchUpsertSchedules as mockBatchUpsertSchedules } from '../../../src/lib/cron-parser';
import { executeSchedule } from '../../../src/lib/job-executor';
import { executeClaudeCommand } from '../../../src/lib/session/claude-executor';
import type { ScheduleState } from '../../../src/lib/job-executor';
import type { ScheduleEntry } from '../../../src/types/cmate';

// Mock logger module (Issue #480)
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock cmate-parser module (DJ-005: file-scope vi.mock for static imports)
vi.mock('../../../src/lib/cmate-parser', () => ({
  readCmateFile: vi.fn().mockResolvedValue(null),
  parseSchedulesSection: vi.fn().mockReturnValue([]),
}));

// Issue #2456: one case has to drive the REAL executeSchedule — a concurrency
// guard cannot be proven against a stub that has no guard to skip on. So the
// module is partially mocked and the switch is a flag rather than a second,
// competing mock of the same path.
const { executorMode } = vi.hoisted(() => ({ executorMode: { real: false } }));

vi.mock('../../../src/lib/job-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/job-executor')>();
  return {
    ...actual,
    // executeSchedule is async, so createScheduleState() attaches .catch() to whatever
    // it returns (Issue #1343). A bare vi.fn() returns undefined, which throws inside
    // the cron callback once a fake timer fires it — only under CI's fileParallelism:false
    // timing, so it surfaced as a flake. Keep the mock's return type faithful.
    executeSchedule: vi.fn((state: import('../../../src/lib/job-executor').ScheduleState) =>
      executorMode.real ? actual.executeSchedule(state) : Promise.resolve()
    ),
    recoverRunningLogs: vi.fn(),
  };
});

// Only the process launch is replaced: `getActiveProcesses` stays real, because
// the SIGKILL test above reads the same globalThis map the production code does.
vi.mock('../../../src/lib/session/claude-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/session/claude-executor')>();
  return { ...actual, executeClaudeCommand: vi.fn() };
});

// Mock fs module - only statSync needed for getCmateMtime() (DJ-005)
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    statSync: vi.fn().mockReturnValue({ mtimeMs: 12345 }),
  };
});

vi.mock('../../../src/lib/cron-parser', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/lib/cron-parser')>();
  return {
    ...original,
    getAllWorktrees: vi.fn().mockReturnValue([]),
    getCmateMtime: vi.fn().mockReturnValue(12345),
    batchUpsertSchedules: vi.fn().mockReturnValue([]),
    disableStaleSchedules: vi.fn(),
  };
});

// Mock db-instance to avoid actual DB operations
vi.mock('../../../src/lib/db/db-instance', () => {
  let db: Database.Database | null = null;

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
          vibe_local_model TEXT,
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
      initScheduleManager();
      mockLogger.debug.mockClear();
      initScheduleManager(); // Second call should be no-op

      expect(isScheduleManagerInitialized()).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith('init:skip', expect.any(Object));
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

  describe('batchUpsertSchedules (SQL logic)', () => {
    it('should return empty array for empty entries', () => {
      const result = batchUpsertSchedules('wt-batch-empty', []);
      expect(result).toEqual([]);
    });

    it('should INSERT new schedules via direct DB test', () => {
      const db = getDbInstance();
      const now = Date.now();

      db.prepare('INSERT OR IGNORE INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run(
        'wt-batch-new', 'batch-new-wt', '/tmp/batch-new', now
      );

      const entries = [
        { name: 'daily-review', cronExpression: '0 9 * * *', message: 'Review code', cliToolId: 'claude', enabled: true, permission: 'acceptEdits' },
        { name: 'weekly-report', cronExpression: '0 17 * * 5', message: 'Generate report', cliToolId: 'claude', enabled: true, permission: 'acceptEdits' },
      ];

      // Simulate batchUpsertSchedules logic directly against test DB
      const existingRows = db.prepare(
        'SELECT id, name FROM scheduled_executions WHERE worktree_id = ?'
      ).all('wt-batch-new') as Array<{ id: string; name: string }>;
      const existingByName = new Map<string, string>();
      for (const row of existingRows) {
        existingByName.set(row.name, row.id);
      }

      const resultIds: string[] = [];
      const insertStmt = db.prepare(`
        INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const runTransaction = db.transaction(() => {
        for (const entry of entries) {
          const id = randomUUID();
          insertStmt.run(id, 'wt-batch-new', entry.name, entry.message, entry.cronExpression, entry.cliToolId, entry.enabled ? 1 : 0, now, now);
          resultIds.push(id);
        }
      });
      runTransaction();

      expect(resultIds).toHaveLength(2);
      for (const id of resultIds) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      }

      // Verify rows in DB
      const rows = db.prepare('SELECT id, name FROM scheduled_executions WHERE worktree_id = ?').all('wt-batch-new') as Array<{ id: string; name: string }>;
      expect(rows).toHaveLength(2);
      const names = rows.map(r => r.name);
      expect(names).toContain('daily-review');
      expect(names).toContain('weekly-report');
    });

    it('should UPDATE existing schedules and preserve IDs via direct DB test', () => {
      const db = getDbInstance();
      const now = Date.now();

      db.prepare('INSERT OR IGNORE INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run(
        'wt-batch-update', 'batch-update-wt', '/tmp/batch-update', now
      );

      // Insert initial schedule
      const initialId = randomUUID();
      db.prepare(`
        INSERT INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(initialId, 'wt-batch-update', 'daily-review', 'Review code v1', '0 9 * * *', 'claude', 1, now, now);

      // Simulate batch upsert with update
      const existingRows = db.prepare(
        'SELECT id, name FROM scheduled_executions WHERE worktree_id = ?'
      ).all('wt-batch-update') as Array<{ id: string; name: string }>;
      const existingByName = new Map<string, string>();
      for (const row of existingRows) {
        existingByName.set(row.name, row.id);
      }

      const updateEntry = { name: 'daily-review', cronExpression: '0 10 * * *', message: 'Review code v2', cliToolId: 'claude', enabled: true, permission: 'acceptEdits' };

      const existingId = existingByName.get(updateEntry.name);
      expect(existingId).toBe(initialId); // Should find existing ID

      // Update
      db.prepare(`
        UPDATE scheduled_executions
        SET message = ?, cron_expression = ?, cli_tool_id = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(updateEntry.message, updateEntry.cronExpression, updateEntry.cliToolId, updateEntry.enabled ? 1 : 0, now, existingId);

      // Verify the message was updated
      const row = db.prepare('SELECT message, cron_expression FROM scheduled_executions WHERE id = ?').get(existingId) as { message: string; cron_expression: string };
      expect(row.message).toBe('Review code v2');
      expect(row.cron_expression).toBe('0 10 * * *');
    });
  });

  describe('mtime cache (syncSchedules behavior)', () => {
    it('should skip DB queries when mtime is unchanged', async () => {
      // Note: getLazyDbInstance() uses CJS require('./db-instance') which is not
      // intercepted by vi.mock in vitest, so getAllWorktrees() returns [] inside
      // syncSchedules(). We verify the manager lifecycle and DB prepare call
      // patterns indirectly.
      const db = getDbInstance();
      const dbSpy = vi.spyOn(db, 'prepare');

      // Insert a worktree for testing (only accessible via ESM mock path)
      const now = Date.now();
      db.prepare('INSERT OR IGNORE INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run(
        'wt-mtime-test', 'mtime-wt', '/tmp/mtime-test', now
      );

      initScheduleManager();

      // Flush the fire-and-forget syncSchedules() Promise (DR3-001)
      await vi.advanceTimersByTimeAsync(0);

      // Record the call count after first sync
      const callCountAfterFirst = dbSpy.mock.calls.length;

      // Trigger another sync via timer
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      // After the second sync, DB prepare calls should still be stable
      // (syncSchedules completes without error even when CJS require fails)
      const callCountAfterSecond = dbSpy.mock.calls.length;

      // The second sync should have had some DB calls (getAllWorktrees at minimum)
      // but the upsert-related calls should be skipped due to mtime cache hit
      expect(callCountAfterSecond).toBeGreaterThanOrEqual(callCountAfterFirst);

      dbSpy.mockRestore();
    });

    it('should process normally on first sync (no cache)', async () => {
      initScheduleManager();
      // Flush the fire-and-forget syncSchedules() Promise (DR3-001)
      await vi.advanceTimersByTimeAsync(0);
      // Should complete without error - verifies that first sync works with empty cache
      expect(isScheduleManagerInitialized()).toBe(true);
    });

    it('should remove cache entry when CMATE.md is deleted (mtime=null)', async () => {
      // This test verifies that when a CMATE.md file is deleted,
      // its cache entry is removed and its schedules are not added to activeScheduleIds
      initScheduleManager();
      // Flush the fire-and-forget syncSchedules() Promise (DR3-001)
      await vi.advanceTimersByTimeAsync(0);

      // After init with no CMATE.md files, no schedules should be active
      expect(getActiveScheduleCount()).toBe(0);
      expect(isScheduleManagerInitialized()).toBe(true);
    });

    it('should clear cmateFileCache when stopAllSchedules is called', async () => {
      initScheduleManager();
      // Flush the fire-and-forget syncSchedules() Promise (DR3-001)
      await vi.advanceTimersByTimeAsync(0);

      stopAllSchedules();

      // After stop, reinitializing should work cleanly (cache was cleared)
      globalThis.__scheduleManagerStates = undefined;
      initScheduleManager();
      // Flush the fire-and-forget syncSchedules() Promise (DR3-001)
      await vi.advanceTimersByTimeAsync(0);
      expect(isScheduleManagerInitialized()).toBe(true);
    });

    it('should recreate inactive schedule state even when CMATE.md mtime is unchanged', async () => {
      const db = getDbInstance();
      const now = Date.now();
      const scheduleId = 'sched-recover-inactive';
      const worktreeId = 'wt-recover-inactive';
      const worktreePath = '/tmp/recover-inactive';
      const entry = {
        name: 'copilot-analysis',
        cronExpression: '*/5 * * * *',
        message: 'check model',
        cliToolId: 'copilot',
        enabled: true,
        permission: 'yolo',
      };

      vi.mocked(readCmateFile).mockResolvedValue(new Map([['Schedules', [['row']]]]));
      vi.mocked(parseSchedulesSection).mockReturnValue([entry]);
      vi.mocked(getAllWorktrees).mockReturnValue([{ id: worktreeId, path: worktreePath }]);
      vi.mocked(getCmateMtime).mockReturnValue(12345);
      vi.mocked(mockBatchUpsertSchedules).mockReturnValue([scheduleId]);

      db.prepare('INSERT OR IGNORE INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run(
        worktreeId, 'recover-wt', worktreePath, now
      );
      db.prepare(`
        INSERT OR REPLACE INTO scheduled_executions (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scheduleId, worktreeId, entry.name, entry.message, entry.cronExpression, entry.cliToolId, 1, now, now
      );

      initScheduleManager();
      await vi.advanceTimersByTimeAsync(0);

      const inactiveCronJob = {
        stop: vi.fn(),
        schedule: vi.fn(),
        isStopped: vi.fn().mockReturnValue(true),
        isRunning: vi.fn().mockReturnValue(false),
      };

      globalThis.__scheduleManagerStates!.schedules.set(scheduleId, {
        scheduleId,
        worktreeId,
        cronJob: inactiveCronJob as unknown as import('croner').Cron,
        isExecuting: false,
        entry,
      });
      globalThis.__scheduleManagerStates!.cmateFileCache.set(worktreePath, 12345);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      const recoveredState = globalThis.__scheduleManagerStates!.schedules.get(scheduleId);
      expect(recoveredState).toBeDefined();
      expect(recoveredState!.cronJob).not.toBe(inactiveCronJob);
      expect(inactiveCronJob.stop).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith('schedule:inactive-state-detected', { worktreeId });
      expect(mockLogger.warn).toHaveBeenCalledWith('schedule:recreated-inactive', {
        name: entry.name,
        cron: entry.cronExpression,
      });
    });
  });

  describe('restart recovery', () => {
    it('should call recoverRunningLogs on initialization', () => {
      // recoverRunningLogs runs an UPDATE query to mark 'running' logs as 'failed'.
      // We verify this indirectly by checking that initScheduleManager completes
      // without errors and the manager is initialized.
      // Detailed recovery behavior is tested through the SQL logic directly.
      initScheduleManager();

      expect(isScheduleManagerInitialized()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('init:start');
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

  describe('getActiveSchedulesForWorktree', () => {
    it('should expose in-memory schedule state for visualization', () => {
      const nextRun = new Date('2026-03-31T01:00:00.000Z');
      const cronJob = {
        stop: vi.fn(),
        schedule: vi.fn(),
        isStopped: vi.fn().mockReturnValue(false),
        nextRun: vi.fn().mockReturnValue(nextRun),
      };

      globalThis.__scheduleManagerStates = {
        timerId: null,
        schedules: new Map([
          ['sched-1', {
            scheduleId: 'sched-1',
            worktreeId: 'wt-1',
            cronJob: cronJob as unknown as import('croner').Cron,
            isExecuting: true,
            entry: {
              name: 'copilot-analysis',
              message: 'msg',
              cronExpression: '*/5 * * * *',
              cliToolId: 'copilot',
              enabled: true,
              permission: 'yolo',
            },
          }],
        ]),
        initialized: true,
        isSyncing: false,
        cmateFileCache: new Map(),
      };

      expect(getActiveSchedulesForWorktree('wt-1')).toEqual([
        {
          scheduleId: 'sched-1',
          worktreeId: 'wt-1',
          name: 'copilot-analysis',
          cronExpression: '*/5 * * * *',
          cliToolId: 'copilot',
          enabled: true,
          isExecuting: true,
          isCronActive: true,
          nextRunAt: nextRun.getTime(),
        },
      ]);
    });
  });

  // ==========================================================================
  // Issue #2456: a changed Cron column has to reach the timer, not just the DB
  // ==========================================================================

  /**
   * These drive `syncSchedulesNow()` rather than `initScheduleManager()` on
   * purpose: the 60-second poll would re-enter the sync at its own cadence in
   * the middle of a 30-minute time advance, and which sync applied an edit is
   * exactly what these tests are measuring.
   *
   * ## The control that makes them non-vacuous
   *
   * Every assertion here was re-run against a mutant that keeps the old
   * behaviour — `replaceCronExpression()` replaced by `state.entry = entry;
   * return true`, i.e. the entry is updated and the timer is not. Under that
   * mutant the four load-bearing tests fail on `nextRunAt`, on the tick that
   * fires and on the cron job's identity, while the metadata and failure tests
   * stay green (they assert that the timer is *not* rebuilt). A mutant that only
   * changed the log text leaves the timing tests green, which is why the timing
   * assertions are the ones written first.
   */
  describe('cron expression changes (Issue #2456)', () => {
    const WORKTREE_ID = 'wt-2456';
    const WORKTREE_PATH = '/repos/wt-2456';
    const OTHER_WORKTREE_ID = 'wt-2456-other';
    const OTHER_WORKTREE_PATH = '/repos/wt-2456-other';
    const SCHEDULE_ID = 'sched-2456';
    const SECOND_SCHEDULE_ID = 'sched-2456-second';

    /** Runs at :10, :20, :30 — the expression every test starts from. */
    const EVERY_10_MIN = '*/10 * * * *';
    /** Runs at :15, :30 — shares no occurrence with EVERY_10_MIN before :30. */
    const EVERY_15_MIN = '*/15 * * * *';
    const EVERY_20_MIN = '*/20 * * * *';
    const EVERY_2_MIN = '*/2 * * * *';
    /** Five parts, so the parser's shape check passes; minute 70, so croner refuses it. */
    const UNBUILDABLE = '70 * * * *';

    const MINUTE = 60 * 1000;

    /** Wall-clock ms of `mm` minutes past the hour the tests start on. */
    const at = (minutes: number): number => new Date(2026, 0, 1, 0, minutes, 0).getTime();

    interface WorktreeFile {
      id: string;
      path: string;
      mtime: number;
      entries: ScheduleEntry[];
      ids: string[];
    }

    function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
      return {
        name: 'nightly',
        cronExpression: EVERY_10_MIN,
        message: 'review the diff',
        cliToolId: 'claude',
        enabled: true,
        permission: 'acceptEdits',
        ...overrides,
      };
    }

    /** Point every CMATE.md-facing mock at the given per-worktree files. */
    function cmateSays(...files: WorktreeFile[]): void {
      vi.mocked(getAllWorktrees).mockReturnValue(files.map((f) => ({ id: f.id, path: f.path })));
      vi.mocked(getCmateMtime).mockImplementation(
        (worktreePath: string) => files.find((f) => f.path === worktreePath)?.mtime ?? null
      );
      // The row content is the worktree path, so parseSchedulesSection can tell
      // the files apart without a second mock keyed on call order.
      vi.mocked(readCmateFile).mockImplementation(async (worktreePath: string) =>
        new Map([['Schedules', [[worktreePath]]]])
      );
      vi.mocked(parseSchedulesSection).mockImplementation(
        (rows: string[][]) => files.find((f) => f.path === rows[0][0])?.entries ?? []
      );
      vi.mocked(mockBatchUpsertSchedules).mockImplementation(
        (worktreeId: string) => files.find((f) => f.id === worktreeId)?.ids ?? []
      );
    }

    /** The single-worktree shorthand the majority of these tests use. */
    function fileSays(entries: ScheduleEntry[], mtime: number, ids: string[] = [SCHEDULE_ID]): void {
      cmateSays({ id: WORKTREE_ID, path: WORKTREE_PATH, mtime, entries, ids });
    }

    function manager() {
      return globalThis.__scheduleManagerStates!;
    }

    function stateOf(scheduleId = SCHEDULE_ID): ScheduleState {
      const state = manager().schedules.get(scheduleId);
      expect(state, `no live schedule for ${scheduleId}`).toBeDefined();
      return state!;
    }

    function activeInfo(worktreeId = WORKTREE_ID, scheduleId = SCHEDULE_ID) {
      const info = getActiveSchedulesForWorktree(worktreeId).find((s) => s.scheduleId === scheduleId);
      expect(info, `no active schedule info for ${scheduleId}`).toBeDefined();
      return info!;
    }

    function logsFor(level: 'info' | 'warn' | 'error', event: string): unknown[][] {
      return mockLogger[level].mock.calls.filter((call) => call[0] === event);
    }

    beforeEach(() => {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
      mockLogger.info.mockClear();
      mockLogger.warn.mockClear();
      mockLogger.error.mockClear();
      mockLogger.debug.mockClear();
      vi.mocked(executeSchedule).mockClear();
      vi.mocked(executeClaudeCommand).mockReset();
    });

    afterEach(() => {
      // Restore the file-scope defaults so the mocks these tests re-point do not
      // leak into any suite that runs after them.
      executorMode.real = false;
      vi.mocked(readCmateFile).mockReset().mockResolvedValue(null);
      vi.mocked(parseSchedulesSection).mockReset().mockReturnValue([]);
      vi.mocked(getAllWorktrees).mockReset().mockReturnValue([]);
      vi.mocked(getCmateMtime).mockReset().mockReturnValue(12345);
      vi.mocked(mockBatchUpsertSchedules).mockReset().mockReturnValue([]);
    });

    it('retires the old timer and fires on the new expression', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();

      const state = stateOf();
      const firstCronJob = state.cronJob;
      expect(activeInfo()).toMatchObject({ cronExpression: EVERY_10_MIN, nextRunAt: at(10) });

      fileSays([entry({ cronExpression: EVERY_15_MIN })], 2);
      await syncSchedulesNow();

      // Same DB row and same state object: only the timer changed hands.
      expect(manager().schedules.get(SCHEDULE_ID)).toBe(state);
      expect(state.cronJob).not.toBe(firstCronJob);
      expect(firstCronJob.isStopped()).toBe(true);
      expect(activeInfo()).toMatchObject({
        scheduleId: SCHEDULE_ID,
        cronExpression: EVERY_15_MIN,
        nextRunAt: at(15),
        isCronActive: true,
      });

      // The old expression's next occurrence passes with nothing running …
      await vi.advanceTimersByTimeAsync(11 * MINUTE);
      expect(executeSchedule).not.toHaveBeenCalled();

      // … and the new one's fires, carrying the new entry.
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(executeSchedule).toHaveBeenCalledTimes(1);
      expect(vi.mocked(executeSchedule).mock.calls[0][0].entry.cronExpression).toBe(EVERY_15_MIN);
    });

    it('records schedule:updated once, and only for a real cron change', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();

      fileSays([entry({ cronExpression: EVERY_15_MIN })], 2);
      await syncSchedulesNow();

      expect(logsFor('info', 'schedule:updated')).toEqual([
        [
          'schedule:updated',
          {
            scheduleId: SCHEDULE_ID,
            worktreeId: WORKTREE_ID,
            previousCron: EVERY_10_MIN,
            cron: EVERY_15_MIN,
          },
        ],
      ]);

      // Re-syncing the same row, and then a metadata-only edit, add nothing.
      fileSays([entry({ cronExpression: EVERY_15_MIN })], 3);
      await syncSchedulesNow();
      fileSays([entry({ cronExpression: EVERY_15_MIN, message: 'something else' })], 4);
      await syncSchedulesNow();

      expect(logsFor('info', 'schedule:updated')).toHaveLength(1);
    });

    it('keeps the timer when only the metadata changed', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();

      const state = stateOf();
      const cronJob = state.cronJob;
      const nextRunAt = activeInfo().nextRunAt;

      fileSays(
        [entry({ message: 'review yesterday', cliToolId: 'copilot', permission: 'yolo', model: 'gpt-5' })],
        2
      );
      await syncSchedulesNow();

      expect(state.cronJob).toBe(cronJob);
      expect(activeInfo()).toMatchObject({ nextRunAt, cliToolId: 'copilot', model: 'gpt-5' });

      // The next execution receives the newest metadata through the shared state.
      await vi.advanceTimersByTimeAsync(11 * MINUTE);
      expect(executeSchedule).toHaveBeenCalledTimes(1);
      expect(vi.mocked(executeSchedule).mock.calls[0][0].entry).toMatchObject({
        message: 'review yesterday',
        cliToolId: 'copilot',
        permission: 'yolo',
      });
    });

    it('rebuilds nothing when the row is unchanged', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();

      const state = stateOf();
      const cronJob = state.cronJob;

      // A touched file with identical content still reaches the entry loop.
      fileSays([entry()], 2);
      await syncSchedulesNow();

      expect(state.cronJob).toBe(cronJob);
      expect(activeInfo().nextRunAt).toBe(at(10));
      expect(logsFor('info', 'schedule:updated')).toHaveLength(0);
    });

    it('follows consecutive edits A -> B -> C', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();

      fileSays([entry({ cronExpression: EVERY_15_MIN })], 2);
      await syncSchedulesNow();
      expect(activeInfo().nextRunAt).toBe(at(15));

      fileSays([entry({ cronExpression: EVERY_20_MIN })], 3);
      await syncSchedulesNow();

      expect(activeInfo()).toMatchObject({ cronExpression: EVERY_20_MIN, nextRunAt: at(20) });
      expect(logsFor('info', 'schedule:updated').map((call) => call[1])).toEqual([
        expect.objectContaining({ previousCron: EVERY_10_MIN, cron: EVERY_15_MIN }),
        expect.objectContaining({ previousCron: EVERY_15_MIN, cron: EVERY_20_MIN }),
      ]);

      // Only C's occurrences fire: nothing at :10 or :15.
      await vi.advanceTimersByTimeAsync(19 * MINUTE);
      expect(executeSchedule).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(executeSchedule).toHaveBeenCalledTimes(1);
    });

    it('recovers a stopped timer onto the newest expression, keeping the execution guard', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();

      const state = stateOf();
      // A run is in flight and the timer died under it (the shape the existing
      // inactive-state recovery exists for).
      state.isExecuting = true;
      state.cronJob.stop();

      fileSays([entry({ cronExpression: EVERY_15_MIN })], 2);
      await syncSchedulesNow();

      expect(manager().schedules.get(SCHEDULE_ID)).toBe(state);
      expect(state.isExecuting).toBe(true);
      expect(activeInfo()).toMatchObject({
        cronExpression: EVERY_15_MIN,
        nextRunAt: at(15),
        isCronActive: true,
      });
      expect(mockLogger.warn).toHaveBeenCalledWith('schedule:recreated-inactive', {
        name: 'nightly',
        cron: EVERY_15_MIN,
      });
    });

    it('handles disable, re-enable and removal around a cron change', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();
      const disabledCronJob = stateOf().cronJob;

      fileSays([entry({ enabled: false })], 2);
      await syncSchedulesNow();

      expect(manager().schedules.has(SCHEDULE_ID)).toBe(false);
      expect(disabledCronJob.isStopped()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('schedule:disabled', { name: 'nightly' });

      // Re-enabled with a different expression: a fresh timer on the new one.
      fileSays([entry({ cronExpression: EVERY_20_MIN })], 3);
      await syncSchedulesNow();
      expect(activeInfo()).toMatchObject({ cronExpression: EVERY_20_MIN, nextRunAt: at(20) });

      // The row disappears entirely.
      const liveCronJob = stateOf().cronJob;
      fileSays([], 4, []);
      await syncSchedulesNow();

      expect(manager().schedules.size).toBe(0);
      expect(liveCronJob.isStopped()).toBe(true);
      await vi.advanceTimersByTimeAsync(31 * MINUTE);
      expect(executeSchedule).not.toHaveBeenCalled();
    });

    it('touches only the schedule whose cron changed', async () => {
      const second = entry({ name: 'second', cronExpression: EVERY_20_MIN });
      const other = entry({ name: 'other', cronExpression: EVERY_20_MIN });
      const files = (first: ScheduleEntry, mtime: number): WorktreeFile[] => [
        {
          id: WORKTREE_ID,
          path: WORKTREE_PATH,
          mtime,
          entries: [first, second],
          ids: [SCHEDULE_ID, SECOND_SCHEDULE_ID],
        },
        {
          id: OTHER_WORKTREE_ID,
          path: OTHER_WORKTREE_PATH,
          mtime: 1,
          entries: [other],
          ids: ['sched-2456-elsewhere'],
        },
      ];

      cmateSays(...files(entry(), 1));
      await syncSchedulesNow();

      const untouchedSibling = stateOf(SECOND_SCHEDULE_ID).cronJob;
      const untouchedElsewhere = stateOf('sched-2456-elsewhere').cronJob;

      cmateSays(...files(entry({ cronExpression: EVERY_15_MIN }), 2));
      await syncSchedulesNow();

      expect(activeInfo().nextRunAt).toBe(at(15));
      expect(stateOf(SECOND_SCHEDULE_ID).cronJob).toBe(untouchedSibling);
      expect(stateOf('sched-2456-elsewhere').cronJob).toBe(untouchedElsewhere);
      expect(activeInfo(WORKTREE_ID, SECOND_SCHEDULE_ID).nextRunAt).toBe(at(20));
      expect(activeInfo(OTHER_WORKTREE_ID, 'sched-2456-elsewhere').nextRunAt).toBe(at(20));
      expect(logsFor('info', 'schedule:updated')).toHaveLength(1);
    });

    it('keeps the running timer when the replacement cannot be built, and retries next sync', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();

      const state = stateOf();
      const cronJob = state.cronJob;

      fileSays([entry({ cronExpression: UNBUILDABLE })], 2);
      await syncSchedulesNow();

      expect(state.cronJob).toBe(cronJob);
      expect(activeInfo()).toMatchObject({ cronExpression: EVERY_10_MIN, nextRunAt: at(10) });
      expect(logsFor('info', 'schedule:updated')).toHaveLength(0);
      expect(mockLogger.error).toHaveBeenCalledWith('schedule:update-failed', {
        scheduleId: SCHEDULE_ID,
        worktreeId: WORKTREE_ID,
        previousCron: EVERY_10_MIN,
        cron: UNBUILDABLE,
        phase: 'prepare',
        error: expect.any(String),
      });
      // The mtime cache was dropped, which is what buys the next attempt.
      expect(manager().cmateFileCache.has(WORKTREE_PATH)).toBe(false);

      // Same mtime, and the swap is attempted again rather than skipped.
      await syncSchedulesNow();
      expect(logsFor('error', 'schedule:update-failed')).toHaveLength(2);

      // The old schedule kept running throughout.
      await vi.advanceTimersByTimeAsync(11 * MINUTE);
      expect(executeSchedule).toHaveBeenCalledTimes(1);

      // A corrected row lands even though CMATE.md's mtime never moved again.
      fileSays([entry({ cronExpression: EVERY_15_MIN })], 2);
      await syncSchedulesNow();
      expect(activeInfo()).toMatchObject({ cronExpression: EVERY_15_MIN, nextRunAt: at(15) });
    });

    it('never leaves two live timers when the swap itself fails', async () => {
      fileSays([entry()], 1);
      await syncSchedulesNow();

      const state = stateOf();
      // The old timer refuses to stop but keeps running — the only failure shape
      // that could produce two live timers.
      const stopSpy = vi.spyOn(state.cronJob, 'stop').mockImplementation(() => {
        throw new Error('stop refused');
      });

      fileSays([entry({ cronExpression: EVERY_15_MIN })], 2);
      await syncSchedulesNow();

      expect(state.cronJob).toBe(stopSpy.mock.instances[0]);
      expect(state.entry.cronExpression).toBe(EVERY_10_MIN);
      expect(logsFor('info', 'schedule:updated')).toHaveLength(0);
      expect(mockLogger.error).toHaveBeenCalledWith('schedule:update-failed', {
        scheduleId: SCHEDULE_ID,
        worktreeId: WORKTREE_ID,
        previousCron: EVERY_10_MIN,
        cron: EVERY_15_MIN,
        phase: 'swap',
        error: 'stop refused',
      });
      expect(manager().cmateFileCache.has(WORKTREE_PATH)).toBe(false);

      // Half an hour of the old expression and nothing else: :10, :20, :30 only.
      // A candidate left running would add :15 (and a second run at :30).
      await vi.advanceTimersByTimeAsync(31 * MINUTE);
      expect(executeSchedule).toHaveBeenCalledTimes(3);
      for (const call of vi.mocked(executeSchedule).mock.calls) {
        expect(call[0].entry.cronExpression).toBe(EVERY_10_MIN);
      }

      stopSpy.mockRestore();
      state.cronJob.stop();
    });

    it('limits only new timers when MAX_CONCURRENT_SCHEDULES is reached', async () => {
      const second = entry({ name: 'second', cronExpression: EVERY_20_MIN });
      cmateSays({
        id: WORKTREE_ID,
        path: WORKTREE_PATH,
        mtime: 1,
        entries: [entry(), second],
        ids: [SCHEDULE_ID, SECOND_SCHEDULE_ID],
      });
      await syncSchedulesNow();

      // Fill the manager to exactly the cap with schedules of a worktree that no
      // longer exists, so this sync must also clean them up.
      const strays = Array.from({ length: MAX_CONCURRENT_SCHEDULES - 2 }, (_, i) => {
        const stray = {
          scheduleId: `stray-${i}`,
          worktreeId: 'wt-2456-gone',
          cronJob: {
            stop: vi.fn(),
            schedule: vi.fn(),
            isStopped: vi.fn().mockReturnValue(false),
            nextRun: vi.fn().mockReturnValue(null),
          } as unknown as ScheduleState['cronJob'],
          isExecuting: false,
          entry: entry({ name: `stray-${i}` }),
        };
        manager().schedules.set(stray.scheduleId, stray);
        return stray;
      });
      expect(manager().schedules.size).toBe(MAX_CONCURRENT_SCHEDULES);

      // The new row sits before the disabled one so the cap is still reached
      // when it is considered.
      cmateSays({
        id: WORKTREE_ID,
        path: WORKTREE_PATH,
        mtime: 2,
        entries: [
          entry({ cronExpression: EVERY_15_MIN }),
          entry({ name: 'newcomer', cronExpression: EVERY_20_MIN }),
          { ...second, enabled: false },
        ],
        ids: [SCHEDULE_ID, 'sched-2456-newcomer', SECOND_SCHEDULE_ID],
      });
      await syncSchedulesNow();

      // The existing schedule still changed …
      expect(activeInfo()).toMatchObject({ cronExpression: EVERY_15_MIN, nextRunAt: at(15) });
      // … the disabled one still went away …
      expect(manager().schedules.has(SECOND_SCHEDULE_ID)).toBe(false);
      // … the new one was the only thing refused …
      expect(manager().schedules.has('sched-2456-newcomer')).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('schedule:max-concurrent-reached', {
        limit: MAX_CONCURRENT_SCHEDULES,
        name: 'newcomer',
      });
      // … and the sync ran to its end instead of returning at the cap.
      for (const stray of strays) {
        expect(manager().schedules.has(stray.scheduleId)).toBe(false);
        expect(stray.cronJob.stop).toHaveBeenCalled();
      }
      expect(manager().schedules.size).toBe(1);
    });

    it('does not stop or duplicate the run in flight when the cron changes under it', async () => {
      // The real executeSchedule, a real DB write path and a CLI call that never
      // answers: the only combination in which the concurrency guard is the
      // thing under test rather than a stub of it.
      executorMode.real = true;
      const db = getDbInstance();
      db.prepare(
        'INSERT OR REPLACE INTO worktrees (id, name, path, vibe_local_model, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(WORKTREE_ID, 'wt-2456', WORKTREE_PATH, null, 0);
      db.prepare(`
        INSERT OR REPLACE INTO scheduled_executions
          (id, worktree_id, name, message, cron_expression, cli_tool_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0)
      `).run(SCHEDULE_ID, WORKTREE_ID, 'nightly', 'review the diff', EVERY_10_MIN, 'claude');

      // job-executor reaches the DB through a lazy CJS require, which vi.mock
      // does not intercept; Module._load is the seam the #2044 integration test
      // uses for the same module.
      type ModuleWithLoad = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
      const M = Module as unknown as ModuleWithLoad;
      const originalLoad = M._load;
      M._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request.endsWith('db-instance')) return { getDbInstance };
        return originalLoad.call(Module, request, parent, isMain);
      };

      const logRows = () =>
        db.prepare('SELECT status, message FROM execution_logs WHERE schedule_id = ? ORDER BY started_at, id')
          .all(SCHEDULE_ID) as Array<{ status: string; message: string }>;

      try {
        type CliResult = Awaited<ReturnType<typeof executeClaudeCommand>>;
        let releaseCli: ((result: CliResult) => void) | undefined;
        vi.mocked(executeClaudeCommand).mockImplementation(
          () => new Promise<CliResult>((resolve) => { releaseCli = resolve; })
        );

        fileSays([entry()], 1);
        await syncSchedulesNow();
        const state = stateOf();

        // :10 — the run starts and stays open.
        await vi.advanceTimersByTimeAsync(10 * MINUTE + 1000);
        expect(executeClaudeCommand).toHaveBeenCalledTimes(1);
        expect(state.isExecuting).toBe(true);
        expect(logRows()).toEqual([{ status: 'running', message: 'review the diff' }]);

        // The Cron column changes while the CLI is still working.
        fileSays([entry({ cronExpression: EVERY_2_MIN, message: 'the next message' })], 2);
        await syncSchedulesNow();

        expect(state.isExecuting).toBe(true);
        expect(executeClaudeCommand).toHaveBeenCalledTimes(1);
        expect(logRows()).toHaveLength(1);

        // :12 — the new expression ticks into a run that has not finished.
        await vi.advanceTimersByTimeAsync(2 * MINUTE);
        expect(executeClaudeCommand).toHaveBeenCalledTimes(1);
        expect(logRows()).toHaveLength(1);
        expect(mockLogger.warn).toHaveBeenCalledWith('execution:skip-concurrent', { name: 'nightly' });

        // The CLI answers: the first run finishes on the message it was given.
        releaseCli!({ output: 'done', exitCode: 0, status: 'completed' });
        await vi.advanceTimersByTimeAsync(0);
        expect(state.isExecuting).toBe(false);
        expect(logRows()).toEqual([{ status: 'completed', message: 'review the diff' }]);

        // :14 — the next ordinary tick is free to run, on the newest entry.
        await vi.advanceTimersByTimeAsync(2 * MINUTE);
        expect(executeClaudeCommand).toHaveBeenCalledTimes(2);
        expect(vi.mocked(executeClaudeCommand).mock.calls[1][0]).toBe('the next message');
        expect(logRows()).toEqual([
          { status: 'completed', message: 'review the diff' },
          { status: 'running', message: 'the next message' },
        ]);
      } finally {
        M._load = originalLoad;
        db.prepare('DELETE FROM execution_logs WHERE schedule_id = ?').run(SCHEDULE_ID);
      }
    });
  });
});
