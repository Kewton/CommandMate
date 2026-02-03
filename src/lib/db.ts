/**
 * Database operations for myCodeBranchDesk
 * SQLite database client and CRUD operations
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { Worktree, ChatMessage, WorktreeSessionState, WorktreeMemo } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

type ChatMessageRow = {
  id: string;
  worktree_id: string;
  role: 'user' | 'assistant';
  content: string;
  summary: string | null;
  timestamp: number;
  log_file_name: string | null;
  request_id: string | null;
  message_type: string | null;
  prompt_data: string | null;
  cli_tool_id: string | null;
};

function mapChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    role: row.role,
    content: row.content,
    summary: row.summary || undefined,
    timestamp: new Date(row.timestamp),
    logFileName: row.log_file_name || undefined,
    requestId: row.request_id || undefined,
    messageType: (row.message_type as 'normal' | 'prompt') || 'normal',
    promptData: row.prompt_data ? JSON.parse(row.prompt_data) : undefined,
    cliToolId: (row.cli_tool_id as CLIToolType | null) ?? 'claude',
  };
}

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
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      summary TEXT,
      timestamp INTEGER NOT NULL,
      log_file_name TEXT,
      request_id TEXT,
      message_type TEXT DEFAULT 'normal',
      prompt_data TEXT,
      cli_tool_id TEXT DEFAULT 'claude',

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

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_cli_tool
    ON chat_messages(worktree_id, cli_tool_id, timestamp DESC);
  `);

  // Create session_states table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_states (
      worktree_id TEXT NOT NULL,
      cli_tool_id TEXT NOT NULL DEFAULT 'claude',
      last_captured_line INTEGER DEFAULT 0,

      PRIMARY KEY (worktree_id, cli_tool_id),
      FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
    );
  `);
}

/**
 * Get latest user message per CLI tool for multiple worktrees (batch query)
 * Optimized to avoid N+1 query problem
 */
function getLastMessagesByCliBatch(
  db: Database.Database,
  worktreeIds: string[]
): Map<string, { claude?: string; codex?: string; gemini?: string }> {
  if (worktreeIds.length === 0) {
    return new Map();
  }

  // Single query to get latest user message for each worktree/cli_tool combination
  // Uses window function to rank messages and filter to only the latest per group
  const placeholders = worktreeIds.map(() => '?').join(',');
  const stmt = db.prepare(`
    WITH ranked_messages AS (
      SELECT
        worktree_id,
        cli_tool_id,
        content,
        ROW_NUMBER() OVER (
          PARTITION BY worktree_id, cli_tool_id
          ORDER BY timestamp DESC
        ) as rn
      FROM chat_messages
      WHERE worktree_id IN (${placeholders})
        AND role = 'user'
        AND cli_tool_id IN ('claude', 'codex', 'gemini')
    )
    SELECT worktree_id, cli_tool_id, content
    FROM ranked_messages
    WHERE rn = 1
  `);

  const rows = stmt.all(...worktreeIds) as Array<{
    worktree_id: string;
    cli_tool_id: string;
    content: string;
  }>;

  // Build result map
  const result = new Map<string, { claude?: string; codex?: string; gemini?: string }>();

  // Initialize all worktree IDs with empty objects
  for (const id of worktreeIds) {
    result.set(id, {});
  }

  // Populate with query results
  for (const row of rows) {
    const existing = result.get(row.worktree_id) || {};
    existing[row.cli_tool_id as CLIToolType] = row.content.substring(0, 50);
    result.set(row.worktree_id, existing);
  }

  return result;
}


/**
 * Get all worktrees sorted by updated_at (desc)
 * Optionally filter by repository path
 * Includes lastViewedAt and lastAssistantMessageAt for unread tracking
 */
