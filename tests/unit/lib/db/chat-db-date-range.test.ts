/**
 * Tests for chat-db.ts getMessagesByDateRange()
 * Issue #607: Cross-worktree date range message retrieval
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getMessagesByDateRange } from '@/lib/db/chat-db';

let db: Database.Database;

function setupTestDb(): Database.Database {
  const testDb = new Database(':memory:');

  // Create worktrees table
  testDb.exec(`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      updated_at INTEGER DEFAULT 0,
      last_user_message TEXT,
      last_user_message_at INTEGER
    );
  `);

  // Create chat_messages table
  testDb.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      timestamp INTEGER NOT NULL,
      log_file_name TEXT,
      request_id TEXT,
      message_type TEXT DEFAULT 'normal',
      prompt_data TEXT,
      cli_tool_id TEXT DEFAULT 'claude',
      archived INTEGER DEFAULT 0,
      FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_chat_messages_timestamp ON chat_messages(timestamp);
  `);

  // Insert test worktrees
  testDb.exec(`
    INSERT INTO worktrees (id, name, path) VALUES ('wt-1', 'Test 1', '/path/1');
    INSERT INTO worktrees (id, name, path) VALUES ('wt-2', 'Test 2', '/path/2');
  `);

  return testDb;
}

function insertMessage(
  testDb: Database.Database,
  id: string,
  worktreeId: string,
  role: string,
  content: string,
  timestamp: number,
  archived: number = 0
) {
  testDb.prepare(`
    INSERT INTO chat_messages (id, worktree_id, role, content, timestamp, archived, cli_tool_id)
    VALUES (?, ?, ?, ?, ?, ?, 'claude')
  `).run(id, worktreeId, role, content, timestamp, archived);
}

describe('getMessagesByDateRange', () => {
  beforeEach(() => {
    db = setupTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('should return messages within date range', () => {
    const dayStart = new Date('2026-04-02T00:00:00').getTime();
    const dayMid = new Date('2026-04-02T12:00:00').getTime();
    const dayEnd = new Date('2026-04-02T23:59:59.999').getTime();
    const prevDay = new Date('2026-04-01T23:00:00').getTime();
    const nextDay = new Date('2026-04-03T01:00:00').getTime();

    insertMessage(db, 'msg-prev', 'wt-1', 'user', 'prev day', prevDay);
    insertMessage(db, 'msg-1', 'wt-1', 'user', 'morning msg', dayStart);
    insertMessage(db, 'msg-2', 'wt-2', 'assistant', 'afternoon msg', dayMid);
    insertMessage(db, 'msg-next', 'wt-1', 'user', 'next day', nextDay);

    const result = getMessagesByDateRange(db, {
      after: new Date('2026-04-02T00:00:00'),
      before: new Date('2026-04-02T23:59:59.999'),
    });

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('msg-1');
    expect(result[1].id).toBe('msg-2');
  });

  it('should exclude archived messages by default', () => {
    const ts = new Date('2026-04-02T12:00:00').getTime();

    insertMessage(db, 'msg-active', 'wt-1', 'user', 'active', ts);
    insertMessage(db, 'msg-archived', 'wt-1', 'user', 'archived', ts + 1000, 1);

    const result = getMessagesByDateRange(db, {
      after: new Date('2026-04-02T00:00:00'),
      before: new Date('2026-04-02T23:59:59.999'),
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('msg-active');
  });

  it('should include archived messages when includeArchived is true', () => {
    const ts = new Date('2026-04-02T12:00:00').getTime();

    insertMessage(db, 'msg-active', 'wt-1', 'user', 'active', ts);
    insertMessage(db, 'msg-archived', 'wt-1', 'user', 'archived', ts + 1000, 1);

    const result = getMessagesByDateRange(db, {
      after: new Date('2026-04-02T00:00:00'),
      before: new Date('2026-04-02T23:59:59.999'),
      includeArchived: true,
    });

    expect(result).toHaveLength(2);
  });

  it('should return messages from all worktrees', () => {
    const ts = new Date('2026-04-02T12:00:00').getTime();

    insertMessage(db, 'msg-wt1', 'wt-1', 'user', 'from wt-1', ts);
    insertMessage(db, 'msg-wt2', 'wt-2', 'user', 'from wt-2', ts + 1000);

    const result = getMessagesByDateRange(db, {
      after: new Date('2026-04-02T00:00:00'),
      before: new Date('2026-04-02T23:59:59.999'),
    });

    expect(result).toHaveLength(2);
    // Should be ordered by timestamp ASC
    expect(result[0].worktreeId).toBe('wt-1');
    expect(result[1].worktreeId).toBe('wt-2');
  });

  it('should return empty array when no messages in range', () => {
    const result = getMessagesByDateRange(db, {
      after: new Date('2026-04-02T00:00:00'),
      before: new Date('2026-04-02T23:59:59.999'),
    });

    expect(result).toHaveLength(0);
  });

  it('should sort results by timestamp ASC', () => {
    insertMessage(db, 'msg-3', 'wt-1', 'user', 'third', new Date('2026-04-02T15:00:00').getTime());
    insertMessage(db, 'msg-1', 'wt-2', 'user', 'first', new Date('2026-04-02T09:00:00').getTime());
    insertMessage(db, 'msg-2', 'wt-1', 'assistant', 'second', new Date('2026-04-02T12:00:00').getTime());

    const result = getMessagesByDateRange(db, {
      after: new Date('2026-04-02T00:00:00'),
      before: new Date('2026-04-02T23:59:59.999'),
    });

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('msg-1');
    expect(result[1].id).toBe('msg-2');
    expect(result[2].id).toBe('msg-3');
  });
});
