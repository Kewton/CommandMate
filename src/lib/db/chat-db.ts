/**
 * Chat message database operations
 * CRUD operations for chat_messages table
 *
 * Issue #479: Extracted from db.ts for single-responsibility separation
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { ChatMessage } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('chat-db');

/** Active (non-archived) message filter clause. Single point of change for archived filtering. */
export const ACTIVE_FILTER = 'AND archived = 0';

/** Options for getMessages query */
export interface GetMessagesOptions {
  before?: Date;
  limit?: number;
  cliToolId?: CLIToolType;
  includeArchived?: boolean;
}

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
  archived: number;
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
    archived: row.archived === 1,
  };
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
    WHERE worktree_id = ? AND role = 'assistant' ${ACTIVE_FILTER}
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
  message: Omit<ChatMessage, 'id' | 'archived'>
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

  return { id, ...message, archived: false };
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
  options: GetMessagesOptions = {}
): ChatMessage[] {
  const { before, limit = 50, cliToolId, includeArchived = false } = options;

  let query = `
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, archived
    FROM chat_messages
    WHERE worktree_id = ? AND (? IS NULL OR timestamp < ?)
  `;

  const params: (string | number | null)[] = [worktreeId, before?.getTime() || null, before?.getTime() || null];

  // archived filter (default: non-archived only)
  if (!includeArchived) {
    query += ` ${ACTIVE_FILTER}`;
  }

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
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, archived
    FROM chat_messages
    WHERE worktree_id = ? AND role = 'user' ${ACTIVE_FILTER}
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
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, archived
    FROM chat_messages
    WHERE worktree_id = ? ${ACTIVE_FILTER}
    ORDER BY timestamp DESC
    LIMIT 1
  `);

  const row = stmt.get(worktreeId) as ChatMessageRow | undefined;

  return row ? mapChatMessage(row) : null;
}

/**
 * Archive all active messages for a worktree (logical deletion)
 * Used when killing a session to clear message history while retaining for future viewing.
 * Note: Log files are preserved for historical reference
 *
 * Issue #168: Changed from physical DELETE to logical UPDATE (archived=1)
 * Function name maintained for backward compatibility (DR1-003)
 *
 * @returns Number of archived messages
 */
export function deleteAllMessages(
  db: Database.Database,
  worktreeId: string
): number {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET archived = 1
    WHERE worktree_id = ? ${ACTIVE_FILTER}
  `);

  const result = stmt.run(worktreeId);
  logger.info('archived-all-messages', { worktreeId, count: result.changes });
  return result.changes;
}

/**
 * Delete a single message by its ID
 * Used to clean up orphaned user messages (e.g., when a user re-sends a message
 * after the previous one received no response).
 *
 * @param db - Database instance
 * @param messageId - ID of the message to delete
 * @returns True if a message was deleted, false otherwise
 */
export function deleteMessageById(
  db: Database.Database,
  messageId: string
): boolean {
  const stmt = db.prepare(`
    DELETE FROM chat_messages
    WHERE id = ?
  `);

  const result = stmt.run(messageId);
  return result.changes > 0;
}

/**
 * Archive messages for a specific CLI tool in a worktree (logical deletion)
 * Issue #4: T4.2 - Individual CLI tool session termination (MF3-001)
 * Issue #168: Changed from physical DELETE to logical UPDATE (archived=1)
 *
 * Used when killing only a specific CLI tool's session to archive its message history
 * while preserving messages from other CLI tools.
 * Note: Log files are preserved for historical reference
 * Function name maintained for backward compatibility (DR1-003)
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param cliTool - CLI tool ID to archive messages for
 * @returns Number of archived messages
 */
export function deleteMessagesByCliTool(
  db: Database.Database,
  worktreeId: string,
  cliTool: CLIToolType
): number {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET archived = 1
    WHERE worktree_id = ? AND cli_tool_id = ? ${ACTIVE_FILTER}
  `);

  const result = stmt.run(worktreeId, cliTool);
  logger.info('archived-messages-by-cli-tool', { worktreeId, cliTool, count: result.changes });
  return result.changes;
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
 * Clear worktree's last user message fields
 * Issue #168: Called after archiving messages to prevent stale data in sidebar
 */
export function clearLastUserMessage(
  db: Database.Database,
  worktreeId: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET last_user_message = NULL,
        last_user_message_at = NULL
    WHERE id = ?
  `);

  stmt.run(worktreeId);
}

/** Options for getMessagesByDateRange query */
export interface GetMessagesByDateRangeOptions {
  after: Date;
  before: Date;
  includeArchived?: boolean;
}

/**
 * Get messages across all worktrees within a date range.
 * Used for daily summary generation.
 *
 * Issue #607: Cross-worktree message retrieval for daily summary
 *
 * @param db - Database instance
 * @param options - Date range and filter options
 * @returns ChatMessage[] sorted by timestamp ASC
 */
export function getMessagesByDateRange(
  db: Database.Database,
  options: GetMessagesByDateRangeOptions
): ChatMessage[] {
  const { after, before, includeArchived = false } = options;

  let query = `
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, archived
    FROM chat_messages
    WHERE timestamp >= ? AND timestamp < ?
  `;

  if (!includeArchived) {
    query += ` ${ACTIVE_FILTER}`;
  }

  query += ` ORDER BY timestamp ASC`;

  const stmt = db.prepare(query);
  const rows = stmt.all(after.getTime(), before.getTime()) as ChatMessageRow[];

  return rows.map(mapChatMessage);
}

/**
 * Get message by ID
 */
export function getMessageById(
  db: Database.Database,
  messageId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, archived
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
      ${ACTIVE_FILTER}
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