export function getWorktrees(
  db: Database.Database,
  repositoryPath?: string
): Worktree[] {
  let query = `
    SELECT
      w.id, w.name, w.path, w.repository_path, w.repository_name, w.description,
      w.last_user_message, w.last_user_message_at, w.last_message_summary,
      w.updated_at, w.favorite, w.status, w.link, w.cli_tool_id, w.last_viewed_at,
      (SELECT MAX(timestamp) FROM chat_messages
       WHERE worktree_id = w.id AND role = 'assistant') as last_assistant_message_at
    FROM worktrees w
  `;

  const params: string[] = [];

  if (repositoryPath) {
    query += ` WHERE w.repository_path = ?`;
    params.push(repositoryPath);
  }

  query += ` ORDER BY w.updated_at DESC NULLS LAST`;

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Array<{
    id: string;
    name: string;
    path: string;
    repository_path: string | null;
    repository_name: string | null;
    description: string | null;
    last_user_message: string | null;
    last_user_message_at: number | null;
    last_message_summary: string | null;
    updated_at: number | null;
    favorite: number | null;
    status: string | null;
    link: string | null;
    cli_tool_id: string | null;
    last_viewed_at: string | null;
    last_assistant_message_at: number | null;
  }>;

  // Batch fetch last messages for all worktrees (N+1 optimization)
  const worktreeIds = rows.map(row => row.id);
  const lastMessagesByCliMap = getLastMessagesByCliBatch(db, worktreeIds);

  return rows.map((row) => {
    const lastMessagesByCli = lastMessagesByCliMap.get(row.id) || {};

    return {
      id: row.id,
      name: row.name,
      path: row.path,
      repositoryPath: row.repository_path || '',
      repositoryName: row.repository_name || '',
      description: row.description || undefined,
      lastUserMessage: row.last_user_message || undefined,
      lastUserMessageAt: row.last_user_message_at ? new Date(row.last_user_message_at) : undefined,
      lastMessageSummary: row.last_message_summary || undefined,
      lastMessagesByCli,
      updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
      lastViewedAt: row.last_viewed_at ? new Date(row.last_viewed_at) : undefined,
      lastAssistantMessageAt: row.last_assistant_message_at ? new Date(row.last_assistant_message_at) : undefined,
      favorite: row.favorite === 1,
      status: (row.status as 'todo' | 'doing' | 'done' | null) || null,
      link: row.link || undefined,
      cliToolId: (row.cli_tool_id as CLIToolType | null) ?? 'claude',
    };
  });
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
 * Includes lastViewedAt and lastAssistantMessageAt for unread tracking
 */
export function getWorktreeById(
  db: Database.Database,
  id: string
): Worktree | null {
  const stmt = db.prepare(`
    SELECT
      w.id, w.name, w.path, w.repository_path, w.repository_name, w.description,
      w.last_user_message, w.last_user_message_at, w.last_message_summary,
      w.updated_at, w.favorite, w.status, w.link, w.cli_tool_id, w.last_viewed_at,
      (SELECT MAX(timestamp) FROM chat_messages
       WHERE worktree_id = w.id AND role = 'assistant') as last_assistant_message_at
    FROM worktrees w
    WHERE w.id = ?
  `);

  const row = stmt.get(id) as {
    id: string;
    name: string;
    path: string;
    repository_path: string | null;
    repository_name: string | null;
    description: string | null;
    last_user_message: string | null;
    last_user_message_at: number | null;
    last_message_summary: string | null;
    updated_at: number | null;
    favorite: number | null;
    status: string | null;
    link: string | null;
    cli_tool_id: string | null;
    last_viewed_at: string | null;
    last_assistant_message_at: number | null;
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
    description: row.description || undefined,
    lastUserMessage: row.last_user_message || undefined,
    lastUserMessageAt: row.last_user_message_at ? new Date(row.last_user_message_at) : undefined,
    lastMessageSummary: row.last_message_summary || undefined,
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    lastViewedAt: row.last_viewed_at ? new Date(row.last_viewed_at) : undefined,
    lastAssistantMessageAt: row.last_assistant_message_at ? new Date(row.last_assistant_message_at) : undefined,
    favorite: row.favorite === 1,
    status: (row.status as 'todo' | 'doing' | 'done' | null) || null,
    link: row.link || undefined,
    cliToolId: (row.cli_tool_id as CLIToolType | null) ?? 'claude',
  };
}

/**
 * Insert or update worktree
 */
export function upsertWorktree(
  db: Database.Database,
  worktree: Worktree
): void {
  // First, remove any existing worktree with the same path but different ID
  // This handles cases where the ID generation scheme has changed
  db.prepare('DELETE FROM worktrees WHERE path = ? AND id != ?').run(worktree.path, worktree.id);

  const stmt = db.prepare(`
    INSERT INTO worktrees (
      id, name, path, repository_path, repository_name, description,
      last_user_message, last_user_message_at, last_message_summary, updated_at, cli_tool_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      repository_path = excluded.repository_path,
      repository_name = excluded.repository_name,
      description = COALESCE(excluded.description, worktrees.description),
      last_user_message = COALESCE(excluded.last_user_message, worktrees.last_user_message),
      last_user_message_at = COALESCE(excluded.last_user_message_at, worktrees.last_user_message_at),
      last_message_summary = COALESCE(excluded.last_message_summary, worktrees.last_message_summary),
      updated_at = COALESCE(excluded.updated_at, worktrees.updated_at),
      cli_tool_id = COALESCE(excluded.cli_tool_id, worktrees.cli_tool_id)
  `);

  stmt.run(
    worktree.id,
    worktree.name,
    worktree.path,
    worktree.repositoryPath || null,
    worktree.repositoryName || null,
    worktree.description || null,
    worktree.lastUserMessage || null,
    worktree.lastUserMessageAt?.getTime() || null,
    worktree.lastMessageSummary || null,
    worktree.updatedAt?.getTime() || null,
    worktree.cliToolId || 'claude'
  );
}

/**
 * Update worktree description
 */
export function updateWorktreeDescription(
  db: Database.Database,
  worktreeId: string,
  description: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET description = ?
    WHERE id = ?
  `);

  stmt.run(description || null, worktreeId);
}

/**
 * Update worktree link
 */
export function updateWorktreeLink(
  db: Database.Database,
  worktreeId: string,
  link: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET link = ?
    WHERE id = ?
  `);

  stmt.run(link || null, worktreeId);
}

