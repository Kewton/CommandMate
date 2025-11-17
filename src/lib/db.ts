/**
 * Database operations for myCodeBranchDesk
 * SQLite database client and CRUD operations
 */

import Database from 'better-sqlite3';
import type { Worktree, ChatMessage, WorktreeSessionState } from '@/types/models';

/**
 * Initialize database schema
 */
export function initDatabase(db: Database.Database): void {
  // Create worktrees table
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      last_message_summary TEXT,
      updated_at INTEGER
    );
  `);

  // Create index for sorting by updated_at
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worktrees_updated_at
    ON worktrees(updated_at DESC);
  `);

  // Create chat_messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'claude')),
      content TEXT NOT NULL,
      summary TEXT,
      timestamp INTEGER NOT NULL,
      log_file_name TEXT,
      request_id TEXT,

      FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
    );
  `);

  // Create indexes for chat_messages
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_worktree_time
    ON chat_messages(worktree_id, timestamp DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_request_id
    ON chat_messages(request_id);
  `);

  // Create session_states table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_states (
      worktree_id TEXT PRIMARY KEY,
      last_captured_line INTEGER DEFAULT 0,

      FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
    );
  `);
}

/**
 * Get all worktrees sorted by updated_at (desc)
 */
export function getWorktrees(db: Database.Database): Worktree[] {
  const stmt = db.prepare(`
    SELECT id, name, path, last_message_summary, updated_at
    FROM worktrees
    ORDER BY updated_at DESC NULLS LAST
  `);

  const rows = stmt.all() as Array<{
    id: string;
    name: string;
    path: string;
    last_message_summary: string | null;
    updated_at: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    lastMessageSummary: row.last_message_summary || undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
  }));
}

/**
 * Get worktree by ID
 */
export function getWorktreeById(
  db: Database.Database,
  id: string
): Worktree | null {
  const stmt = db.prepare(`
    SELECT id, name, path, last_message_summary, updated_at
    FROM worktrees
    WHERE id = ?
  `);

  const row = stmt.get(id) as {
    id: string;
    name: string;
    path: string;
    last_message_summary: string | null;
    updated_at: number | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    path: row.path,
    lastMessageSummary: row.last_message_summary || undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
  };
}

/**
 * Insert or update worktree
 */
export function upsertWorktree(
  db: Database.Database,
  worktree: Worktree
): void {
  const stmt = db.prepare(`
    INSERT INTO worktrees (id, name, path, last_message_summary, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      last_message_summary = excluded.last_message_summary,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    worktree.id,
    worktree.name,
    worktree.path,
    worktree.lastMessageSummary || null,
    worktree.updatedAt?.getTime() || null
  );
}

/**
 * Create a new chat message
 */
export function createMessage(
  db: Database.Database,
  message: Omit<ChatMessage, 'id'>
): ChatMessage {
  const id = generateUUID();

  const stmt = db.prepare(`
    INSERT INTO chat_messages
    (id, worktree_id, role, content, summary, timestamp, log_file_name, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    message.worktreeId,
    message.role,
    message.content,
    message.summary || null,
    message.timestamp.getTime(),
    message.logFileName || null,
    message.requestId || null
  );

  // Update worktree's updated_at timestamp
  updateWorktreeTimestamp(db, message.worktreeId, message.timestamp);

  return { id, ...message };
}

/**
 * Get messages for a worktree
 */
export function getMessages(
  db: Database.Database,
  worktreeId: string,
  before?: Date,
  limit: number = 50
): ChatMessage[] {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id
    FROM chat_messages
    WHERE worktree_id = ? AND (? IS NULL OR timestamp < ?)
    ORDER BY timestamp ASC
    LIMIT ?
  `);

  const beforeTs = before?.getTime() || null;

  const rows = stmt.all(worktreeId, beforeTs, beforeTs, limit) as Array<{
    id: string;
    worktree_id: string;
    role: string;
    content: string;
    summary: string | null;
    timestamp: number;
    log_file_name: string | null;
    request_id: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    worktreeId: row.worktree_id,
    role: row.role as 'user' | 'claude',
    content: row.content,
    summary: row.summary || undefined,
    timestamp: new Date(row.timestamp),
    logFileName: row.log_file_name || undefined,
    requestId: row.request_id || undefined,
  }));
}

/**
 * Get session state for a worktree
 */
export function getSessionState(
  db: Database.Database,
  worktreeId: string
): WorktreeSessionState | null {
  const stmt = db.prepare(`
    SELECT worktree_id, last_captured_line
    FROM session_states
    WHERE worktree_id = ?
  `);

  const row = stmt.get(worktreeId) as {
    worktree_id: string;
    last_captured_line: number;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    worktreeId: row.worktree_id,
    lastCapturedLine: row.last_captured_line,
  };
}

/**
 * Update session state for a worktree
 */
export function updateSessionState(
  db: Database.Database,
  worktreeId: string,
  lastCapturedLine: number
): void {
  const stmt = db.prepare(`
    INSERT INTO session_states (worktree_id, last_captured_line)
    VALUES (?, ?)
    ON CONFLICT(worktree_id) DO UPDATE SET
      last_captured_line = excluded.last_captured_line
  `);

  stmt.run(worktreeId, lastCapturedLine);
}

/**
 * Update worktree's updated_at timestamp
 * @private
 */
function updateWorktreeTimestamp(
  db: Database.Database,
  worktreeId: string,
  timestamp: Date
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET updated_at = ?
    WHERE id = ?
  `);

  stmt.run(timestamp.getTime(), worktreeId);
}

/**
 * Generate UUID v4
 * @private
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
