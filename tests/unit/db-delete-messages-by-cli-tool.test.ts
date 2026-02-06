/**
 * Unit tests for deleteMessagesByCliTool function
 * Issue #4: T4.2 - Delete messages by CLI tool (MF3-001)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import {
  deleteMessagesByCliTool,
  createMessage,
  getMessages,
  upsertWorktree,
} from '@/lib/db';
import type { Worktree } from '@/types/models';

describe('deleteMessagesByCliTool (T4.2 - MF3-001)', () => {
  let db: Database.Database;
  const testWorktreeId = 'test-worktree-1';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    // Create test worktree
    const worktree: Worktree = {
      id: testWorktreeId,
      name: 'Test Worktree',
      path: '/test/path',
      repositoryPath: '/test/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(() => {
    db.close();
  });

  it('should delete messages for a specific CLI tool only', () => {
    // Create messages for different CLI tools
    createMessage(db, {
      worktreeId: testWorktreeId,
      role: 'user',
      content: 'Claude message 1',
      timestamp: new Date(),
      cliToolId: 'claude',
      messageType: 'normal',
    });
    createMessage(db, {
      worktreeId: testWorktreeId,
      role: 'assistant',
      content: 'Claude response 1',
      timestamp: new Date(),
      cliToolId: 'claude',
      messageType: 'normal',
    });
    createMessage(db, {
      worktreeId: testWorktreeId,
      role: 'user',
      content: 'Codex message 1',
      timestamp: new Date(),
      cliToolId: 'codex',
      messageType: 'normal',
    });
    createMessage(db, {
      worktreeId: testWorktreeId,
      role: 'assistant',
      content: 'Codex response 1',
      timestamp: new Date(),
      cliToolId: 'codex',
      messageType: 'normal',
    });

    // Delete only Claude messages
    const deletedCount = deleteMessagesByCliTool(db, testWorktreeId, 'claude');

    expect(deletedCount).toBe(2);

    // Verify Claude messages are deleted
    const claudeMessages = getMessages(db, testWorktreeId, undefined, 50, 'claude');
    expect(claudeMessages).toHaveLength(0);

    // Verify Codex messages still exist
    const codexMessages = getMessages(db, testWorktreeId, undefined, 50, 'codex');
    expect(codexMessages).toHaveLength(2);
  });

  it('should return 0 when no messages exist for the CLI tool', () => {
    // Create only Codex messages
    createMessage(db, {
      worktreeId: testWorktreeId,
      role: 'user',
      content: 'Codex message',
      timestamp: new Date(),
      cliToolId: 'codex',
      messageType: 'normal',
    });

    // Try to delete Claude messages (none exist)
    const deletedCount = deleteMessagesByCliTool(db, testWorktreeId, 'claude');

    expect(deletedCount).toBe(0);
  });

  it('should handle deleting from non-existent worktree', () => {
    const deletedCount = deleteMessagesByCliTool(db, 'non-existent', 'claude');
    expect(deletedCount).toBe(0);
  });

  it('should not affect messages from other worktrees', () => {
    // Create another worktree
    const worktree2: Worktree = {
      id: 'test-worktree-2',
      name: 'Test Worktree 2',
      path: '/test/path2',
      repositoryPath: '/test/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree2);

    // Create Claude messages in both worktrees
    createMessage(db, {
      worktreeId: testWorktreeId,
      role: 'user',
      content: 'Worktree 1 message',
      timestamp: new Date(),
      cliToolId: 'claude',
      messageType: 'normal',
    });
    createMessage(db, {
      worktreeId: 'test-worktree-2',
      role: 'user',
      content: 'Worktree 2 message',
      timestamp: new Date(),
      cliToolId: 'claude',
      messageType: 'normal',
    });

    // Delete messages from worktree 1 only
    deleteMessagesByCliTool(db, testWorktreeId, 'claude');

    // Verify worktree 1 messages are deleted
    const worktree1Messages = getMessages(db, testWorktreeId, undefined, 50, 'claude');
    expect(worktree1Messages).toHaveLength(0);

    // Verify worktree 2 messages still exist
    const worktree2Messages = getMessages(db, 'test-worktree-2', undefined, 50, 'claude');
    expect(worktree2Messages).toHaveLength(1);
  });
});