/**
 * Update worktree's last_viewed_at timestamp
 * Used for unread tracking (Issue #31)
 */
export function updateLastViewedAt(
  db: Database.Database,
  worktreeId: string,
  viewedAt: Date
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET last_viewed_at = ?
    WHERE id = ?
  `);

  stmt.run(viewedAt.toISOString(), worktreeId);
}

/**
 * Get the timestamp of the most recent assistant message for a worktree
 * Used for unread tracking (Issue #31)
 */
export function getLastAssistantMessageAt(
  db: Database.Database,
  worktreeId: string
): Date | null {
  const stmt = db.prepare(`
    SELECT MAX(timestamp) as last_assistant_message_at
    FROM chat_messages
    WHERE worktree_id = ? AND role = 'assistant'
  `);

  const row = stmt.get(worktreeId) as { last_assistant_message_at: number | null } | undefined;

  if (!row || row.last_assistant_message_at === null) {
    return null;
  }

  return new Date(row.last_assistant_message_at);
}

/**
 * Create a new chat message
 */
export function createMessage(
  db: Database.Database,
  message: Omit<ChatMessage, 'id'>
): ChatMessage {
  const id = randomUUID();

  const stmt = db.prepare(`
    INSERT INTO chat_messages
    (id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    message.promptData ? JSON.stringify(message.promptData) : null,
    message.cliToolId || 'claude'
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
 * Update the content of an existing message
 */
interface MessageUpdateOptions {
  summary?: string;
  logFileName?: string;
  requestId?: string;
}

export function updateMessageContent(
  db: Database.Database,
  messageId: string,
  content: string,
  options?: MessageUpdateOptions
): void {
  const assignments: string[] = ['content = ?'];
  const params: (string | null)[] = [content];

  if (options?.summary !== undefined) {
    assignments.push('summary = ?');
    params.push(options.summary ?? null);
  }

  if (options?.logFileName !== undefined) {
    assignments.push('log_file_name = ?');
    params.push(options.logFileName ?? null);
  }

  if (options?.requestId !== undefined) {
    assignments.push('request_id = ?');
    params.push(options.requestId ?? null);
  }

  const stmt = db.prepare(`
    UPDATE chat_messages
    SET ${assignments.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...params, messageId);
}

/**
 * Get messages for a worktree, optionally filtered by CLI tool
 */
export function getMessages(
  db: Database.Database,
  worktreeId: string,
  before?: Date,
  limit: number = 50,
  cliToolId?: CLIToolType
): ChatMessage[] {
  let query = `
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id
    FROM chat_messages
    WHERE worktree_id = ? AND (? IS NULL OR timestamp < ?)
  `;

  const params: (string | number | null)[] = [worktreeId, before?.getTime() || null, before?.getTime() || null];

  // Add CLI tool filter if specified
  if (cliToolId) {
    query += ` AND cli_tool_id = ?`;
    params.push(cliToolId);
  }

  query += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as ChatMessageRow[];

  return rows.map(mapChatMessage);
}

/**
 * Fetch the most recent user-authored message for a worktree.
 */
export function getLastUserMessage(
  db: Database.Database,
  worktreeId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id
    FROM chat_messages
    WHERE worktree_id = ? AND role = 'user'
    ORDER BY timestamp DESC
    LIMIT 1
  `);

  const row = stmt.get(worktreeId) as ChatMessageRow | undefined;

  return row ? mapChatMessage(row) : null;
}

/**
 * Fetch the most recent message for a worktree (any role).
 * Used to determine if waiting for Claude's response.
 */
export function getLastMessage(
  db: Database.Database,
  worktreeId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id
    FROM chat_messages
    WHERE worktree_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `);

  const row = stmt.get(worktreeId) as ChatMessageRow | undefined;

  return row ? mapChatMessage(row) : null;
}

/**
 * Delete all messages for a worktree
 * Used when killing a session to clear message history
 * Note: Log files are preserved for historical reference
 */
export function deleteAllMessages(
  db: Database.Database,
  worktreeId: string
): void {
  const stmt = db.prepare(`
    DELETE FROM chat_messages
    WHERE worktree_id = ?
  `);

  stmt.run(worktreeId);
  console.log(`[deleteAllMessages] Deleted all messages for worktree: ${worktreeId}`);
}

/**
 * Get session state for a worktree
 */
export function getSessionState(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType = 'claude'
): WorktreeSessionState | null {
  const stmt = db.prepare(`
    SELECT worktree_id, cli_tool_id, last_captured_line, in_progress_message_id
    FROM session_states
    WHERE worktree_id = ? AND cli_tool_id = ?
  `);

  const row = stmt.get(worktreeId, cliToolId) as {
    worktree_id: string;
    cli_tool_id: string;
    last_captured_line: number;
    in_progress_message_id: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    worktreeId: row.worktree_id,
    cliToolId: row.cli_tool_id as CLIToolType,
    lastCapturedLine: row.last_captured_line,
    inProgressMessageId: row.in_progress_message_id || null,
  };
}

/**
 * Update session state for a worktree
 */
export function updateSessionState(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  lastCapturedLine: number
): void {
  const stmt = db.prepare(`
    INSERT INTO session_states (worktree_id, cli_tool_id, last_captured_line)
    VALUES (?, ?, ?)
    ON CONFLICT(worktree_id, cli_tool_id) DO UPDATE SET
      last_captured_line = excluded.last_captured_line
  `);

  stmt.run(worktreeId, cliToolId, lastCapturedLine);
}

/**
 * Set the in-progress message ID for a session
 */
export function setInProgressMessageId(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  messageId: string | null
): void {
  const stmt = db.prepare(`
    INSERT INTO session_states (worktree_id, cli_tool_id, last_captured_line, in_progress_message_id)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(worktree_id, cli_tool_id) DO UPDATE SET
      in_progress_message_id = excluded.in_progress_message_id
  `);

  stmt.run(worktreeId, cliToolId, messageId);
}

/**
 * Clear the in-progress message ID for a session
 */
export function clearInProgressMessageId(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType
): void {
  setInProgressMessageId(db, worktreeId, cliToolId, null);
}

/**
 * Delete session state for a worktree
 * Called when a session is killed or reset
 */
export function deleteSessionState(
  db: Database.Database,
  worktreeId: string,
  cliToolId?: CLIToolType
): void {
  if (cliToolId) {
    const stmt = db.prepare(`
      DELETE FROM session_states
      WHERE worktree_id = ? AND cli_tool_id = ?
    `);
    stmt.run(worktreeId, cliToolId);
  } else {
    const stmt = db.prepare(`
      DELETE FROM session_states
      WHERE worktree_id = ?
    `);
    stmt.run(worktreeId);
  }
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
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id
    FROM chat_messages
    WHERE id = ?
  `);

  const row = stmt.get(messageId) as ChatMessageRow | undefined;

  if (!row) {
    return null;
  }

  return mapChatMessage(row);
}

/**
 * Update prompt data for a message
 */
export function updatePromptData(
  db: Database.Database,
  messageId: string,
  promptData: Record<string, unknown>
): void {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET prompt_data = ?
    WHERE id = ?
  `);

  stmt.run(JSON.stringify(promptData), messageId);
}

/**
 * Mark all pending prompts as answered for a worktree/CLI tool
 * This is called when we detect Claude has started processing (new response detected)
 * which means any pending prompts must have been answered via terminal
 */
export function markPendingPromptsAsAnswered(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType
): number {
  // Find all pending prompt messages for this worktree/CLI tool
  const selectStmt = db.prepare(`
    SELECT id, prompt_data
    FROM chat_messages
    WHERE worktree_id = ?
      AND cli_tool_id = ?
      AND message_type = 'prompt'
      AND json_extract(prompt_data, '$.status') = 'pending'
    ORDER BY timestamp DESC
  `);

  const rows = selectStmt.all(worktreeId, cliToolId) as { id: string; prompt_data: string }[];

  if (rows.length === 0) {
    return 0;
  }

  // Update each pending prompt to answered
  const updateStmt = db.prepare(`
    UPDATE chat_messages
    SET prompt_data = ?
    WHERE id = ?
  `);

  let updatedCount = 0;
  for (const row of rows) {
    try {
      const promptData = JSON.parse(row.prompt_data);
      promptData.status = 'answered';
      promptData.answer = '(answered via terminal)';
      promptData.answeredAt = new Date().toISOString();
      updateStmt.run(JSON.stringify(promptData), row.id);
      updatedCount++;
    } catch {
      // Skip if prompt_data is invalid JSON
    }
  }

  return updatedCount;
}

/**
 * Update favorite status for a worktree
 */
export function updateFavorite(
  db: Database.Database,
  id: string,
  favorite: boolean
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET favorite = ?
    WHERE id = ?
  `);

  stmt.run(favorite ? 1 : 0, id);
}

