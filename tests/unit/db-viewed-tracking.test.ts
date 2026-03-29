/**
 * Unit tests for viewed tracking functionality (Issue #31)
 * Tests for last_viewed_at column and lastAssistantMessageAt retrieval
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getWorktrees,
  getWorktreeById,
  upsertWorktree,
  createMessage,
  updateLastViewedAt,
  getLastAssistantMessageAt,
} from '@/lib/db';
import { runMigrations } from '@/lib/db/db-migrations';
import type { Worktree } from '@/types/models';

describe('Viewed Tracking (Issue #31)', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('last_viewed_at column (G3)', () => {
    it('should support last_viewed_at column in worktrees table', () => {
      // Verify the column exists by checking table info
      const columns = testDb
        .prepare("PRAGMA table_info(worktrees)")
        .all() as Array<{ name: string }>;

      const columnNames = columns.map(c => c.name);
      expect(columnNames).toContain('last_viewed_at');
    });

    it('should have index for chat_messages assistant queries', () => {
      const indexes = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%assistant%'")
        .all() as Array<{ name: string }>;

      expect(indexes.length).toBeGreaterThan(0);
    });
  });

  describe('updateLastViewedAt (G4 support)', () => {
    it('should update last_viewed_at timestamp', () => {
      // Create a worktree
      const worktree: Worktree = {
        id: 'test-worktree',
        name: 'test',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      };
      upsertWorktree(testDb, worktree);

      // Update last_viewed_at
      const viewedAt = new Date('2026-01-10T12:00:00Z');
      updateLastViewedAt(testDb, 'test-worktree', viewedAt);

      // Verify the update
      const result = getWorktreeById(testDb, 'test-worktree');
      expect(result?.lastViewedAt).toEqual(viewedAt);
    });

    it('should return worktree with lastViewedAt in getWorktrees', () => {
      const worktree: Worktree = {
        id: 'test-worktree',
        name: 'test',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      };
      upsertWorktree(testDb, worktree);

      const viewedAt = new Date('2026-01-10T12:00:00Z');
      updateLastViewedAt(testDb, 'test-worktree', viewedAt);

      const results = getWorktrees(testDb);
      expect(results[0].lastViewedAt).toEqual(viewedAt);
    });
  });

  describe('lastAssistantMessageAt (G5)', () => {
    it('should return null when no assistant messages exist', () => {
      const worktree: Worktree = {
        id: 'test-worktree',
        name: 'test',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      };
      upsertWorktree(testDb, worktree);

      const result = getLastAssistantMessageAt(testDb, 'test-worktree');
      expect(result).toBeNull();
    });

    it('should return the timestamp of the most recent assistant message', () => {
      const worktree: Worktree = {
        id: 'test-worktree',
        name: 'test',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      };
      upsertWorktree(testDb, worktree);

      // Create some messages
      const time1 = new Date('2026-01-10T10:00:00Z');
      const time2 = new Date('2026-01-10T11:00:00Z');
      const time3 = new Date('2026-01-10T12:00:00Z');

      createMessage(testDb, {
        worktreeId: 'test-worktree',
        role: 'user',
        content: 'Hello',
        messageType: 'normal',
        timestamp: time1,
      });

      createMessage(testDb, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Hi there!',
        messageType: 'normal',
        timestamp: time2,
      });

      createMessage(testDb, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'How can I help?',
        messageType: 'normal',
        timestamp: time3,
      });

      const result = getLastAssistantMessageAt(testDb, 'test-worktree');
      expect(result).toEqual(time3);
    });

    it('should include lastAssistantMessageAt in getWorktreeById response', () => {
      const worktree: Worktree = {
        id: 'test-worktree',
        name: 'test',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      };
      upsertWorktree(testDb, worktree);

      const assistantTime = new Date('2026-01-10T11:00:00Z');
      createMessage(testDb, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Hello!',
        messageType: 'normal',
        timestamp: assistantTime,
      });

      const result = getWorktreeById(testDb, 'test-worktree');
      expect(result?.lastAssistantMessageAt).toEqual(assistantTime);
    });

    it('should include lastAssistantMessageAt in getWorktrees response', () => {
      const worktree: Worktree = {
        id: 'test-worktree',
        name: 'test',
        path: '/path/to/test',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      };
      upsertWorktree(testDb, worktree);

      const assistantTime = new Date('2026-01-10T11:00:00Z');
      createMessage(testDb, {
        worktreeId: 'test-worktree',
        role: 'assistant',
        content: 'Hello!',
        messageType: 'normal',
        timestamp: assistantTime,
      });

      const results = getWorktrees(testDb);
      expect(results[0].lastAssistantMessageAt).toEqual(assistantTime);
    });
  });
});
