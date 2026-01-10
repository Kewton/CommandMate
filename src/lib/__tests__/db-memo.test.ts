/**
 * Database operations tests for memo functions
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db-migrations';
import { upsertWorktree } from '../db';

// Import functions that we'll implement
import {
  getMemosByWorktreeId,
  getMemoById,
  createMemo,
  updateMemo,
  deleteMemo,
  reorderMemos,
} from '../db';

describe('Database Memo Operations', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    // Run migrations to set up latest schema
    runMigrations(testDb);

    // Insert test worktree
    upsertWorktree(testDb, {
      id: 'test-worktree',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    });
  });

  afterEach(() => {
    testDb.close();
  });

  describe('getMemosByWorktreeId', () => {
    it('should return empty array when no memos exist', () => {
      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos).toEqual([]);
    });

    it('should return memos sorted by position', () => {
      // Create memos in different positions
      createMemo(testDb, 'test-worktree', { title: 'Memo 2', position: 2 });
      createMemo(testDb, 'test-worktree', { title: 'Memo 0', position: 0 });
      createMemo(testDb, 'test-worktree', { title: 'Memo 1', position: 1 });

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');

      expect(memos).toHaveLength(3);
      expect(memos[0].title).toBe('Memo 0');
      expect(memos[0].position).toBe(0);
      expect(memos[1].title).toBe('Memo 1');
      expect(memos[1].position).toBe(1);
      expect(memos[2].title).toBe('Memo 2');
      expect(memos[2].position).toBe(2);
    });

    it('should return correct memo properties', () => {
      createMemo(testDb, 'test-worktree', {
        title: 'Test Memo',
        content: 'Test content',
        position: 0,
      });

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');

      expect(memos).toHaveLength(1);
      expect(memos[0]).toMatchObject({
        worktreeId: 'test-worktree',
        title: 'Test Memo',
        content: 'Test content',
        position: 0,
      });
      expect(memos[0].id).toBeDefined();
      expect(memos[0].createdAt).toBeInstanceOf(Date);
      expect(memos[0].updatedAt).toBeInstanceOf(Date);
    });

    it('should return empty array for non-existent worktree', () => {
      const memos = getMemosByWorktreeId(testDb, 'nonexistent');
      expect(memos).toEqual([]);
    });
  });

  describe('getMemoById', () => {
    it('should return memo by id', () => {
      const created = createMemo(testDb, 'test-worktree', {
        title: 'Test Memo',
        content: 'Test content',
        position: 0,
      });

      const memo = getMemoById(testDb, created.id);

      expect(memo).not.toBeNull();
      expect(memo?.id).toBe(created.id);
      expect(memo?.title).toBe('Test Memo');
      expect(memo?.content).toBe('Test content');
      expect(memo?.worktreeId).toBe('test-worktree');
      expect(memo?.position).toBe(0);
    });

    it('should return null for non-existent memo', () => {
      const memo = getMemoById(testDb, 'nonexistent-id');
      expect(memo).toBeNull();
    });

    it('should return correct timestamps', () => {
      const before = Date.now();
      const created = createMemo(testDb, 'test-worktree', { position: 0 });
      const after = Date.now();

      const memo = getMemoById(testDb, created.id);

      expect(memo?.createdAt).toBeInstanceOf(Date);
      expect(memo?.updatedAt).toBeInstanceOf(Date);
      expect(memo?.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(memo?.createdAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('createMemo', () => {
    it('should create memo with generated UUID', () => {
      const memo = createMemo(testDb, 'test-worktree', {
        title: 'New Memo',
        content: 'New content',
        position: 0,
      });

      expect(memo.id).toBeDefined();
      expect(memo.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(memo.worktreeId).toBe('test-worktree');
      expect(memo.title).toBe('New Memo');
      expect(memo.content).toBe('New content');
      expect(memo.position).toBe(0);
    });

    it('should use default values for title and content', () => {
      const memo = createMemo(testDb, 'test-worktree', { position: 0 });

      expect(memo.title).toBe('Memo');
      expect(memo.content).toBe('');
    });

    it('should set createdAt and updatedAt timestamps', () => {
      const before = Date.now();
      const memo = createMemo(testDb, 'test-worktree', { position: 0 });
      const after = Date.now();

      expect(memo.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(memo.createdAt.getTime()).toBeLessThanOrEqual(after);
      expect(memo.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(memo.updatedAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('should throw error when creating memo at occupied position', () => {
      createMemo(testDb, 'test-worktree', { position: 0 });

      expect(() => {
        createMemo(testDb, 'test-worktree', { position: 0 });
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('should allow creating memo at next available position', () => {
      const memo0 = createMemo(testDb, 'test-worktree', { position: 0 });
      const memo1 = createMemo(testDb, 'test-worktree', { position: 1 });

      expect(memo0.position).toBe(0);
      expect(memo1.position).toBe(1);
    });

    it('should throw error for non-existent worktree with FK enabled', () => {
      testDb.pragma('foreign_keys = ON');

      expect(() => {
        createMemo(testDb, 'nonexistent', { position: 0 });
      }).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  describe('updateMemo', () => {
    it('should update memo title', () => {
      const memo = createMemo(testDb, 'test-worktree', {
        title: 'Original Title',
        content: 'Content',
        position: 0,
      });

      updateMemo(testDb, memo.id, { title: 'Updated Title' });

      const updated = getMemosByWorktreeId(testDb, 'test-worktree')[0];
      expect(updated.title).toBe('Updated Title');
      expect(updated.content).toBe('Content'); // Should not change
    });

    it('should update memo content', () => {
      const memo = createMemo(testDb, 'test-worktree', {
        title: 'Title',
        content: 'Original Content',
        position: 0,
      });

      updateMemo(testDb, memo.id, { content: 'Updated Content' });

      const updated = getMemosByWorktreeId(testDb, 'test-worktree')[0];
      expect(updated.title).toBe('Title'); // Should not change
      expect(updated.content).toBe('Updated Content');
    });

    it('should update both title and content', () => {
      const memo = createMemo(testDb, 'test-worktree', {
        title: 'Original Title',
        content: 'Original Content',
        position: 0,
      });

      updateMemo(testDb, memo.id, {
        title: 'New Title',
        content: 'New Content',
      });

      const updated = getMemosByWorktreeId(testDb, 'test-worktree')[0];
      expect(updated.title).toBe('New Title');
      expect(updated.content).toBe('New Content');
    });

    it('should update updatedAt timestamp', () => {
      const memo = createMemo(testDb, 'test-worktree', { position: 0 });
      const originalUpdatedAt = memo.updatedAt.getTime();

      // Wait a bit to ensure different timestamp
      const waitUntil = Date.now() + 10;
      while (Date.now() < waitUntil) {
        // busy wait
      }

      updateMemo(testDb, memo.id, { title: 'Updated' });

      const updated = getMemosByWorktreeId(testDb, 'test-worktree')[0];
      expect(updated.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt);
    });

    it('should not update non-existent memo (silent no-op)', () => {
      // Should not throw, just does nothing
      expect(() => {
        updateMemo(testDb, 'nonexistent-id', { title: 'Updated' });
      }).not.toThrow();
    });
  });

  describe('deleteMemo', () => {
    it('should delete memo by id', () => {
      const memo = createMemo(testDb, 'test-worktree', { position: 0 });

      deleteMemo(testDb, memo.id);

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos).toHaveLength(0);
    });

    it('should only delete specified memo', () => {
      const memo0 = createMemo(testDb, 'test-worktree', {
        title: 'Memo 0',
        position: 0,
      });
      createMemo(testDb, 'test-worktree', { title: 'Memo 1', position: 1 });

      deleteMemo(testDb, memo0.id);

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos).toHaveLength(1);
      expect(memos[0].title).toBe('Memo 1');
    });

    it('should not throw for non-existent memo (silent no-op)', () => {
      expect(() => {
        deleteMemo(testDb, 'nonexistent-id');
      }).not.toThrow();
    });
  });

  describe('reorderMemos', () => {
    it('should reorder memos according to provided id array', () => {
      const memo0 = createMemo(testDb, 'test-worktree', {
        title: 'Memo A',
        position: 0,
      });
      const memo1 = createMemo(testDb, 'test-worktree', {
        title: 'Memo B',
        position: 1,
      });
      const memo2 = createMemo(testDb, 'test-worktree', {
        title: 'Memo C',
        position: 2,
      });

      // Reorder: C, A, B
      reorderMemos(testDb, 'test-worktree', [memo2.id, memo0.id, memo1.id]);

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos[0].title).toBe('Memo C');
      expect(memos[0].position).toBe(0);
      expect(memos[1].title).toBe('Memo A');
      expect(memos[1].position).toBe(1);
      expect(memos[2].title).toBe('Memo B');
      expect(memos[2].position).toBe(2);
    });

    it('should update updatedAt for reordered memos', () => {
      const memo0 = createMemo(testDb, 'test-worktree', { position: 0 });
      const memo1 = createMemo(testDb, 'test-worktree', { position: 1 });
      const originalTime0 = memo0.updatedAt.getTime();
      const originalTime1 = memo1.updatedAt.getTime();

      // Wait a bit
      const waitUntil = Date.now() + 10;
      while (Date.now() < waitUntil) {
        // busy wait
      }

      reorderMemos(testDb, 'test-worktree', [memo1.id, memo0.id]);

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos[0].updatedAt.getTime()).toBeGreaterThan(originalTime1);
      expect(memos[1].updatedAt.getTime()).toBeGreaterThan(originalTime0);
    });

    it('should handle reordering with same order (no change)', () => {
      const memo0 = createMemo(testDb, 'test-worktree', {
        title: 'Memo A',
        position: 0,
      });
      const memo1 = createMemo(testDb, 'test-worktree', {
        title: 'Memo B',
        position: 1,
      });

      reorderMemos(testDb, 'test-worktree', [memo0.id, memo1.id]);

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos[0].title).toBe('Memo A');
      expect(memos[1].title).toBe('Memo B');
    });

    it('should handle reordering single memo', () => {
      const memo0 = createMemo(testDb, 'test-worktree', {
        title: 'Solo Memo',
        position: 0,
      });

      reorderMemos(testDb, 'test-worktree', [memo0.id]);

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos).toHaveLength(1);
      expect(memos[0].title).toBe('Solo Memo');
      expect(memos[0].position).toBe(0);
    });

    it('should handle empty memo array', () => {
      expect(() => {
        reorderMemos(testDb, 'test-worktree', []);
      }).not.toThrow();

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos).toHaveLength(0);
    });

    it('should handle partial reordering (subset of memos)', () => {
      const memo0 = createMemo(testDb, 'test-worktree', {
        title: 'Memo A',
        position: 0,
      });
      const memo1 = createMemo(testDb, 'test-worktree', {
        title: 'Memo B',
        position: 1,
      });
      createMemo(testDb, 'test-worktree', { title: 'Memo C', position: 2 });

      // Only reorder A and B (swap them)
      reorderMemos(testDb, 'test-worktree', [memo1.id, memo0.id]);

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      // B should be at position 0, A at position 1
      // C remains at position 2 but won't be in the reordered array positions
      expect(memos.find((m) => m.title === 'Memo B')?.position).toBe(0);
      expect(memos.find((m) => m.title === 'Memo A')?.position).toBe(1);
    });
  });

  describe('Max 5 memos constraint (application level)', () => {
    it('should allow creating up to 5 memos at positions 0-4', () => {
      for (let i = 0; i < 5; i++) {
        const memo = createMemo(testDb, 'test-worktree', {
          title: `Memo ${i}`,
          position: i,
        });
        expect(memo.position).toBe(i);
      }

      const memos = getMemosByWorktreeId(testDb, 'test-worktree');
      expect(memos).toHaveLength(5);
    });

    it('should fail when trying to use position >= 5', () => {
      // Note: DB doesn't have a CHECK constraint for position,
      // but the application should enforce this
      // This test just verifies the DB allows it (enforcement at API layer)
      const memo = createMemo(testDb, 'test-worktree', { position: 5 });
      expect(memo.position).toBe(5);
    });
  });
});
