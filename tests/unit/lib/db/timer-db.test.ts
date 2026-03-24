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
  cleanupOldTimers,
  clearTimerHistory,
  recoverStuckSendingTimers,
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

  // ==========================================================================
  // Issue #540: Pagination and cleanup
  // ==========================================================================

  describe('getTimersByWorktree with options (Issue #540)', () => {
    it('should return all timers when called without options (backward compatible)', () => {
      for (let i = 0; i < 5; i++) {
        createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: `msg-${i}`, delayMs: 300000 });
      }

      const timers = getTimersByWorktree(db, 'wt-1');
      expect(timers).toHaveLength(5);
    });

    it('should return up to limit+1 items for hasMore detection', () => {
      for (let i = 0; i < 5; i++) {
        createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: `msg-${i}`, delayMs: 300000 });
      }

      // limit=3, DB fetches limit+1=4 for hasMore detection
      const timers = getTimersByWorktree(db, 'wt-1', { limit: 3 });
      expect(timers).toHaveLength(4); // limit+1 returned
    });

    it('should return limit+1 items when more exist (for hasMore detection)', () => {
      for (let i = 0; i < 5; i++) {
        createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: `msg-${i}`, delayMs: 300000 });
      }

      // limit=3, DB fetches limit+1=4, returns all 4 for hasMore detection
      const timers = getTimersByWorktree(db, 'wt-1', { limit: 3 });
      // The function returns up to limit+1 for caller to detect hasMore
      // Based on design: "LIMIT limit+1 for hasMore detection"
      // The caller (API route) will slice to limit and set hasMore
      expect(timers.length).toBeLessThanOrEqual(4);
    });

    it('should filter by before cursor', () => {
      const t1 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'first', delayMs: 300000 });
      // Ensure different created_at by manipulating directly
      const now = Date.now();
      db.prepare(`UPDATE timer_messages SET created_at = ? WHERE id = ?`).run(now - 2000, t1.id);
      const t2 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'second', delayMs: 300000 });
      db.prepare(`UPDATE timer_messages SET created_at = ? WHERE id = ?`).run(now - 1000, t2.id);
      const t3 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'third', delayMs: 300000 });
      db.prepare(`UPDATE timer_messages SET created_at = ? WHERE id = ?`).run(now, t3.id);

      // before = now - 500 should return t1 and t2 (created_at < now - 500)
      const timers = getTimersByWorktree(db, 'wt-1', { before: now - 500 });
      expect(timers).toHaveLength(2);
      expect(timers[0].message).toBe('second'); // DESC order
      expect(timers[1].message).toBe('first');
    });

    it('should combine before and limit options', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        const t = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: `msg-${i}`, delayMs: 300000 });
        db.prepare(`UPDATE timer_messages SET created_at = ? WHERE id = ?`).run(now - (5 - i) * 1000, t.id);
      }

      // before = now, limit = 2 should return at most 3 (limit+1) items
      const timers = getTimersByWorktree(db, 'wt-1', { before: now, limit: 2 });
      expect(timers.length).toBeLessThanOrEqual(3);
    });
  });

  describe('cleanupOldTimers (Issue #540)', () => {
    function insertTimerWithAge(worktreeId: string, status: string, daysAgo: number): string {
      const t = createTimer(db, { worktreeId, cliToolId: 'claude', message: `timer-${daysAgo}d`, delayMs: 300000 });
      const createdAt = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
      db.prepare(`UPDATE timer_messages SET status = ?, created_at = ? WHERE id = ?`).run(status, createdAt, t.id);
      return t.id;
    }

    it('should delete non-pending timers older than retentionDays', () => {
      insertTimerWithAge('wt-1', 'sent', 31);
      insertTimerWithAge('wt-1', 'failed', 35);
      insertTimerWithAge('wt-1', 'cancelled', 40);
      insertTimerWithAge('wt-1', 'sent', 10); // recent, should NOT be deleted

      const deleted = cleanupOldTimers(db, 30);
      expect(deleted).toBe(3);

      const remaining = getTimersByWorktree(db, 'wt-1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe('sent');
    });

    it('should NOT delete pending timers regardless of age', () => {
      insertTimerWithAge('wt-1', 'pending', 60);

      const deleted = cleanupOldTimers(db, 30);
      expect(deleted).toBe(0);

      const remaining = getTimersByWorktree(db, 'wt-1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe('pending');
    });

    it('should NOT delete sending timers', () => {
      insertTimerWithAge('wt-1', 'sending', 60);

      const deleted = cleanupOldTimers(db, 30);
      expect(deleted).toBe(0);
    });

    it('should handle boundary: timer slightly newer than retentionDays should NOT be deleted', () => {
      // Use a fixed timestamp to avoid Date.now() drift between insert and cleanup
      const now = Date.now();
      const t = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'boundary', delayMs: 300000 });
      // Set created_at to exactly cutoff + 1ms (should NOT be deleted)
      const cutoff = now - 30 * 24 * 60 * 60 * 1000;
      db.prepare(`UPDATE timer_messages SET status = ?, created_at = ? WHERE id = ?`).run('sent', cutoff + 1, t.id);

      const deleted = cleanupOldTimers(db, 30);
      expect(deleted).toBe(0);
    });

    it('should delete timer older than retentionDays cutoff', () => {
      const now = Date.now();
      const t = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'old', delayMs: 300000 });
      // Set created_at to cutoff - 1ms (should be deleted)
      const cutoff = now - 30 * 24 * 60 * 60 * 1000;
      db.prepare(`UPDATE timer_messages SET status = ?, created_at = ? WHERE id = ?`).run('sent', cutoff - 1, t.id);

      const deleted = cleanupOldTimers(db, 30);
      expect(deleted).toBe(1);
    });

    it('should return 0 when no timers to clean', () => {
      const deleted = cleanupOldTimers(db, 30);
      expect(deleted).toBe(0);
    });
  });

  describe('clearTimerHistory (Issue #540)', () => {
    it('should delete all non-pending timers for a worktree', () => {
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      const t2 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'B', delayMs: 300000 });
      updateTimerStatus(db, t2.id, 'sent', Date.now());
      const t3 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'C', delayMs: 300000 });
      updateTimerStatus(db, t3.id, 'failed');
      const t4 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'D', delayMs: 300000 });
      cancelTimer(db, t4.id);

      const deleted = clearTimerHistory(db, 'wt-1');
      expect(deleted).toBe(3); // sent, failed, cancelled

      const remaining = getTimersByWorktree(db, 'wt-1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].status).toBe('pending');
    });

    it('should NOT affect other worktrees', () => {
      const t1 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      updateTimerStatus(db, t1.id, 'sent', Date.now());
      const t2 = createTimer(db, { worktreeId: 'wt-2', cliToolId: 'claude', message: 'B', delayMs: 300000 });
      updateTimerStatus(db, t2.id, 'sent', Date.now());

      clearTimerHistory(db, 'wt-1');

      const wt2Timers = getTimersByWorktree(db, 'wt-2');
      expect(wt2Timers).toHaveLength(1);
    });

    it('should NOT delete pending timers', () => {
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'pending', delayMs: 300000 });

      const deleted = clearTimerHistory(db, 'wt-1');
      expect(deleted).toBe(0);
    });

    it('should return 0 when no history to clear', () => {
      const deleted = clearTimerHistory(db, 'wt-1');
      expect(deleted).toBe(0);
    });
  });

  describe('recoverStuckSendingTimers (Issue #540)', () => {
    it('should change sending timers to failed', () => {
      const t1 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'A', delayMs: 300000 });
      updateTimerStatus(db, t1.id, 'sending');
      const t2 = createTimer(db, { worktreeId: 'wt-2', cliToolId: 'claude', message: 'B', delayMs: 300000 });
      updateTimerStatus(db, t2.id, 'sending');

      const recovered = recoverStuckSendingTimers(db);
      expect(recovered).toBe(2);

      const timer1 = getTimerById(db, t1.id);
      expect(timer1!.status).toBe('failed');
      const timer2 = getTimerById(db, t2.id);
      expect(timer2!.status).toBe('failed');
    });

    it('should NOT affect non-sending timers', () => {
      createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'pending', delayMs: 300000 });
      const t2 = createTimer(db, { worktreeId: 'wt-1', cliToolId: 'claude', message: 'sent', delayMs: 300000 });
      updateTimerStatus(db, t2.id, 'sent', Date.now());

      const recovered = recoverStuckSendingTimers(db);
      expect(recovered).toBe(0);
    });

    it('should return 0 when no stuck timers', () => {
      const recovered = recoverStuckSendingTimers(db);
      expect(recovered).toBe(0);
    });
  });
});