/**
 * Update status for a worktree
 */
export function updateStatus(
  db: Database.Database,
  id: string,
  status: 'todo' | 'doing' | 'done' | null
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET status = ?
    WHERE id = ?
  `);

  stmt.run(status, id);
}

/**
 * Update CLI tool ID for a worktree
 */
export function updateCliToolId(
  db: Database.Database,
  id: string,
  cliToolId: CLIToolType
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET cli_tool_id = ?
    WHERE id = ?
  `);

  stmt.run(cliToolId, id);
}

// ============================================================
// Memo Operations
// ============================================================

/**
 * Database row type for worktree memos
 */
type WorktreeMemoRow = {
  id: string;
  worktree_id: string;
  title: string;
  content: string;
  position: number;
  created_at: number;
  updated_at: number;
};

/**
 * Map database row to WorktreeMemo model
 */
function mapMemoRow(row: WorktreeMemoRow): WorktreeMemo {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    title: row.title,
    content: row.content,
    position: row.position,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Get all memos for a worktree, sorted by position
 */
export function getMemosByWorktreeId(
  db: Database.Database,
  worktreeId: string
): WorktreeMemo[] {
  const stmt = db.prepare(`
    SELECT id, worktree_id, title, content, position, created_at, updated_at
    FROM worktree_memos
    WHERE worktree_id = ?
    ORDER BY position ASC
  `);

  const rows = stmt.all(worktreeId) as WorktreeMemoRow[];
  return rows.map(mapMemoRow);
}

/**
 * Get a memo by ID
 *
 * @param db - Database instance
 * @param memoId - ID of the memo
 * @returns Memo or null if not found
 */
export function getMemoById(
  db: Database.Database,
  memoId: string
): WorktreeMemo | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, title, content, position, created_at, updated_at
    FROM worktree_memos
    WHERE id = ?
  `);

  const row = stmt.get(memoId) as WorktreeMemoRow | undefined;
  return row ? mapMemoRow(row) : null;
}

/**
 * Create a new memo for a worktree
 *
 * @param db - Database instance
 * @param worktreeId - ID of the worktree
 * @param options - Memo options (title, content, position)
 * @returns Created memo
 */
export function createMemo(
  db: Database.Database,
  worktreeId: string,
  options: {
    title?: string;
    content?: string;
    position: number;
  }
): WorktreeMemo {
  const id = randomUUID();
  const now = Date.now();
  const title = options.title ?? 'Memo';
  const content = options.content ?? '';

  const stmt = db.prepare(`
    INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, worktreeId, title, content, options.position, now, now);

  return {
    id,
    worktreeId,
    title,
    content,
    position: options.position,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

/**
 * Update an existing memo
 *
 * @param db - Database instance
 * @param memoId - ID of the memo to update
 * @param updates - Fields to update (title and/or content)
 */
export function updateMemo(
  db: Database.Database,
  memoId: string,
  updates: {
    title?: string;
    content?: string;
  }
): void {
  const now = Date.now();
  const assignments: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [now];

  if (updates.title !== undefined) {
    assignments.push('title = ?');
    params.push(updates.title);
  }

  if (updates.content !== undefined) {
    assignments.push('content = ?');
    params.push(updates.content);
  }

  params.push(memoId);

  const stmt = db.prepare(`
    UPDATE worktree_memos
    SET ${assignments.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...params);
}

/**
 * Delete a memo by ID
 *
 * @param db - Database instance
 * @param memoId - ID of the memo to delete
 */
export function deleteMemo(
  db: Database.Database,
  memoId: string
): void {
  const stmt = db.prepare(`
    DELETE FROM worktree_memos
    WHERE id = ?
  `);

  stmt.run(memoId);
}

/**
 * Reorder memos for a worktree
 *
 * Uses a two-step approach to handle UNIQUE constraint on (worktree_id, position):
 * 1. Set all positions to negative values (temporary)
 * 2. Set new positions from the provided order
 *
 * @param db - Database instance
 * @param worktreeId - ID of the worktree
 * @param memoIds - Array of memo IDs in the desired order
 */
export function reorderMemos(
  db: Database.Database,
  worktreeId: string,
  memoIds: string[]
): void {
  if (memoIds.length === 0) {
    return;
  }

  const now = Date.now();

  db.transaction(() => {
    // Step 1: Set all positions to negative values (to avoid UNIQUE constraint violations)
    const resetStmt = db.prepare(`
      UPDATE worktree_memos
      SET position = -1 - position
      WHERE id = ?
    `);

    for (const memoId of memoIds) {
      resetStmt.run(memoId);
    }

    // Step 2: Set new positions based on array order
    const updateStmt = db.prepare(`
      UPDATE worktree_memos
      SET position = ?, updated_at = ?
      WHERE id = ?
    `);

    memoIds.forEach((memoId, index) => {
      updateStmt.run(index, now, memoId);
    });
  })();
}

// ============================================================
// Initial Branch Operations (Issue #111)
// ============================================================

/**
 * Save initial branch for a worktree (at session start)
 * Issue #111: Branch visualization feature
 *
 * @param db - Database instance
 * @param worktreeId - ID of the worktree
 * @param branchName - Branch name to save
 *
 * @remarks
 * Uses prepared statement for SQL injection prevention
 * Called from send/route.ts after startSession()
 */
export function saveInitialBranch(
  db: Database.Database,
  worktreeId: string,
  branchName: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET initial_branch = ?
    WHERE id = ?
  `);

  stmt.run(branchName, worktreeId);
}

/**
 * Get initial branch for a worktree
 * Issue #111: Branch visualization feature
 *
 * @param db - Database instance
 * @param worktreeId - ID of the worktree
 * @returns Branch name or null if not recorded
 */
export function getInitialBranch(
  db: Database.Database,
  worktreeId: string
): string | null {
  const stmt = db.prepare(`
    SELECT initial_branch
    FROM worktrees
    WHERE id = ?
  `);

  const row = stmt.get(worktreeId) as { initial_branch: string | null } | undefined;

  return row?.initial_branch ?? null;
}

// ============================================================
// Repository Delete Operations (Issue #69)
// ============================================================

/**
 * Get all worktree IDs for a given repository path
 *
 * @param db - Database instance
 * @param repositoryPath - Path of the repository
 * @returns Array of worktree IDs
 */
export function getWorktreeIdsByRepository(
  db: Database.Database,
  repositoryPath: string
): string[] {
  const stmt = db.prepare(`
    SELECT id FROM worktrees WHERE repository_path = ?
  `);

  const rows = stmt.all(repositoryPath) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

/**
 * Delete all worktrees for a given repository path
 * Related data (chat_messages, session_states, worktree_memos) will be
 * automatically deleted via CASCADE foreign key constraints.
 *
 * @param db - Database instance
 * @param repositoryPath - Path of the repository to delete
 * @returns Object containing the count of deleted worktrees
 */
export function deleteRepositoryWorktrees(
  db: Database.Database,
  repositoryPath: string
): { deletedCount: number } {
  const stmt = db.prepare(`
    DELETE FROM worktrees WHERE repository_path = ?
  `);

  const result = stmt.run(repositoryPath);
  return { deletedCount: result.changes };
}

/**
 * Delete worktrees by their IDs
 * Related data (chat_messages, session_states, worktree_memos) will be
 * automatically deleted via CASCADE foreign key constraints.
 *
 * @param db - Database instance
 * @param worktreeIds - Array of worktree IDs to delete
 * @returns Object containing the count of deleted worktrees
 */
export function deleteWorktreesByIds(
  db: Database.Database,
  worktreeIds: string[]
): { deletedCount: number } {
  if (worktreeIds.length === 0) {
    return { deletedCount: 0 };
  }

  const placeholders = worktreeIds.map(() => '?').join(',');
  const stmt = db.prepare(`
    DELETE FROM worktrees WHERE id IN (${placeholders})
  `);

  const result = stmt.run(...worktreeIds);
  return { deletedCount: result.changes };
}
