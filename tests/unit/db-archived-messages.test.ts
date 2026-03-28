/**
 * Unit tests for archived message functionality
 * Issue #168: Session history retention (logical deletion)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createMessage,
  getMessages,
  getLastUserMessage,
  getLastMessage,
  getLastAssistantMessageAt,
  deleteAllMessages,
  deleteMessagesByCliTool,
  clearLastUserMessage,
  getMessageById,
  upsertWorktree,
  ACTIVE_FILTER,
} from '@/lib/db';
import type { Worktree } from '@/types/models';

describe('Archived Messages (Issue #168)', () => {
  let db: Database.Database;
  const testWorktreeId = 'test-worktree-archived';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    const worktree: Worktree = {
      id: testWorktreeId,
      name: 'Test Worktree',
      path: '/test/path/archived',
      repositoryPath: '/test/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(() => {
    db.close();
  });

  describe('ACTIVE_FILTER constant', () => {
    it('should be the correct SQL fragment', () => {
      expect(ACTIVE_FILTER).toBe('AND archived = 0');
    });
  });

  describe('createMessage', () => {
    it('should create messages with archived = false by default', () => {
      const msg = createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'test message',
        timestamp: new Date(),
        messageType: 'normal',
      });

      expect(msg.archived).toBe(false);
    });

    it('should persist archived = 0 in database', () => {
      const msg = createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'test',
        timestamp: new Date(),
        messageType: 'normal',
      });

      const row = db.prepare('SELECT archived FROM chat_messages WHERE id = ?').get(msg.id) as { archived: number };
      expect(row.archived).toBe(0);
    });
  });

  describe('deleteAllMessages (logical deletion)', () => {
    it('should archive messages instead of deleting them', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'msg1',
        timestamp: new Date(),
        messageType: 'normal',
      });
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'assistant',
        content: 'response1',
        timestamp: new Date(),
        messageType: 'normal',
      });

      const archivedCount = deleteAllMessages(db, testWorktreeId);

      expect(archivedCount).toBe(2);

      // Messages still exist in DB
      const totalCount = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE worktree_id = ?').get(testWorktreeId) as { count: number };
      expect(totalCount.count).toBe(2);

      // But are archived
      const archivedRows = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE worktree_id = ? AND archived = 1').get(testWorktreeId) as { count: number };
      expect(archivedRows.count).toBe(2);
    });

    it('should return number of archived messages', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'msg1',
        timestamp: new Date(),
        messageType: 'normal',
      });

      const count = deleteAllMessages(db, testWorktreeId);
      expect(typeof count).toBe('number');
      expect(count).toBe(1);
    });

    it('should not re-archive already archived messages', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'first session msg',
        timestamp: new Date(),
        messageType: 'normal',
      });

      deleteAllMessages(db, testWorktreeId);

      // Create new session messages
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'second session msg',
        timestamp: new Date(),
        messageType: 'normal',
      });

      // Archive again - should only archive the new message
      const count = deleteAllMessages(db, testWorktreeId);
      expect(count).toBe(1);
    });
  });

  describe('deleteMessagesByCliTool (logical deletion)', () => {
    it('should archive only messages for specified CLI tool', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'claude msg',
        timestamp: new Date(),
        messageType: 'normal',
        cliToolId: 'claude',
      });
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'codex msg',
        timestamp: new Date(),
        messageType: 'normal',
        cliToolId: 'codex',
      });

      const count = deleteMessagesByCliTool(db, testWorktreeId, 'claude');
      expect(count).toBe(1);

      // Claude messages are archived
      const claudeMsgs = getMessages(db, testWorktreeId, { cliToolId: 'claude' });
      expect(claudeMsgs).toHaveLength(0);

      // Codex messages are still active
      const codexMsgs = getMessages(db, testWorktreeId, { cliToolId: 'codex' });
      expect(codexMsgs).toHaveLength(1);
    });
  });

  describe('getMessages with includeArchived', () => {
    it('should exclude archived messages by default', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'active msg',
        timestamp: new Date(),
        messageType: 'normal',
      });

      deleteAllMessages(db, testWorktreeId);

      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'new msg',
        timestamp: new Date(),
        messageType: 'normal',
      });

      const messages = getMessages(db, testWorktreeId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('new msg');
    });

    it('should include archived messages when includeArchived is true', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'old msg',
        timestamp: new Date('2025-01-01T10:00:00Z'),
        messageType: 'normal',
      });

      deleteAllMessages(db, testWorktreeId);

      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'new msg',
        timestamp: new Date('2025-01-01T11:00:00Z'),
        messageType: 'normal',
      });

      const messages = getMessages(db, testWorktreeId, { includeArchived: true });
      expect(messages).toHaveLength(2);
      // archived flag should be set correctly
      const archivedMsg = messages.find(m => m.content === 'old msg');
      const activeMsg = messages.find(m => m.content === 'new msg');
      expect(archivedMsg?.archived).toBe(true);
      expect(activeMsg?.archived).toBe(false);
    });
  });

  describe('getLastUserMessage with archived filter', () => {
    it('should not return archived user messages', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'old user msg',
        timestamp: new Date(),
        messageType: 'normal',
      });

      deleteAllMessages(db, testWorktreeId);

      const lastMsg = getLastUserMessage(db, testWorktreeId);
      expect(lastMsg).toBeNull();
    });
  });

  describe('getLastMessage with archived filter', () => {
    it('should not return archived messages', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'assistant',
        content: 'old response',
        timestamp: new Date(),
        messageType: 'normal',
      });

      deleteAllMessages(db, testWorktreeId);

      const lastMsg = getLastMessage(db, testWorktreeId);
      expect(lastMsg).toBeNull();
    });
  });

  describe('getLastAssistantMessageAt with archived filter', () => {
    it('should not return archived assistant message timestamps', () => {
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'assistant',
        content: 'old response',
        timestamp: new Date(),
        messageType: 'normal',
      });

      deleteAllMessages(db, testWorktreeId);

      const lastAt = getLastAssistantMessageAt(db, testWorktreeId);
      expect(lastAt).toBeNull();
    });
  });

  describe('getMessageById with archived', () => {
    it('should return message with archived field', () => {
      const msg = createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'test',
        timestamp: new Date(),
        messageType: 'normal',
      });

      const retrieved = getMessageById(db, msg.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.archived).toBe(false);

      // Archive the message
      deleteAllMessages(db, testWorktreeId);

      const retrievedAfter = getMessageById(db, msg.id);
      expect(retrievedAfter).not.toBeNull();
      expect(retrievedAfter?.archived).toBe(true);
    });
  });

  describe('clearLastUserMessage', () => {
    it('should clear last_user_message and last_user_message_at', () => {
      // Set last_user_message via createMessage
      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'test message for clear',
        timestamp: new Date(),
        messageType: 'normal',
      });

      // Verify it was set
      const before = db.prepare('SELECT last_user_message, last_user_message_at FROM worktrees WHERE id = ?')
        .get(testWorktreeId) as { last_user_message: string | null; last_user_message_at: number | null };
      expect(before.last_user_message).not.toBeNull();
      expect(before.last_user_message_at).not.toBeNull();

      // Clear it
      clearLastUserMessage(db, testWorktreeId);

      // Verify it was cleared
      const after = db.prepare('SELECT last_user_message, last_user_message_at FROM worktrees WHERE id = ?')
        .get(testWorktreeId) as { last_user_message: string | null; last_user_message_at: number | null };
      expect(after.last_user_message).toBeNull();
      expect(after.last_user_message_at).toBeNull();
    });
  });

  describe('ON DELETE CASCADE still works', () => {
    it('should physically delete all messages (including archived) when worktree is deleted', () => {
      db.pragma('foreign_keys = ON');

      createMessage(db, {
        worktreeId: testWorktreeId,
        role: 'user',
        content: 'msg to cascade',
        timestamp: new Date(),
        messageType: 'normal',
      });

      deleteAllMessages(db, testWorktreeId);

      // Physically delete worktree
      db.prepare('DELETE FROM worktrees WHERE id = ?').run(testWorktreeId);

      const count = db.prepare('SELECT COUNT(*) as count FROM chat_messages WHERE worktree_id = ?')
        .get(testWorktreeId) as { count: number };
      expect(count.count).toBe(0);
    });
  });
});
