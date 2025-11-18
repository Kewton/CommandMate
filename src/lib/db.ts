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
      message_type TEXT DEFAULT 'normal',
      prompt_data TEXT,

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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_type
    ON chat_messages(message_type, worktree_id);
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
 * Optionally filter by repository path
 */
export function getWorktrees(
  db: Database.Database,
  repositoryPath?: string
): Worktree[] {
  let query = `
    SELECT id, name, path, repository_path, repository_name, memo,
           last_user_message, last_user_message_at, last_message_summary, updated_at
    FROM worktrees
  `;

  const params: any[] = [];

  if (repositoryPath) {
    query += ` WHERE repository_path = ?`;
    params.push(repositoryPath);
  }

  query += ` ORDER BY updated_at DESC NULLS LAST`;

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Array<{
    id: string;
    name: string;
    path: string;
    repository_path: string | null;
    repository_name: string | null;
    memo: string | null;
    last_user_message: string | null;
    last_user_message_at: number | null;
    last_message_summary: string | null;
    updated_at: number | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    path: row.path,
    repositoryPath: row.repository_path || '',
    repositoryName: row.repository_name || '',
    memo: row.memo || undefined,
    lastUserMessage: row.last_user_message || undefined,
    lastUserMessageAt: row.last_user_message_at ? new Date(row.last_user_message_at) : undefined,
    lastMessageSummary: row.last_message_summary || undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
  }));
}

/**
 * Get list of unique repositories from worktrees
 */
export function getRepositories(db: Database.Database): Array<{
  path: string;
  name: string;
  worktreeCount: number;
}> {
  const stmt = db.prepare(`
    SELECT
      repository_path as path,
      repository_name as name,
      COUNT(*) as worktree_count
    FROM worktrees
    WHERE repository_path IS NOT NULL
    GROUP BY repository_path, repository_name
    ORDER BY repository_name ASC
  `);

  const rows = stmt.all() as Array<{
    path: string;
    name: string;
    worktree_count: number;
  }>;

  return rows.map((row) => ({
    path: row.path,
    name: row.name,
    worktreeCount: row.worktree_count,
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
    SELECT id, name, path, repository_path, repository_name, memo,
           last_user_message, last_user_message_at, last_message_summary, updated_at
    FROM worktrees
    WHERE id = ?
  `);

  const row = stmt.get(id) as {
    id: string;
    name: string;
    path: string;
    repository_path: string | null;
    repository_name: string | null;
    memo: string | null;
    last_user_message: string | null;
    last_user_message_at: number | null;
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
    repositoryPath: row.repository_path || '',
    repositoryName: row.repository_name || '',
    memo: row.memo || undefined,
    lastUserMessage: row.last_user_message || undefined,
    lastUserMessageAt: row.last_user_message_at ? new Date(row.last_user_message_at) : undefined,
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
    INSERT INTO worktrees (
      id, name, path, repository_path, repository_name, memo,
      last_user_message, last_user_message_at, last_message_summary, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      repository_path = excluded.repository_path,
      repository_name = excluded.repository_name,
      memo = excluded.memo,
      last_user_message = excluded.last_user_message,
      last_user_message_at = excluded.last_user_message_at,
      last_message_summary = excluded.last_message_summary,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    worktree.id,
    worktree.name,
    worktree.path,
    worktree.repositoryPath || null,
    worktree.repositoryName || null,
    worktree.memo || null,
    worktree.lastUserMessage || null,
    worktree.lastUserMessageAt?.getTime() || null,
    worktree.lastMessageSummary || null,
    worktree.updatedAt?.getTime() || null
  );
}

/**
 * Update worktree memo
 */
export function updateWorktreeMemo(
  db: Database.Database,
  worktreeId: string,
  memo: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET memo = ?
    WHERE id = ?
  `);

  stmt.run(memo || null, worktreeId);
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
    (id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    message.worktreeId,
    message.role,
    message.content,
    message.summary || null,
    message.timestamp.getTime(),
    message.logFileName || null,
    message.requestId || null,
    message.messageType || 'normal',
    message.promptData ? JSON.stringify(message.promptData) : null
  );

  // Update worktree's updated_at timestamp
  updateWorktreeTimestamp(db, message.worktreeId, message.timestamp);

  // If this is a user message, update last_user_message
  if (message.role === 'user') {
    updateLastUserMessage(db, message.worktreeId, message.content, message.timestamp);
  }

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
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data
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
    message_type: string | null;
    prompt_data: string | null;
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
    messageType: (row.message_type as any) || 'normal',
    promptData: row.prompt_data ? JSON.parse(row.prompt_data) : undefined,
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
 * Delete session state for a worktree
 * Called when a session is killed or reset
 */
export function deleteSessionState(
  db: Database.Database,
  worktreeId: string
): void {
  const stmt = db.prepare(`
    DELETE FROM session_states
    WHERE worktree_id = ?
  `);

  stmt.run(worktreeId);
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
 * Update worktree's last user message
 */
export function updateLastUserMessage(
  db: Database.Database,
  worktreeId: string,
  message: string,
  timestamp: Date
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET last_user_message = ?,
        last_user_message_at = ?
    WHERE id = ?
  `);

  // Truncate message to 200 characters
  const truncatedMessage = message.substring(0, 200);
  stmt.run(truncatedMessage, timestamp.getTime(), worktreeId);
}

/**
 * Get message by ID
 */
export function getMessageById(
  db: Database.Database,
  messageId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data
    FROM chat_messages
    WHERE id = ?
  `);

  const row = stmt.get(messageId) as {
    id: string;
    worktree_id: string;
    role: string;
    content: string;
    summary: string | null;
    timestamp: number;
    log_file_name: string | null;
    request_id: string | null;
    message_type: string | null;
    prompt_data: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    worktreeId: row.worktree_id,
    role: row.role as 'user' | 'claude',
    content: row.content,
    summary: row.summary || undefined,
    timestamp: new Date(row.timestamp),
    logFileName: row.log_file_name || undefined,
    requestId: row.request_id || undefined,
    messageType: (row.message_type as any) || 'normal',
    promptData: row.prompt_data ? JSON.parse(row.prompt_data) : undefined,
  };
}

/**
 * Update prompt data for a message
 */
export function updatePromptData(
  db: Database.Database,
  messageId: string,
  promptData: any
): void {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET prompt_data = ?
    WHERE id = ?
  `);

  stmt.run(JSON.stringify(promptData), messageId);
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
