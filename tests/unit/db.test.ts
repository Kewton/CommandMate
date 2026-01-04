/**
 * Database operations unit tests
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Worktree, ChatMessage } from '@/types/models';

// Import functions that we'll implement
import {
  initDatabase,
  getWorktrees,
  getWorktreeById,
  upsertWorktree,
  createMessage,
  getMessages,
  getLastUserMessage,
  getSessionState,
  updateSessionState,
} from '@/lib/db';
import { runMigrations } from '@/lib/db-migrations';

describe('Database Operations', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    // Run migrations to set up latest schema
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('initDatabase', () => {
    it('should create all required tables', () => {
      const tables = testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('worktrees');
      expect(tableNames).toContain('chat_messages');
      expect(tableNames).toContain('session_states');
    });

    it('should create indexes for performance', () => {
      const indexes = testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);

      expect(indexNames.length).toBeGreaterThan(0);
    });
  });

  describe('Worktree Operations', () => {
    describe('upsertWorktree', () => {
      it('should insert new worktree', () => {
        const worktree: Worktree = {
          id: 'main',
          name: 'main',
          path: '/path/to/main',
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
        };

        upsertWorktree(testDb, worktree);
        const result = getWorktrees(testDb);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          id: 'main',
          name: 'main',
          path: '/path/to/main',
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
        });
      });

      it('should update existing worktree', () => {
        const worktree: Worktree = {
          id: 'main',
          name: 'main',
          path: '/path/to/main',
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
        };

        upsertWorktree(testDb, worktree);
        upsertWorktree(testDb, {
          ...worktree,
          name: 'main-updated',
          lastMessageSummary: 'Updated summary',
        });

        const result = getWorktrees(testDb);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('main-updated');
        expect(result[0].lastMessageSummary).toBe('Updated summary');
      });

      it('should maintain unique path constraint', () => {
        const worktree1: Worktree = {
          id: 'main',
          name: 'main',
          path: '/path/to/main',
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
        };

        const worktree2: Worktree = {
          id: 'feature-foo',
          name: 'feature/foo',
          path: '/path/to/main', // Same path
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
        };

        upsertWorktree(testDb, worktree1);

        expect(() => {
          upsertWorktree(testDb, worktree2);
        }).toThrow();
      });
    });

    describe('getWorktrees', () => {
      it('should return empty array when no worktrees', () => {
        const result = getWorktrees(testDb);
        expect(result).toEqual([]);
      });

      it('should return worktrees sorted by updatedAt desc', () => {
        const now = new Date();
        const earlier = new Date(now.getTime() - 1000);

        upsertWorktree(testDb, {
          id: 'main',
          name: 'main',
          path: '/path/to/main',
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
          updatedAt: earlier,
        });

        upsertWorktree(testDb, {
          id: 'feature-foo',
          name: 'feature/foo',
          path: '/path/to/feature-foo',
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
          updatedAt: now,
        });

        const result = getWorktrees(testDb);

        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('feature-foo'); // Most recent first
        expect(result[1].id).toBe('main');
      });
    });

    describe('getWorktreeById', () => {
      it('should return worktree by id', () => {
        upsertWorktree(testDb, {
          id: 'main',
          name: 'main',
          path: '/path/to/main',
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
        });

        const result = getWorktreeById(testDb, 'main');

        expect(result).toBeDefined();
        expect(result?.id).toBe('main');
      });

      it('should return null for non-existent id', () => {
        const result = getWorktreeById(testDb, 'nonexistent');
        expect(result).toBeNull();
      });
    });
  });

  describe('ChatMessage Operations', () => {
    beforeEach(() => {
      // Insert test worktree
      upsertWorktree(testDb, {
        id: 'main',
        name: 'main',
        path: '/path/to/main',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      });
    });

    describe('createMessage', () => {
      it('should create message with generated UUID', () => {
        const message = createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'Hello Claude',
          messageType: 'normal',
          timestamp: new Date(),
        });

        expect(message.id).toBeDefined();
        expect(message.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        expect(message.content).toBe('Hello Claude');
      });

      it('should fail if worktree does not exist', () => {
        expect(() => {
          createMessage(testDb, {
            worktreeId: 'nonexistent',
            role: 'user',
            content: 'Hello',
            messageType: 'normal',
            timestamp: new Date(),
          });
        }).toThrow();
      });

      it('should update worktree updatedAt timestamp', () => {
        const before = getWorktreeById(testDb, 'main');
        const beforeTime = before?.updatedAt?.getTime() || 0;

        // Wait a bit to ensure different timestamp
        const now = new Date(Date.now() + 100);

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'Test',
          messageType: 'normal',
          timestamp: now,
        });

        const after = getWorktreeById(testDb, 'main');
        const afterTime = after?.updatedAt?.getTime() || 0;

        expect(afterTime).toBeGreaterThan(beforeTime);
      });
    });

    describe('getMessages', () => {
      it('should return messages in reverse chronological order', () => {
        const time1 = new Date('2025-01-01T10:00:00Z');
        const time2 = new Date('2025-01-01T11:00:00Z');
        const time3 = new Date('2025-01-01T12:00:00Z');

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'First',
          messageType: 'normal',
          timestamp: time1,
        });

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'assistant',
          content: 'Second',
          messageType: 'normal',
          timestamp: time2,
        });

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'Third',
          messageType: 'normal',
          timestamp: time3,
        });

        const messages = getMessages(testDb, 'main');

        expect(messages).toHaveLength(3);
        expect(messages[0].content).toBe('Third'); // Most recent first
        expect(messages[1].content).toBe('Second');
        expect(messages[2].content).toBe('First');
      });

      it('should support pagination with before parameter', () => {
        const time1 = new Date('2025-01-01T10:00:00Z');
        const time2 = new Date('2025-01-01T11:00:00Z');
        const time3 = new Date('2025-01-01T12:00:00Z');

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'First',
          messageType: 'normal',
          timestamp: time1,
        });

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'Second',
          messageType: 'normal',
          timestamp: time2,
        });

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'Third',
          messageType: 'normal',
          timestamp: time3,
        });

        // Get messages before time3
        const messages = getMessages(testDb, 'main', time3);

        expect(messages).toHaveLength(2);
        expect(messages[0].content).toBe('Second');
        expect(messages[1].content).toBe('First');
      });

      it('should support limit parameter', () => {
        for (let i = 0; i < 10; i++) {
          createMessage(testDb, {
            worktreeId: 'main',
            role: 'user',
            content: `Message ${i}`,
            messageType: 'normal',
            timestamp: new Date(),
          });
        }

        const messages = getMessages(testDb, 'main', undefined, 5);

        expect(messages).toHaveLength(5);
      });

      it('should return empty array for worktree with no messages', () => {
        upsertWorktree(testDb, {
          id: 'empty',
          name: 'empty',
          path: '/path/to/empty',
          repositoryPath: '/path/to/repo',
          repositoryName: 'repo',
        });

        const messages = getMessages(testDb, 'empty');
        expect(messages).toEqual([]);
      });
    });

    describe('getLastUserMessage', () => {
      it('should return null when no user messages exist', () => {
        const lastUserMessage = getLastUserMessage(testDb, 'main');
        expect(lastUserMessage).toBeNull();
      });

      it('should return the most recent user message only', () => {
        const first = new Date('2025-01-01T10:00:00Z');
        const second = new Date('2025-01-01T11:00:00Z');

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'First user prompt',
          messageType: 'normal',
          timestamp: first,
        });

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'assistant',
          content: 'Assistant reply',
          messageType: 'normal',
          timestamp: new Date('2025-01-01T10:30:00Z'),
        });

        createMessage(testDb, {
          worktreeId: 'main',
          role: 'user',
          content: 'Second user prompt',
          messageType: 'normal',
          timestamp: second,
        });

        const lastUserMessage = getLastUserMessage(testDb, 'main');

        expect(lastUserMessage).toBeTruthy();
        expect(lastUserMessage?.content).toBe('Second user prompt');
        expect(lastUserMessage?.role).toBe('user');
      });
    });
  });

  describe('SessionState Operations', () => {
    beforeEach(() => {
      upsertWorktree(testDb, {
        id: 'main',
        name: 'main',
        path: '/path/to/main',
        repositoryPath: '/path/to/repo',
        repositoryName: 'repo',
      });
    });

    describe('getSessionState', () => {
      it('should return null for non-existent session', () => {
        const state = getSessionState(testDb, 'main');
        expect(state).toBeNull();
      });

      it('should return session state after creation', () => {
        updateSessionState(testDb, 'main', 'claude', 100);

        const state = getSessionState(testDb, 'main');

        expect(state).toBeDefined();
        expect(state?.worktreeId).toBe('main');
        expect(state?.lastCapturedLine).toBe(100);
      });
    });

    describe('updateSessionState', () => {
      it('should create new session state', () => {
        updateSessionState(testDb, 'main', 'claude', 50);

        const state = getSessionState(testDb, 'main');

        expect(state?.lastCapturedLine).toBe(50);
      });

      it('should update existing session state', () => {
        updateSessionState(testDb, 'main', 'claude', 50);
        updateSessionState(testDb, 'main', 'claude', 100);

        const state = getSessionState(testDb, 'main');

        expect(state?.lastCapturedLine).toBe(100);
      });

      it('should initialize with 0 if not specified', () => {
        updateSessionState(testDb, 'main', 'claude', 0);

        const state = getSessionState(testDb, 'main');

        expect(state?.lastCapturedLine).toBe(0);
      });
    });
  });
});
