/**
 * Tests for timer-db.ts
 * Issue #534: Timer message CRUD operations
 * TDD Red Phase: Tests written before implementation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createTimer,
  getTimersByWorktree,
  getTimerById,
  getPendingTimers,
  updateTimerStatus,
  cancelTimer,
  cancelTimersByWorktree,
  getPendingTimerCountByWorktree,
  type TimerMessage,
  type CreateTimerParams,
} from '@/lib/db/timer-db';

// Use in-memory SQLite for tests
let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(':memory:');

  // Create worktrees table (for FK constraint)
  testDb.exec(`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE
    );
  `);

  // Create timer_messages table (v23 migration)
  testDb.exec(`
    CREATE TABLE timer_messages (
      id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL,
      cli_tool_id TEXT NOT NULL,
      message TEXT NOT NULL,
      delay_ms INTEGER NOT NULL,
      scheduled_send_time INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      sent_at INTEGER,
      FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_timer_messages_worktree_status
      ON timer_messages(worktree_id, status);

    CREATE INDEX idx_timer_messages_status_scheduled
      ON timer_messages(status, scheduled_send_time);
  `);

  // Insert test worktrees
  testDb.exec(`
    INSERT INTO worktrees (id, name, path) VALUES ('wt-1', 'Test 1', '/path/1');
    INSERT INTO worktrees (id, name, path) VALUES ('wt-2', 'Test 2', '/path/2');
  `);

  // Enable foreign keys
  testDb.pragma('foreign_keys = ON');

  return testDb;
}

describe('timer-db', () => {
  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('createTimer', () => {
    it('should create a timer with a UUID id', () => {
      const params: CreateTimerParams = {
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        message: 'Hello',
        delayMs: 300000,
      };

      const timer = createTimer(db, params);

      expect(timer.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(timer.worktreeId).toBe('wt-1');
      expect(timer.cliToolId).toBe('claude');
      expect(timer.message).toBe('Hello');
      expect(timer.delayMs).toBe(300000);
      expect(timer.status).toBe('pending');
      expect(timer.scheduledSendTime).toBeGreaterThan(0);
      expect(timer.createdAt).toBeGreaterThan(0);
      expect(timer.sentAt).toBeNull();
    });

    it('should set scheduledSendTime = createdAt + delayMs', () => {
      const params: CreateTimerParams = {
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        message: 'Test',
        delayMs: 600000,
      };

      const timer = createTimer(db, params);

      expect(timer.scheduledSendTime).toBe(timer.createdAt + timer.delayMs);
    });
  });

  describe('getTimersByWorktree', () => {
    it('should return timers for a specific worktree', () => {
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'B', delayMs: 600000 });
      createTimer(db, { worktreeId: 'wt-2', cliToolId: 'claude', message: 'C', delayMs: 300000 });

      const timers = getTimersByWorktree(db, 'wt-1');

      expect(timers).toHaveLength(2);
      expect(timers.every((t: TimerMessage) => t.worktreeId === 'wt-1')).toBe(true);
    });

    it('should return empty array for worktree with no timers', () => {
      const timers = getTimersByWorktree(db, 'wt-1');
      expect(timers).toHaveLength(0);
    });
  });

  describe('getTimerById', () => {
    it('should return a timer by its id', () => {
      const created = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'Test', delayMs: 300000 });

      const timer = getTimerById(db, created.id);

      expect(timer).toBeDefined();
      expect(timer!.id).toBe(created.id);
      expect(timer!.message).toBe('Test');
    });

    it('should return undefined for non-existent id', () => {
      const timer = getTimerById(db, 'non-existent-id');
      expect(timer).toBeUndefined();
    });
  });

  describe('getPendingTimers', () => {
    it('should return only pending timers', () => {
      const t1 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'B', delayMs: 600000 });

      // Cancel one timer
      cancelTimer(db, t1.id);

      const pending = getPendingTimers(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('pending');
    });

    it('should return timers from all worktrees', () => {
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      createTimer(db, { worktreeId: 'wt-2', cliToolId: 'claude', message: 'B', delayMs: 300000 });

      const pending = getPendingTimers(db);
      expect(pending).toHaveLength(2);
    });
  });

  describe('updateTimerStatus', () => {
    it('should update status to sending', () => {
      const timer = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'Test', delayMs: 300000 });

      updateTimerStatus(db, timer.id, 'sending');

      const updated = getTimerById(db, timer.id);
      expect(updated!.status).toBe('sending');
    });

    it('should update status to sent with sentAt timestamp', () => {
      const timer = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'Test', delayMs: 300000 });
      const now = Date.now();

      updateTimerStatus(db, timer.id, 'sent', now);

      const updated = getTimerById(db, timer.id);
      expect(updated!.status).toBe('sent');
      expect(updated!.sentAt).toBe(now);
    });

    it('should update status to failed', () => {
      const timer = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'Test', delayMs: 300000 });

      updateTimerStatus(db, timer.id, 'failed');

      const updated = getTimerById(db, timer.id);
      expect(updated!.status).toBe('failed');
    });
  });

  describe('cancelTimer', () => {
    it('should cancel a pending timer and return true', () => {
      const timer = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'Test', delayMs: 300000 });

      const result = cancelTimer(db, timer.id);

      expect(result).toBe(true);
      const updated = getTimerById(db, timer.id);
      expect(updated!.status).toBe('cancelled');
    });

    it('should return false for non-existent timer', () => {
      const result = cancelTimer(db, 'non-existent');
      expect(result).toBe(false);
    });

    it('should return false for already cancelled timer', () => {
      const timer = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'Test', delayMs: 300000 });
      cancelTimer(db, timer.id);

      const result = cancelTimer(db, timer.id);
      expect(result).toBe(false);
    });
  });

  describe('cancelTimersByWorktree', () => {
    it('should cancel all pending timers for a worktree', () => {
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'B', delayMs: 600000 });
      createTimer(db, { worktreeId: 'wt-2', cliToolId: 'claude', message: 'C', delayMs: 300000 });

      const count = cancelTimersByWorktree(db, 'wt-1');

      expect(count).toBe(2);

      // wt-2 timer should be unaffected
      const wt2Timers = getTimersByWorktree(db, 'wt-2');
      expect(wt2Timers[0].status).toBe('pending');
    });

    it('should return 0 when no pending timers exist', () => {
      const count = cancelTimersByWorktree(db, 'wt-1');
      expect(count).toBe(0);
    });
  });

  describe('getPendingTimerCountByWorktree', () => {
    it('should return count of pending timers for a worktree', () => {
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'B', delayMs: 600000 });

      const count = getPendingTimerCountByWorktree(db, 'wt-1');
      expect(count).toBe(2);
    });

    it('should not count cancelled timers', () => {
      const timer = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      cancelTimer(db, timer.id);

      const count = getPendingTimerCountByWorktree(db, 'wt-1');
      expect(count).toBe(0);
    });
  });
});
